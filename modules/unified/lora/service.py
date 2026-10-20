"""Application operations used by both production HTTP routes and local preview."""
from pathlib import PurePosixPath
from .core import Invalid, Missing, MAX_ENTRIES, filename, state
from .covers import save_cover


class Service:
    def __init__(self, store, catalog):
        self.store, self.catalog = store, catalog

    def library(self, scope="lora", category="", query="", offset=0, limit=48, refresh=False):
        if scope not in ("lora", "preset"):
            raise Invalid("无效的库类型")
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise Invalid("分页参数无效（limit 为 1 至 200）")
        if len(query) > 200:
            raise Invalid("搜索文字过长")
        names = self.catalog.scan(refresh)
        categories = self.store.list("category")
        if scope == "lora":
            records = {r["file"]: r for r in self.store.list("lora")}
            items = []
            for name in sorted(set(names) | set(records), key=str.casefold):
                record = records.get(name, {"file": name, "id": name, "name": PurePosixPath(name).stem,
                    "notes": "", "trigger": "", "categories": [], "cover": None,
                    "strength_model": 1.0, "strength_clip": 1.0, "revision": 0})
                items.append(dict(record, missing=name not in names))
        else:
            items = [dict(r, missing=[i["file"] for i in r["entries"] if i["file"] not in names])
                     for r in self.store.list("preset")]
        if category == "uncategorized":
            items = [i for i in items if not i["categories"]]
        elif category:
            valid = {c["id"] for c in categories if c["scope"] == scope}
            if category not in valid:
                raise Invalid("分类不存在，请刷新")
            descendants = {category}
            while True:
                more = {c["id"] for c in categories if c["parent"] in descendants} - descendants
                if not more:
                    break
                descendants.update(more)
            items = [i for i in items if descendants.intersection(i["categories"])]
        if query:
            words = query.casefold().split()
            items = [i for i in items if all(w in " ".join(str(i.get(k, "")) for k in
                     ("name", "file", "notes", "trigger")).casefold() for w in words)]
        return {"items": items[offset:offset+limit], "total": len(items), "categories": categories,
                "offset": offset, "limit": limit}

    def dispatch(self, operation, body):
        if not isinstance(body, dict):
            raise Invalid("请求内容必须为 JSON 对象")
        if operation == "previews":
            names = body.get("files")
            if not isinstance(names, list) or len(names) > MAX_ENTRIES:
                raise Invalid(f"files 必须为文件名列表，最多 {MAX_ENTRIES} 项")
            names = list(dict.fromkeys(filename(name) for name in names))
            return {"items": self.store.preview_covers(names)}
        if operation == "lora":
            self.catalog.resolve(body.get("file"))
            return self.store.save_lora(body)
        if operation == "category":
            return self.store.save_category(body)
        if operation == "preset":
            entries = state({"version": 1, "entries": body.get("entries")})["entries"]
            for item in entries:
                if item["enabled"]:
                    self.catalog.resolve(item["file"])
            return self.store.save_preset(body)
        if operation == "apply":
            preset = self.store.get("preset", body.get("id", ""))
            missing = []
            for item in preset["entries"]:
                try:
                    self.catalog.resolve(item["file"])
                except Missing:
                    missing.append(item["file"])
            if missing:
                raise Missing("预设文件缺失，未改变当前组合：" + "、".join(missing))
            return state({"version": 1, "entries": preset["entries"],
                          "preset": {k: preset[k] for k in ("id", "name", "revision")}})
        if operation == "preset-read":
            return self.store.get("preset", body.get("id", ""))
        if operation == "delete":
            self.store.delete(body.get("kind"), body.get("id"), body.get("revision"))
            return {"ok": True}
        if operation == "sync":
            snapshot = state(body.get("config"))
            metadata = {r["file"]: r for r in self.store.list("lora")}
            missing = []
            for item in snapshot["entries"]:
                try:
                    self.catalog.resolve(item["file"])
                except Missing:
                    missing.append(item["file"])
                if item["file"] in metadata:
                    info = metadata[item["file"]]
                    item.update(name=info["name"], trigger=info["trigger"])
            return {"config": snapshot, "missing": missing}
        if operation == "relink":
            old_name = body.get("old_file", "")
            self.store.get("lora", old_name)
            try:
                self.catalog.resolve(old_name)
            except Missing:
                pass
            else:
                raise Invalid("原文件仍然存在，不需要重新关联")
            new = body.get("file")
            self.catalog.resolve(new)
            return self.store.relink(old_name, new, body.get("revision"))
        raise Invalid("未知操作")

    def upload(self, data):
        return {"cover": save_cover(self.store.root, data)}
