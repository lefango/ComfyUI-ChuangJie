"""Same-origin, per-user model library API. Paths are always catalog-relative."""
import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import time
from urllib.parse import urlsplit
from .catalog import Catalog
from .core import Conflict, Invalid, MAX_JSON, VERSION, cover_key, parse_state, warnings, identifier, text
from .storage import Store

PREFIX = "/cj-unified-loader-test/v1/models"


class Library:
    def __init__(self, paths, root):
        self.catalog = Catalog(paths)
        self.store = Store(root)
        self.items = []
        self.updated = 0

    def library(self, query):
        if query.get("refresh") == "1" or time.monotonic() - self.updated > 30:
            self.items = self.catalog.scan()
            self.updated = time.monotonic()
        records = self.store.all()
        result, found = [], set()
        for item in self.items:
            found.add(item["id"])
            result.append(dict(item, **{k: v for k, v in records.get(item["id"], {}).items() if k not in ("kind", "file", "id")}))
        for key, record in records.items():
            if key not in found:
                result.append(dict(record, missing=True, size=0, format=Path(record["file"]).suffix[1:].lower(), folder=""))
        categories = self.store.categories()
        q, kind, fmt, category = query.get("q", "").casefold(), query.get("kind", ""), query.get("format", ""), query.get("category", "")
        status = query.get("status", "active")
        if status not in ("active", "disabled"):
            raise Invalid("模型库筛选状态无效")
        stats = {model_kind: sum(i["kind"] == model_kind and not i.get("disabled", False) for i in result) for model_kind in ("checkpoint", "model", "clip", "vae")}
        category_counts = {name: sum(i.get("category") == name and not i.get("disabled", False) for i in result) for name in categories}
        disabled_count = sum(bool(i.get("disabled", False)) for i in result)
        def include(i):
            return bool(i.get("disabled", False)) == (status == "disabled") and (not kind or i["kind"] == kind) and (not fmt or i["format"] == fmt) and (
                not category or i.get("category") == category) and (
                not q or q in " ".join(str(i.get(k, "")) for k in ("name", "file", "notes", "architecture")).casefold())
        result = [i for i in result if include(i)]
        offset = max(0, int(query.get("offset", 0)))
        limit = min(120, max(1, int(query.get("limit", 48))))
        return {"items": result[offset:offset + limit], "total": len(result), "categories": categories, "category_counts": category_counts, "stats": stats, "disabled_count": disabled_count}

    def sync(self, value):
        state = parse_state(value)
        records = self.store.all()
        for s in state["slots"]:
            # Combined encoders have their own workflow alias; do not overwrite it
            # with the first constituent encoder's display name.
            if len(s["files"]) == 1:
                record = records.get(self.catalog.key(s["kind"], s["files"][0]))
                if record:
                    for field in ("name", "notes", "cover", "architecture"):
                        s[field] = record.get(field)
        return {"state": state, "warnings": warnings(state)}


def capabilities():
    import comfy.sd
    from .vendor import upstream_version, capabilities as gguf_capabilities
    return {"version": VERSION, "dynamic_outputs": True, "gguf_installed": importlib.util.find_spec("gguf") is not None,
            "clip_types": [v.name.lower() for v in comfy.sd.CLIPType], "upstream": upstream_version(), "gguf_capabilities": gguf_capabilities(),
            "gguf_note": "支持适配器所列架构和量化类型；任意语言模型 GGUF 不等于兼容文本编码器。GGUF 与 scaled-FP8 编码器混合不受支持。"}


def register(server, paths):
    from aiohttp import web
    users = {}

    def library(request):
        user = server.user_manager.get_request_user_id(request)
        if not isinstance(user, str) or not user or user.startswith("__") or any(x in user for x in ("/", "\\", ":", "..")):
            raise Invalid("无效用户")
        if user not in users:
            users[user] = Library(paths, Path(paths.get_user_directory()) / user / "unified-model-loader-test" / "models")
        return users[user]

    def guarded(handler):
        async def wrap(request):
            try:
                if request.method != "GET":
                    origin = request.headers.get("Origin")
                    if origin and urlsplit(origin).netloc != request.host:
                        raise web.HTTPForbidden(text="仅允许同源请求")
                return await handler(request)
            except Conflict as exc:
                return web.json_response({"error": str(exc)}, status=409)
            except (Invalid, ValueError, TypeError, KeyError, RecursionError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except web.HTTPException:
                raise
            except Exception:
                logging.exception("[模型加载] API 操作失败")
                return web.json_response({"error": "操作失败，输入已保留；请查看后端日志后重试"}, status=500)
        return wrap

    async def read(request, limit=MAX_JSON):
        chunks, size = [], 0
        async for chunk in request.content.iter_chunked(65536):
            size += len(chunk)
            if size > limit:
                raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=size)
            chunks.append(chunk)
        return b"".join(chunks)

    async def body(request):
        if request.content_type != "application/json":
            raise Invalid("请求需要 JSON")
        value = json.loads(await read(request))
        if not isinstance(value, dict):
            raise Invalid("请求正文需要对象")
        return value

    @server.routes.get(PREFIX + "/status")
    @guarded
    async def status(request):
        return web.json_response(capabilities())

    @server.routes.get(PREFIX + "/library")
    @guarded
    async def get_library(request):
        service = library(request)
        return web.json_response(await asyncio.to_thread(service.library, request.query))

    @server.routes.get(PREFIX + "/presets")
    @guarded
    async def get_presets(request):
        return web.json_response(await asyncio.to_thread(library(request).store.presets))

    @server.routes.post(PREFIX + "/{operation:inspect|save|sync|relink|validate|task-map|create-category|delete-category|save-preset|delete-preset}")
    @guarded
    async def mutate(request):
        value, service = await body(request), library(request)
        op = request.match_info["operation"]
        if op == "inspect":
            result = await asyncio.to_thread(service.catalog.inspect, value["kind"], value["file"])
        elif op == "save":
            result = await asyncio.to_thread(service.store.save, value)
        elif op == "sync":
            result = await asyncio.to_thread(service.sync, value["state"])
        elif op == "validate":
            state = parse_state(value["state"])
            result = {"warnings": warnings(state), "state": state}
        elif op == "task-map":
            from .runtime import task_id
            manager = text(value["manager"], 256)
            slots = value["slots"]
            if not isinstance(slots, list):
                raise Invalid("任务槽位列表无效")
            result = {task_id(manager, identifier(s)): s for s in slots}
        elif op == "create-category":
            result = await asyncio.to_thread(service.store.create_category, value["name"])
        elif op == "delete-category":
            result = await asyncio.to_thread(service.store.delete_category, value["name"])
        elif op == "save-preset":
            result = await asyncio.to_thread(service.store.save_preset, value["name"], value["state"])
        elif op == "delete-preset":
            result = await asyncio.to_thread(service.store.delete_preset, value["name"])
        else:
            service.catalog.resolve(value["kind"], value["new"])
            result = await asyncio.to_thread(service.store.relink, value["kind"], value["old"], value["new"], value["revision"])
            service.updated = 0
        return web.json_response(result)

    @server.routes.post(PREFIX + "/covers")
    @guarded
    async def upload(request):
        service = library(request)
        data = await read(request, 8 * 1024 * 1024)
        return web.json_response(await asyncio.to_thread(service.store.upload, data))

    @server.routes.get(PREFIX + r"/covers/{key:[a-f0-9]{64}\.png}")
    @guarded
    async def cover(request):
        path = library(request).store.root / "covers" / cover_key(request.match_info["key"])
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
