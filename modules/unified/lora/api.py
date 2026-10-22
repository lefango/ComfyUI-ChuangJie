"""Same-origin aiohttp API. JSON and image bodies are read with explicit limits."""
import asyncio
import json
import logging
from pathlib import Path
from urllib.parse import urlsplit
from .catalog import Catalog
from .core import Conflict, Invalid, Missing, MAX_JSON
from .covers import MAX_UPLOAD
from .service import Service
from .storage import Store
from .version import VERSION

PREFIX = "/cj-unified-loader-test/v1/loras"
_services = {}


def register():
    import folder_paths
    from server import PromptServer
    server = PromptServer.instance

    def get_service(request):
        # Use ComfyUI's own user validation, and isolate each user's shared library.
        user = server.user_manager.get_request_user_id(request)
        if not isinstance(user, str) or not user or any(x in user for x in ("/", "\\", ":", "..")) or user.startswith("__"):
            raise Invalid("无效用户")
        root = Path(folder_paths.get_user_directory()) / user / "unified-model-loader-test" / "loras"
        if user not in _services:
            _services[user] = Service(Store(root), Catalog(folder_paths))
        return _services[user]

    register_routes(server.routes, get_service)


def register_routes(routes, get_service):
    from aiohttp import web

    def guarded(handler):
        async def wrapped(request):
            try:
                if request.method != "GET":
                    origin = request.headers.get("Origin")
                    if origin and urlsplit(origin).netloc != request.host:
                        raise web.HTTPForbidden(text="仅允许同源请求")
                return await handler(request)
            except Conflict as exc:
                return web.json_response({"error": str(exc)}, status=409)
            except Missing as exc:
                return web.json_response({"error": str(exc)}, status=404)
            except (Invalid, ValueError, TypeError, RecursionError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except KeyError:
                return web.json_response({"error": "用户无效或请求字段缺失"}, status=403)
            except web.HTTPException:
                raise
            except Exception:
                logging.exception("[LoRA Manager] API operation failed")
                return web.json_response({"error": "操作失败。输入内容已保留，请查看 ComfyUI 后端日志后重试。"}, status=500)
        return wrapped

    async def read_limited(request, limit):
        chunks, size = [], 0
        async for data in request.content.iter_chunked(65536):
            size += len(data)
            if size > limit:
                raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=size)
            chunks.append(data)
        return b"".join(chunks)

    @routes.get(PREFIX + "/status")
    @guarded
    async def status(request):
        get_service(request)
        return web.json_response({"ok": True, "version": VERSION, "schema": 1})

    @routes.get(PREFIX + "/library")
    @guarded
    async def library(request):
        q = request.query
        service = get_service(request)
        result = await asyncio.to_thread(service.library, q.get("scope", "lora"), q.get("category", ""),
            q.get("q", ""), int(q.get("offset", 0)), int(q.get("limit", 48)), q.get("refresh") == "1")
        return web.json_response(result)

    @routes.post(PREFIX + "/{operation:lora|category|preset|preset-read|apply|delete|sync|relink|previews}")
    @guarded
    async def mutate(request):
        if request.content_type != "application/json":
            raise Invalid("需要 application/json 请求")
        body = json.loads(await read_limited(request, MAX_JSON))
        service = get_service(request)
        result = await asyncio.to_thread(service.dispatch, request.match_info["operation"], body)
        return web.json_response(result)

    @routes.post(PREFIX + "/covers")
    @guarded
    async def upload(request):
        service = get_service(request)
        data = await read_limited(request, MAX_UPLOAD)
        return web.json_response(await asyncio.to_thread(service.upload, data))

    @routes.get(PREFIX + "/covers/{key:[0-9a-f]{64}\\.png}")
    @guarded
    async def cover(request):
        path = get_service(request).store.root / "covers" / request.match_info["key"]
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable"})
