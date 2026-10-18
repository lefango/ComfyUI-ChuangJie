"""Transactional, revision-checked SQLite library, separate from workflow snapshots."""
import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from .core import Conflict, Invalid, Missing, filename, state, strength, text


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "covers").mkdir(exist_ok=True)
        self.path = self.root / "library.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise Invalid("资料库版本高于当前插件，请升级插件后打开")
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
                db.execute("SELECT id, revision, body FROM records WHERE kind=? ORDER BY rowid", (kind,))]

    def list(self, kind):
        with self.connect() as db:
            return self._list(db, kind)

    def _get(self, db, kind, key):
        row = db.execute("SELECT revision,body FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
        if row is None:
            raise Missing("资料不存在，请刷新")
        return dict(json.loads(row[1]), id=key, revision=row[0])

    def get(self, kind, key):
        with self.connect() as db:
            return self._get(db, kind, key)

    def preview_covers(self, names):
        if not names:
            return []
        placeholders = ",".join("?" for _ in names)
        with self.connect() as db:
            records = {key: json.loads(body).get("cover") for key, body in db.execute(
                f"SELECT id,body FROM records WHERE kind='lora' AND id IN ({placeholders})", names)}
        return [{"file": name, "cover": records.get(name)} for name in names]

    def _put(self, db, kind, key, body, expected):
        if type(expected) is not int or expected < 0:
            raise Invalid("必须提供非负整数 revision")
        row = db.execute("SELECT revision FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
        if (row[0] if row else 0) != expected:
            raise Conflict("资料已被另一个窗口修改。请刷新资料后重新保存（当前输入仍保留）。")
        rev = expected + 1
        db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?)", (kind, key, rev, json.dumps(body, ensure_ascii=False)))
        return dict(body, id=key, revision=rev)

    def _categories(self, db, value, scope):
        if not isinstance(value, list) or len(value) > 128 or any(not isinstance(x, str) for x in value):
            raise Invalid("分类必须是 ID 列表（最多 128 项）")
        valid = {c["id"] for c in self._list(db, "category") if c["scope"] == scope}
        if any(x not in valid for x in value):
            raise Invalid("分类不存在或属于另一个库")
        return list(dict.fromkeys(value))

    def _cover(self, value):
        if value is None:
            return None
        if not isinstance(value, str) or len(value) != 68 or not value.endswith(".png") or any(c not in "0123456789abcdef" for c in value[:-4]):
            raise Invalid("封面标识无效")
        if not (self.root / "covers" / value).is_file():
            raise Invalid("封面不存在，请重新上传")
        return value

    def save_lora(self, value):
        name = filename(value.get("file"))
        with self.connect() as db:
            body = {"file": name, "name": text(value.get("name", name), "名称", 256, True),
                    "notes": text(value.get("notes", ""), "备注", 32000),
                    "trigger": text(value.get("trigger", ""), "触发词"),
                    "categories": self._categories(db, value.get("categories", []), "lora"),
                    "cover": self._cover(value.get("cover")),
                    "strength_model": strength(value.get("strength_model", 1)),
                    "strength_clip": strength(value.get("strength_clip", 1))}
            return self._put(db, "lora", name, body, value.get("revision"))

    def save_preset(self, value):
        key = text(value.get("id", uuid.uuid4().hex), "预设 ID", 128, True)
        entries = state({"version": 1, "entries": value.get("entries")})["entries"]
        entries = [i for i in entries if i["enabled"]]
        with self.connect() as db:
            body = {"name": text(value.get("name"), "预设名称", 256, True),
                    "notes": text(value.get("notes", ""), "备注", 32000),
                    "categories": self._categories(db, value.get("categories", []), "preset"),
                    "cover": self._cover(value.get("cover")), "entries": entries}
            return self._put(db, "preset", key, body, value.get("revision"))

    def save_category(self, value):
        key = text(value.get("id", uuid.uuid4().hex), "分类 ID", 128, True)
        scope = value.get("scope")
        if scope not in ("lora", "preset"):
            raise Invalid("分类所属库无效")
        parent = value.get("parent")
        if parent is not None:
            parent = text(parent, "父分类 ID", 128, True)
        with self.connect() as db:
            cats = {c["id"]: c for c in self._list(db, "category")}
            if key in cats and cats[key]["scope"] != scope:
                raise Invalid("不能把分类移动到另一个库")
            cursor, visited = parent, {key}
            while cursor:
                if cursor in visited:
                    raise Invalid("不能将分类移入自身或子分类")
                visited.add(cursor)
                item = cats.get(cursor)
                if not item or item["scope"] != scope:
                    raise Invalid("父分类不存在或属于另一个库")
                cursor = item["parent"]
            body = {"name": text(value.get("name"), "分类名称", 128, True), "scope": scope, "parent": parent}
            if any(c["id"] != key and c["parent"] == parent and c["scope"] == scope and c["name"] == body["name"] for c in cats.values()):
                raise Invalid("同一目录已有同名分类")
            return self._put(db, "category", key, body, value.get("revision"))

    def relink(self, old_name, new_name, revision):
        old_name, new_name = filename(old_name), filename(new_name)
        if old_name == new_name:
            raise Invalid("请选择不同的新文件")
        with self.connect() as db:
            old = self._get(db, "lora", old_name)
            if type(revision) is not int or revision != old["revision"]:
                raise Conflict("原资料已变化，请刷新后重新关联")
            presets = self._list(db, "preset")
            for preset in presets:
                names = {i["file"] for i in preset["entries"]}
                if old_name in names and new_name in names:
                    raise Invalid(f"预设“{preset['name']}”同时包含两个文件，请先调整该预设后重新关联")
            old.pop("id"); old.pop("revision"); old["file"] = new_name
            saved = self._put(db, "lora", new_name, old, 0)
            for preset in presets:
                if not any(i["file"] == old_name for i in preset["entries"]):
                    continue
                for item in preset["entries"]:
                    if item["file"] == old_name:
                        item["file"] = new_name
                key, rev = preset.pop("id"), preset.pop("revision")
                self._put(db, "preset", key, preset, rev)
            db.execute("DELETE FROM records WHERE kind='lora' AND id=?", (old_name,))
            return saved

    def delete(self, kind, key, revision):
        if kind not in ("category", "preset"):
            raise Invalid("不允许删除模型资料或模型文件")
        with self.connect() as db:
            item = self._get(db, kind, key)
            if type(revision) is not int or item["revision"] != revision:
                raise Conflict("记录已变化，请刷新后重试")
            if kind == "category":
                cats = self._list(db, "category")
                removed = {key}
                while True:
                    more = {c["id"] for c in cats if c["parent"] in removed} - removed
                    if not more:
                        break
                    removed.update(more)
                for scope in ("lora", "preset"):
                    for record in self._list(db, scope):
                        filtered = [x for x in record["categories"] if x not in removed]
                        if filtered != record["categories"]:
                            ident, rev = record.pop("id"), record.pop("revision")
                            record["categories"] = filtered
                            self._put(db, scope, ident, record, rev)
                db.executemany("DELETE FROM records WHERE kind='category' AND id=?", [(x,) for x in removed])
            else:
                db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, key))
