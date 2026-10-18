"""Per-user SQLite library. Workflows never consult this library at execution."""
import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from .core import Conflict, Invalid, Missing, text


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "library.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise Invalid("资料库版本过高，请升级插件")
            db.execute("CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))")
            db.execute("PRAGMA user_version=1")

    @contextmanager
    def connect(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=15)
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

    def _list(self, db, kind):
        return [dict(json.loads(body), id=key, revision=rev) for key, rev, body in
                db.execute("SELECT id,revision,body FROM records WHERE kind=? ORDER BY rowid", (kind,))]

    def _get(self, db, kind, key):
        row = db.execute("SELECT revision,body FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
        if row is None:
            raise Missing("来源不存在，请刷新；节点快照仍然有效")
        return dict(json.loads(row[1]), id=key, revision=row[0])

    def get(self, kind, key):
        with self.connect() as db:
            return self._get(db, kind, text(key, "ID", 128, True))

    def _check(self, db, kind, key, expected):
        if type(expected) is not int or expected < 0:
            raise Invalid("必须提供非负整数 revision")
        row = db.execute("SELECT revision FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
        if (row[0] if row else 0) != expected:
            raise Conflict("资料已变化，请刷新后核对再保存。当前草稿已保留。")
        return expected + 1

    def save(self, kind, value):
        if kind not in ("category", "preset"):
            raise Invalid("未知资料类型")
        key = text(value.get("id") or str(uuid.uuid4()), "ID", 128, True)
        with self.connect() as db:
            revision = self._check(db, kind, key, value.get("revision"))
            name = text(value.get("name"), "名称", 128, True).strip()
            cats = {c["id"]: c for c in self._list(db, "category")}
            if kind == "category":
                parent = text(value.get("parent", ""), "父分类", 128)
                cursor, visited = parent, {key}
                while cursor:
                    if cursor in visited:
                        raise Invalid("不能移动到自身或后代分类")
                    if cursor not in cats:
                        raise Invalid("父分类不存在")
                    visited.add(cursor)
                    cursor = cats[cursor]["parent"]
                if any(c["id"] != key and c["parent"] == parent and c["name"] == name for c in cats.values()):
                    raise Invalid("同级已有同名分类")
                body = {"name": name, "parent": parent}
            else:
                categories = value.get("categories", [])
                if not isinstance(categories, list) or len(categories) > 128 or any(not isinstance(c, str) or c not in cats for c in categories):
                    raise Invalid("分类 ID 不存在或列表无效")
                body = {"name": name, "note": text(value.get("note", ""), "备注", 10000),
                        "categories": list(dict.fromkeys(categories)),
                        "positive": text(value.get("positive", "")), "negative": text(value.get("negative", ""))}
                if not body["positive"].strip() and not body["negative"].strip():
                    raise Invalid("正负面至少填写一侧")
            db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?)", (kind, key, revision, json.dumps(body, ensure_ascii=False)))
            return dict(body, id=key, revision=revision)

    def delete(self, kind, key, revision):
        if kind not in ("category", "preset"):
            raise Invalid("未知资料类型")
        key = text(key, "ID", 128, True)
        with self.connect() as db:
            self._get(db, kind, key)
            self._check(db, kind, key, revision)
            keys = {key}
            if kind == "category":
                cats = self._list(db, "category")
                while True:
                    more = {c["id"] for c in cats if c["parent"] in keys}
                    if more <= keys:
                        break
                    keys |= more
                for preset in self._list(db, "preset"):
                    remaining = [c for c in preset["categories"] if c not in keys]
                    if remaining != preset["categories"]:
                        preset["categories"] = remaining
                        pid, rev = preset.pop("id"), preset.pop("revision")
                        db.execute("UPDATE records SET body=?,revision=? WHERE kind='preset' AND id=?",
                                   (json.dumps(preset, ensure_ascii=False), rev + 1, pid))
            for target in keys:
                db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, target))
            return {"deleted": sorted(keys)}

    def library(self):
        with self.connect() as db:
            return {"categories": self._list(db, "category"), "presets": self._list(db, "preset")}
