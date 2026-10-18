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


def register():
    import folder_paths
    from server import PromptServer
    server = PromptServer.instance

    def get_store(request):
        user = server.user_manager.get_request_user_id(request)
        if not isinstance(user, str) or not user or user.startswith("__") or any(x in user for x in ("/", "\\", ":", "..")):
            raise Invalid("��Ч�û�")
        root = Path(folder_paths.get_user_directory()) / user / "prompt-manager"
        if user not in _stores:
            _stores[user] = Store(root)
        return _stores[user]

    register_routes(server.routes, get_store)


def register_routes(routes, get_store):
    from aiohttp import web

    def guarded(handler):
        async def wrapped(request):
            try:
                origin = request.headers.get("Origin")
                if request.method != "GET" and origin:
                    parsed = urlsplit(origin)
                    if parsed.scheme != request.scheme or parsed.netloc != request.host:
                        raise web.HTTPForbidden(text="������ͬԴ����")
                return await handler(request)
            except Conflict as exc:
                return web.json_response({"error": str(exc)}, status=409)
            except Missing as exc:
                return web.json_response({"error": str(exc)}, status=404)
            except (ValueError, TypeError, RecursionError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except KeyError:
                return web.json_response({"error": "�����ֶ�ȱʧ���û���Ч"}, status=403)
            except web.HTTPException:
                raise
            except Exception:
                logging.exception("[Prompt Manager] API operation failed")
                return web.json_response({"error": "����ʧ�ܣ���ǰ�����ѱ�������鿴�����־"}, status=500)
        return wrapped

    @routes.get(PREFIX + "/status")
    @guarded
    async def status(request):
        get_store(request)
        return web.json_response({"ok": True, "version": "0.4.2", "schema": 2})

    @routes.get(PREFIX + "/styles")
    @guarded
    async def styles(request):
        return web.json_response(await asyncio.to_thread(Styles(get_store(request)).library))

    @routes.get(PREFIX + "/style-image/{id}")
    @guarded
    async def style_image(request):
        path = await asyncio.to_thread(Styles(get_store(request)).image, request.match_info["id"])
        return web.FileResponse(path, headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})

    @routes.get(PREFIX + "/library")
    @guarded
    async def library(request):
        return web.json_response(await asyncio.to_thread(get_store(request).library))

    @routes.post(PREFIX + "/{operation:category|preset|preset-read|delete|merge|style-save|style-delete|style-favorite|style-import}")
    @guarded
    async def operation(request):
        if request.content_type != "application/json":
            raise Invalid("��Ҫ application/json")
        chunks, size = [], 0
        async for chunk in request.content.iter_chunked(65536):
            size += len(chunk)
            if size > MAX_JSON:
                raise web.HTTPRequestEntityTooLarge(max_size=MAX_JSON, actual_size=size)
            chunks.append(chunk)
        body = json.loads(b"".join(chunks))
        if not isinstance(body, dict):
            raise Invalid("����������� JSON ����")
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
                                            body.get("config", EMPTY_CONFIG), body.get("positive_extra", ""), body.get("negative_extra", ""))
        elif op == "preset-read":
            result = await asyncio.to_thread(store.get, "preset", body.get("id"))
        elif op == "delete":
            result = await asyncio.to_thread(store.delete, body.get("kind"), body.get("id"), body.get("revision"))
        else:
            result = await asyncio.to_thread(store.save, op, body)
        return web.json_response(result)
