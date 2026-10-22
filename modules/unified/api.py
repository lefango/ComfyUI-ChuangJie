"""Per-user complete presets; independent from original plugin databases."""
import asyncio
import base64
import binascii
import json
import logging
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from .core import VERSION, MODULES, parse_state, content_digest, ports, inputs, Invalid, clip_purpose
from .model.core import Conflict, cover_key, text
from .model.storage import Store as CoverStore
from .image_edit import (ImageLibrary, ImageNotFound,
                         MAX_MASK_BYTES, MAX_UPLOAD_BYTES, consume_pending_image,
                         stage_pending_image)

PREFIX = "/cj-unified-loader-test/v1"
IMAGE_EDIT_PREFIX = PREFIX + "/image-edit"
MAX_IMAGE_JSON = 12 * 1024 * 1024


class Presets:
    def __init__(self, root):
        self.root = Path(root)
        self.covers = CoverStore(self.root)
        self.path = self.root / "complete-presets.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS suites (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL COLLATE NOCASE UNIQUE, body TEXT NOT NULL)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def list(self):
        with self.connect() as db:
            return [dict({"notes": ""}, **json.loads(b), id=i, revision=r) for i, r, b in db.execute("SELECT id,revision,body FROM suites ORDER BY name COLLATE NOCASE")]

    def save(self, value):
        state = parse_state(value["state"])
        name = text(value.get("name", ""), 256)
        if not name:
            raise Invalid("请填写预设名称")
        state["name"] = name
        state["cover"] = cover_key(value.get("cover"))
        if state["cover"] and not (self.root / "covers" / state["cover"]).is_file():
            raise Invalid("封面不存在，请重新上传；当前输入已保留")
        state["preset"] = None
        key = text(value.get("id") or uuid.uuid4().hex, 128)
        expected = value.get("revision", 0)
        if type(expected) is not int or expected < 0:
            raise Invalid("预设 revision 无效")
        body = {"name": name, "notes": text(value.get("notes", ""), 32000), "cover": state["cover"], "state": state}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision FROM suites WHERE id=?", (key,)).fetchone()
            if (row[0] if row else 0) != expected:
                raise Conflict("预设已在其他窗口更新，请刷新后核对，当前输入已保留")
            try:
                db.execute("INSERT INTO suites(id,revision,name,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,body=excluded.body", (key, expected + 1, name, json.dumps(body, ensure_ascii=False)))
            except sqlite3.IntegrityError as exc:
                raise Conflict("同名预设已存在，请选择覆盖或更换名称") from exc
        return dict(body, id=key, revision=expected + 1)

    def edit(self, value):
        name = text(value.get("name", ""), 256)
        notes = text(value.get("notes", ""), 32000)
        if not name:
            raise Invalid("请填写预设名称")
        key, revision = text(value.get("id", ""), 128), value.get("revision")
        if type(revision) is not int or revision < 1:
            raise Invalid("预设 revision 无效")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision,body FROM suites WHERE id=?", (key,)).fetchone()
            if not row or row[0] != revision:
                raise Conflict("预设已在其他窗口更新或删除，请刷新后核对，当前输入已保留")
            body = json.loads(row[1])
            body.update(name=name, notes=notes)
            body["state"]["name"] = name
            try:
                db.execute("UPDATE suites SET revision=?,name=?,body=? WHERE id=?", (revision + 1, name, json.dumps(body, ensure_ascii=False), key))
            except sqlite3.IntegrityError as exc:
                raise Conflict("同名预设已存在，请更换名称") from exc
        return dict(body, id=key, revision=revision + 1)

    def delete(self, key, revision):
        with self.connect() as db:
            count = db.execute("DELETE FROM suites WHERE id=? AND revision=?", (key, revision)).rowcount
            if count != 1:
                raise Conflict("预设已变化，请刷新后重试")
        return {"ok": True}


