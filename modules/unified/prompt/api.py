import asyncio
import json
import logging
from pathlib import Path
from urllib.parse import urlsplit
from .core import Conflict, Invalid, Missing, MAX_JSON, EMPTY_CONFIG, merge
from .storage import Store
from .styles import Styles

PREFIX = "/prompt-manager/v1"
_stores = {}


def _prefix_is_registered(routes):
    """Avoid collisions when the standalone Prompt Manager already owns these routes."""
    try:
        for resource in routes.resources():
            info = resource.get_info()
            path = info.get("path") if isinstance(info, dict) else None
            if isinstance(path, str) and (path == PREFIX or path.startswith(PREFIX + "/")):
                return True
    except (AttributeError, TypeError):
        return False
    return False


def _user_directory(paths):
    getter = getattr(paths, "get_user_directory", None)
    if callable(getter):
        return Path(getter())
    return Path(paths)


def register(server, paths):
    """Register prompt routes against an existing ComfyUI server and paths module.

    `paths` is normally ComfyUI's `folder_paths` module. Passing a filesystem path
    is also supported for integrations that already resolved the user-data root.
    Existing `/prompt-manager/v1` routes are left untouched.
    """
    if _prefix_is_registered(server.routes):
        return False
    user_root = _user_directory(paths)

    def get_store(request):
        user = server.user_manager.get_request_user_id(request)
        if not isinstance(user, str) or not user or user.startswith("__") or any(x in user for x in ("/", "\\", ":", "..")):
            raise Invalid("无效用户")
        root = user_root / user / "prompt-manager"
        if user not in _stores:
            _stores[user] = Store(root)
        return _stores[user]

    register_routes(server.routes, get_store)
    return True


def register_routes(routes, get_store):
    from aiohttp import web

    def guarded(handler):
        async def wrapped(request):
            try:
                origin = request.headers.get("Origin")
                if request.method != "GET" and origin:
                    parsed = urlsplit(origin)
                    if parsed.scheme != request.scheme or parsed.netloc != request.host:
                        raise web.HTTPForbidden(text="仅允许同源请求")
                return await handler(request)
            except Conflict as exc:
                return web.json_response({"error": str(exc)}, status=409)
            except Missing as exc:
                return web.json_response({"error": str(exc)}, status=404)
            except (ValueError, TypeError, RecursionError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except KeyError:
                return web.json_response({"error": "请求字段缺失或用户无效"}, status=403)
            except web.HTTPException:
                raise
            except Exception:
                logging.exception("[Prompt Manager] API operation failed")
                return web.json_response({"error": "操作失败，当前输入已保留，请查看后端日志"}, status=500)
        return wrapped

    @routes.get(PREFIX + "/status")
    @guarded
    async def status(request):
        get_store(request)
        return web.json_response({"ok": True, "version": "0.6.0", "schema": 2})

    @routes.get(PREFIX + "/styles")
    @guarded
    async def styles(request):
        return web.json_response(await asyncio.to_thread(Styles(get_store(request)).library))

    @routes.get(PREFIX + "/style-image/{id}")
    @guarded
    async def style_image(request):
        path = await asyncio.to_thread(Styles(get_store(request)).image, request.match_info["id"])
        return web.FileResponse(path, headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})

    @routes.get(PREFIX + "/style-cover/{image}")
    @guarded
    async def style_cover(request):
        path = await asyncio.to_thread(Styles(get_store(request)).cover_image, request.match_info["image"])
        return web.FileResponse(path, headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})

    @routes.get(PREFIX + "/library")
    @guarded
    async def library(request):
        return web.json_response(await asyncio.to_thread(get_store(request).library))

    @routes.post(PREFIX + "/{operation:category|preset|preset-read|delete|merge|style-save|style-delete|style-favorite|style-import}")
    @guarded
    async def operation(request):
        if request.content_type != "application/json":
            raise Invalid("需要 application/json")
        chunks, size = [], 0
        async for chunk in request.content.iter_chunked(65536):
            size += len(chunk)
            if size > MAX_JSON:
                raise web.HTTPRequestEntityTooLarge(max_size=MAX_JSON, actual_size=size)
            chunks.append(chunk)
        body = json.loads(b"".join(chunks))
        if not isinstance(body, dict):
            raise Invalid("请求体必须是 JSON 对象")
        store = get_store(request)
        op = request.match_info["operation"]
        if op == "style-save":
            result = await asyncio.to_thread(Styles(store).save, body)
        elif op == "style-delete":
            result = await asyncio.to_thread(Styles(store).delete, body.get("id"), body.get("revision"))
        elif op == "style-favorite":
            result = await asyncio.to_thread(Styles(store).favorite, body.get("id"), body.get("favorite"))
        elif op == "style-import":
            result = await asyncio.to_thread(Styles(store).import_local, body.get("path"))
        elif op == "merge":
            result = await asyncio.to_thread(merge, body.get("positive", ""), body.get("negative", ""),
                                            body.get("config", body.get("prompt_config", EMPTY_CONFIG)),
                                            body.get("positive_extra", ""), body.get("negative_extra", ""))
        elif op == "preset-read":
            result = await asyncio.to_thread(store.get, "preset", body.get("id"))
        elif op == "delete":
            result = await asyncio.to_thread(store.delete, body.get("kind"), body.get("id"), body.get("revision"))
        else:
            result = await asyncio.to_thread(store.save, op, body)
        return web.json_response(result)
