"""Per-ComfyUI-user model metadata, optimistic revisions and decoded cover uploads."""
from contextlib import contextmanager
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import threading
from .core import Invalid, Conflict, cover_key, filename, text
from .catalog import Catalog


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "covers").mkdir(exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2):
                raise Invalid("资料库版本较新，请升级模型加载插件")
            db.execute("CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY COLLATE NOCASE)")
            db.execute("CREATE TABLE IF NOT EXISTS presets (name TEXT PRIMARY KEY COLLATE NOCASE, body TEXT NOT NULL)")
            legacy = [json.loads(body).get("category", "") for (body,) in db.execute("SELECT body FROM models").fetchall()]
            db.executemany("INSERT OR IGNORE INTO categories(name) VALUES (?)", [(name,) for name in legacy if name])
            db.execute("PRAGMA user_version=2")

    @contextmanager
    def connect(self):
        with self.lock:
            db = sqlite3.connect(self.root / "library.sqlite3", timeout=15)
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

    def all(self):
        with self.connect() as db:
            return {key: dict(json.loads(body), id=key, revision=rev) for key, rev, body in db.execute("SELECT id,revision,body FROM models")}

    def save(self, value):
        kind = value.get("kind")
        if kind not in ("checkpoint", "model", "clip", "vae"):
            raise Invalid("模型类别无效")
        name = filename(value.get("file"))
        key = Catalog.key(kind, name)
        cover = cover_key(value.get("cover"))
        if cover and not (self.root / "covers" / cover).is_file():
            raise Invalid("封面不存在，请重新上传")
        category = self.category_name(value.get("category", ""))
        disabled = value.get("disabled", False)
        if type(disabled) is not bool:
            raise Invalid("停用状态无效")
        if category:
            with self.connect() as db:
                if not db.execute("SELECT 1 FROM categories WHERE name=? COLLATE NOCASE", (category,)).fetchone():
                    raise Invalid("请先创建此用户分类")
        record = {"kind": kind, "file": name, "name": text(value.get("name", "")) or Path(name).stem,
                  "notes": text(value.get("notes", ""), 32000), "cover": cover,
                  "architecture": text(value.get("architecture", ""), 80), "category": category, "disabled": disabled}
        expected = value.get("revision", 0)
        if type(expected) is not int or expected < 0:
            raise Invalid("资料 revision 无效")
        with self.connect() as db:
            row = db.execute("SELECT revision FROM models WHERE id=?", (key,)).fetchone()
            revision = row[0] if row else 0
            if revision != expected:
                raise Conflict("资料已在其他窗口修改，请刷新后核对；当前输入已保留")
            revision += 1
            db.execute("INSERT OR REPLACE INTO models VALUES (?,?,?)", (key, revision, json.dumps(record, ensure_ascii=False)))
        return dict(record, id=key, revision=revision)

    @staticmethod
    def category_name(value):
        return text(value, 512)

    def categories(self):
        with self.connect() as db:
            return [row[0] for row in db.execute("SELECT name FROM categories ORDER BY name COLLATE NOCASE")]

    def create_category(self, value):
        name = self.category_name(value)
        if not name:
            raise Invalid("分类名称不能为空")
        with self.connect() as db:
            try:
                db.execute("INSERT INTO categories(name) VALUES (?)", (name,))
            except sqlite3.IntegrityError as exc:
                raise Conflict("同名分类已存在") from exc
        return self.categories()

    def delete_category(self, value):
        name = self.category_name(value)
        with self.connect() as db:
            row = db.execute("SELECT name FROM categories WHERE name=? COLLATE NOCASE", (name,)).fetchone()
            if row is None:
                raise Invalid("分类不存在")
            actual = row[0]
            records = db.execute("SELECT id,revision,body FROM models").fetchall()
            for key, revision, body in records:
                record = json.loads(body)
                if record.get("category") == actual:
                    record["category"] = ""
                    db.execute("UPDATE models SET revision=?,body=? WHERE id=?", (revision + 1, json.dumps(record, ensure_ascii=False), key))
            db.execute("DELETE FROM categories WHERE name=? COLLATE NOCASE", (actual,))
        return self.categories()

    def presets(self):
        with self.connect() as db:
            return [{"name": name, "state": json.loads(body)} for name, body in db.execute("SELECT name,body FROM presets ORDER BY name COLLATE NOCASE")]

    def save_preset(self, name, state):
        from .core import parse_state
        name = text(name, 80)
        if not name:
            raise Invalid("预设名称不能为空")
        state = parse_state(state)
        with self.connect() as db:
            db.execute("INSERT INTO presets(name,body) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body",
                       (name, json.dumps(state, ensure_ascii=False, separators=(",", ":"))))
        return self.presets()

    def delete_preset(self, name):
        name = text(name, 80)
        with self.connect() as db:
            if not db.execute("DELETE FROM presets WHERE name=? COLLATE NOCASE", (name,)).rowcount:
                raise Invalid("预设不存在")
        return self.presets()

    def relink(self, kind, old, new, expected):
        old, new = filename(old), filename(new)
        if old == new:
            raise Invalid("请选择不同的新文件")
        with self.connect() as db:
            oldkey, newkey = Catalog.key(kind, old), Catalog.key(kind, new)
            row = db.execute("SELECT revision,body FROM models WHERE id=?", (oldkey,)).fetchone()
            if row is None or row[0] != expected:
                raise Conflict("原资料已变化，请刷新后重新关联")
            if db.execute("SELECT 1 FROM models WHERE id=?", (newkey,)).fetchone():
                raise Conflict("新文件已有资料，不能覆盖；请分别编辑并确认")
            data = json.loads(row[1])
            data["file"] = new
            db.execute("INSERT INTO models VALUES (?,?,?)", (newkey, 1, json.dumps(data, ensure_ascii=False)))
            db.execute("DELETE FROM models WHERE id=?", (oldkey,))
        return dict(data, id=newkey, revision=1)

    def upload(self, data):
        from PIL import Image, ImageOps
        if len(data) > 8 * 1024 * 1024:
            raise Invalid("封面最大 8 MB")
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 32_000_000:
                    raise Invalid("仅支持 PNG、JPEG、WebP，最多 3200 万像素")
                image = ImageOps.exif_transpose(image).convert("RGB")
                image.thumbnail((1024, 1024))
                output = io.BytesIO()
                image.save(output, format="PNG")
        except Invalid:
            raise
        except Exception as exc:
            raise Invalid("封面图片无法解码") from exc
        content = output.getvalue()
        key = hashlib.sha256(content).hexdigest() + ".png"
        path = self.root / "covers" / key
        with self.lock:
            if not path.exists():
                pending = path.with_suffix(".pending")
                pending.write_bytes(content)
                pending.replace(path)
        return {"cover": key}