def register(server, paths):
    from aiohttp import web
    # Standalone installs need the bundled Prompt Manager routes. The main
    # plugin registers its own Prompt Manager first; skip the bundled call there
    # because its register() signature is intentionally different.
    try:
        from ..prompt.api import register as register_prompt_api
    except (ImportError, ValueError):
        from .prompt.api import register as register_prompt_api
    if not any(getattr(route, "path", "").startswith("/prompt-manager/v1") for route in server.routes):
        register_prompt_api(server, paths)
    stores = {}
    image_libraries = {}

    def store(request):
        user = server.user_manager.get_request_user_id(request)
        if not isinstance(user, str) or not user or user.startswith("__") or any(x in user for x in ("/", "\\", ":", "..")):
            raise Invalid("无效用户")
        if user not in stores:
            stores[user] = Presets(Path(paths.get_user_directory()) / user / "unified-model-loader-test" / "suites")
        return stores[user]

    def image_library(request):
        user = server.user_manager.get_request_user_id(request)
        if not isinstance(user, str) or not user or user.startswith("__") or any(x in user for x in ("/", "\\", ":", "..")):
            raise Invalid("无效用户")
        if user not in image_libraries:
            image_libraries[user] = ImageLibrary(paths.get_user_directory(), user)
        return image_libraries[user]

    def guard(fn):
        async def wrapped(request):
            try:
                if request.method != "GET" and request.headers.get("Origin") and urlsplit(request.headers["Origin"]).netloc != request.host:
                    raise web.HTTPForbidden(text="仅允许同源请求")
                return await fn(request)
            except Conflict as exc:
                return web.json_response({"error": str(exc)}, status=409)
            except ImageNotFound as exc:
                return web.json_response({"error": str(exc)}, status=404)
            except (ValueError, TypeError, KeyError, RecursionError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except web.HTTPException:
                raise
            except Exception:
                logging.exception("[一体节点测试] API 失败")
                return web.json_response({"error": "操作失败，当前输入已保留，请查看后端日志"}, status=500)
        return wrapped

    async def read(request, limit):
        result = bytearray()
        async for part in request.content.iter_chunked(65536):
            result.extend(part)
            if len(result) > limit:
                raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(result))
        return bytes(result)

    async def read_part(part, limit):
        result = bytearray()
        while True:
            chunk = await part.read_chunk(65536)
            if not chunk:
                break
            result.extend(chunk)
            if len(result) > limit:
                raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(result))
        return bytes(result)

    async def read_json_object(request, limit=MAX_IMAGE_JSON):
        if request.content_type != "application/json":
            raise Invalid("请求需要 JSON")
        value = json.loads(await read(request, limit))
        if not isinstance(value, dict):
            raise Invalid("请求需要 JSON 对象")
        return value

    def decode_mask_data(value):
        if not isinstance(value, str):
            raise Invalid("遮罩数据格式无效")
        if value.startswith("data:"):
            header, sep, payload = value.partition(",")
            if not sep or header.lower() != "data:image/png;base64":
                raise Invalid("遮罩必须是 PNG 图像")
            value = payload
        if len(value) > ((MAX_MASK_BYTES + 2) // 3) * 4:
            raise Invalid("遮罩图像超过大小限制")
        try:
            data = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise Invalid("遮罩数据不是有效的 Base64") from exc
        if not data or len(data) > MAX_MASK_BYTES:
            raise Invalid("遮罩图像超过大小限制或为空")
        return data

    @server.routes.get(PREFIX + "/status")
    @guard
    async def status(request):
        return web.json_response({"version": VERSION, "modules": MODULES, "schema": 1})

    @server.routes.get(PREFIX + "/sampling-options")
    @guard
    async def sampling_options(request):
        try:
            import nodes as comfy_nodes
            sampler_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("KSampler")
            required = sampler_cls.INPUT_TYPES().get("required", {}) if sampler_cls else {}
            result = {}
            for name in ("sampler_name", "scheduler"):
                spec = required.get(name)
                options = spec[0] if isinstance(spec, (list, tuple)) and spec else ()
                result[name] = list(options) if isinstance(options, (list, tuple)) else []
            return web.json_response(result)
        except Exception as exc:
            raise Invalid("读取当前 ComfyUI 的采样选项失败") from exc

    @server.routes.get(PREFIX + "/presets")
    @guard
    async def presets(request):
        return web.json_response(await asyncio.to_thread(store(request).list))

    @server.routes.post(PREFIX + "/{op:validate|task-map|save-preset|edit-preset|delete-preset|apply-preset}")
    @guard
    async def mutate(request):
        if request.content_type != "application/json":
            raise Invalid("请求需要 JSON")
        value = json.loads(await read(request, 2 * 1024 * 1024))
        if not isinstance(value, dict):
            raise Invalid("请求需要对象")
        op = request.match_info["op"]
        if op == "task-map":
            from .runtime import task_id
            manager = text(value["manager"], 256)
            suffixes = ("model", "clip", "vae", "lora-model", "lora-clip", "triggers", "prompt",
                "empty-latent", "edit-image", "vae-encode", "vae-encode-inpaint", "ksampler",
                "vae-decode", "sample-preview", "mask-composite", "final-preview")
            return web.json_response({"tasks": [task_id(manager, suffix) for suffix in suffixes]})
        if op == "validate":
            state = parse_state(value["state"])
            return web.json_response({"state": state, "ports": ports(state), "inputs": inputs(state), "digest": content_digest(state), "clip_purpose": clip_purpose(state)})
        service = store(request)
        if op == "save-preset":
            result = await asyncio.to_thread(service.save, value)
        elif op == "edit-preset":
            result = await asyncio.to_thread(service.edit, value)
        elif op == "delete-preset":
            result = await asyncio.to_thread(service.delete, value["id"], value["revision"])
        else:
            result = next((p for p in await asyncio.to_thread(service.list) if p["id"] == value["id"]), None)
            if result is None:
                raise Invalid("预设已删除，请刷新；当前配置已保留")
        if op != "delete-preset":
            state = parse_state(result["state"])
            state["preset"] = {"id": result["id"], "revision": result["revision"], "digest": content_digest(state)}
            result = dict(result, state=state)
        return web.json_response(result)

    @server.routes.post(PREFIX + "/covers")
    @guard
    async def upload(request):
        data = await read(request, 8 * 1024 * 1024)
        return web.json_response(await asyncio.to_thread(store(request).covers.upload, data))

    @server.routes.get(PREFIX + r"/covers/{key:[a-f0-9]{64}\.png}")
    @guard
    async def cover(request):
        path = store(request).root / "covers" / cover_key(request.match_info["key"])
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable"})

    @server.routes.get(IMAGE_EDIT_PREFIX + "/library")
    @guard
    async def image_edit_library(request):
        result = await asyncio.to_thread(image_library(request).library)
        return web.json_response(result)

    @server.routes.post(IMAGE_EDIT_PREFIX + "/category")
    @guard
    async def image_edit_category(request):
        value = await read_json_object(request, 64 * 1024)
        result = await asyncio.to_thread(image_library(request).create_category, value.get("name"))
        return web.json_response(result)

    @server.routes.post(IMAGE_EDIT_PREFIX + "/folder")
    @guard
    async def image_edit_folder_create(request):
        value = await read_json_object(request, 64 * 1024)
        result = await asyncio.to_thread(
            image_library(request).create_folder,
            value.get("name"), value.get("parent_id"), value.get("notes", ""), value.get("cover_image_id"))
        return web.json_response(result)

    @server.routes.patch(IMAGE_EDIT_PREFIX + r"/folder/{id:[0-9a-f]{32}}")
    @guard
    async def image_edit_folder_update(request):
        value = await read_json_object(request, 64 * 1024)
        fields = {key: value[key] for key in ("name", "parent_id", "notes", "cover_image_id") if key in value}
        result = await asyncio.to_thread(
            image_library(request).update_folder, request.match_info["id"], **fields)
        return web.json_response(result)

    @server.routes.post(IMAGE_EDIT_PREFIX + "/upload")
    @guard
    async def image_edit_upload(request):
        if request.content_type != "multipart/form-data":
            raise Invalid("上传需要 multipart/form-data")
        reader = await request.multipart()
        fields = set()
        file_data = None
        filename = None
        category = ""
        while True:
            part = await reader.next()
            if part is None:
                break
            name = part.name
            if name not in ("file", "category", "category_id", "folder", "folder_id") or name in fields:
                raise Invalid("上传字段无效或重复")
            if name in ("category", "category_id", "folder", "folder_id") and fields.intersection(
                    {"category", "category_id", "folder", "folder_id"}):
                raise Invalid("图像文件夹字段重复")
            fields.add(name)
            if name == "file":
                if not part.filename:
                    raise Invalid("请选择图像文件")
                filename = part.filename
                file_data = await read_part(part, MAX_UPLOAD_BYTES)
            else:
                raw_category = await read_part(part, 1024)
                try:
                    category = raw_category.decode("utf-8").strip()
                except UnicodeDecodeError as exc:
                    raise Invalid("图像文件夹格式无效") from exc
        if file_data is None:
            raise Invalid("上传缺少 file 字段")
        result = await asyncio.to_thread(image_library(request).upload, file_data, filename, category)
        return web.json_response(result)

    @server.routes.post(IMAGE_EDIT_PREFIX + "/delete")
    @guard
    async def image_edit_delete(request):
        value = await read_json_object(request, 64 * 1024)
        await asyncio.to_thread(image_library(request).delete_image, value.get("id"))
        return web.json_response({"ok": True})

    @server.routes.get(IMAGE_EDIT_PREFIX + r"/image/{id:[0-9a-f]{32}}")
    @guard
    async def image_edit_image(request):
        path = await asyncio.to_thread(image_library(request).image_path, request.match_info["id"])
        return web.FileResponse(path, headers={"Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store"})

    @server.routes.get(IMAGE_EDIT_PREFIX + r"/mask/{id:[0-9a-f]{32}}")
    @guard
    async def image_edit_mask(request):
        path = await asyncio.to_thread(image_library(request).mask_path, request.match_info["id"])
        if path is None:
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store"})

    @server.routes.post(IMAGE_EDIT_PREFIX + "/mask")
    @guard
    async def image_edit_save_mask(request):
        value = await read_json_object(request)
        data = decode_mask_data(value.get("data"))
        result = await asyncio.to_thread(image_library(request).save_mask, value.get("id"), data)
        return web.json_response(result)

    @server.routes.post(IMAGE_EDIT_PREFIX + "/mask/delete")
    @guard
    async def image_edit_delete_mask(request):
        value = await read_json_object(request, 64 * 1024)
        await asyncio.to_thread(image_library(request).delete_mask, value.get("id"))
        return web.json_response({"ok": True})

    @server.routes.post(IMAGE_EDIT_PREFIX + "/prepare")
    @guard
    async def image_edit_prepare(request):
        value = await read_json_object(request, 64 * 1024)
        library = image_library(request)

        def read_pending():
            image_path = library.image_path(value.get("id"))
            mask_path = library.mask_path(value.get("id"))
            image_bytes = image_path.read_bytes()
            mask_bytes = mask_path.read_bytes() if mask_path is not None else None
            token = stage_pending_image(library.owner_id, image_bytes, mask_bytes)
            return token, mask_bytes is not None

        token, has_mask = await asyncio.to_thread(read_pending)
        return web.json_response({"token": token, "has_mask": has_mask})
