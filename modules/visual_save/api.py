import asyncio
import json
import logging
from urllib.parse import urlsplit
from .paths import list_folders, create_folder

PREFIX = "/visual-save-image/v1"


def register():
    from server import PromptServer
    register_routes(PromptServer.instance.routes)


def register_routes(routes):
    from aiohttp import web

    def guarded(handler):
        async def wrapped(request):
            try:
                if request.method != "GET" and request.headers.get("Origin"):
                    origin = urlsplit(request.headers["Origin"])
                    if origin.scheme != request.scheme or origin.netloc != request.host:
                        return web.json_response({"error": "仅允许同源请求"}, status=403)
                return await handler(request)
            except FileExistsError:
                return web.json_response({"error": "同名文件或文件夹已存在"}, status=409)
            except FileNotFoundError as exc:
                return web.json_response({"error": str(exc)}, status=404)
            except PermissionError:
                return web.json_response({"error": "没有访问或创建文件夹的权限"}, status=403)
            except (ValueError, TypeError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except web.HTTPException:
                raise
            except OSError:
                logging.exception("[Visual Save Image] Directory operation failed")
                return web.json_response({"error": "文件夹操作失败，请检查磁盘与目录权限"}, status=500)
        return wrapped

    @routes.get(PREFIX + "/folders")
    @guarded
    async def folders(request):
        return web.json_response(await asyncio.to_thread(list_folders, request.query.get("path", "")))

    @routes.post(PREFIX + "/folders")
    @guarded
    async def mkdir(request):
        if request.content_type != "application/json":
            raise ValueError("请求必须是 JSON")
        data = bytearray()
        async for chunk in request.content.iter_chunked(4096):
            data.extend(chunk)
            if len(data) > 8192:
                raise web.HTTPRequestEntityTooLarge(max_size=8192, actual_size=len(data))
        body = json.loads(data)
        if not isinstance(body, dict):
            raise ValueError("请求必须是 JSON 对象")
        return web.json_response(await asyncio.to_thread(create_folder, body.get("path", ""), body.get("name")))
