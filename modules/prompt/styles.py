"""Per-user local style library. Execution depends only on workflow snapshots."""
import base64
import hashlib
import json
import re
import uuid
from pathlib import Path
from .core import Invalid, Missing, text


def image_bytes(data):
    if len(data) > 1024 * 1024:
        raise Invalid("封面不能超过 1 MB")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    raise Invalid("封面仅支持 PNG、JPEG 或 WebP 图片")


class Styles:
    def __init__(self, store):
        self.store = store
        self.covers = store.root / "style-covers"

    def cover(self, data):
        ext = image_bytes(data)
        key = hashlib.sha256(data).hexdigest() + "." + ext
        self.covers.mkdir(parents=True, exist_ok=True)
        path = self.covers / key
        if not path.exists():
            temporary = self.covers / (key + "." + uuid.uuid4().hex + ".tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
        return key

    def library(self):
        with self.store.connect() as db:
            return {"styles": self.store._list(db, "style"),
                    "favorites": [p["id"] for p in self.store._list(db, "favorite")]}

    def save(self, value):
        key = text(value.get("id") or "custom-" + uuid.uuid4().hex, "风格 ID", 128, True)
        body = {"name": text(value.get("name"), "名称", 128, True),
                "english": text(value.get("english", ""), "英文名", 128),
                "category": text(value.get("category", "未分类"), "分类", 128, True),
                "theme": text(value.get("theme", "自定义"), "风格库", 128, True),
                "positive": text(value.get("positive", "")), "negative": text(value.get("negative", "")),
                "text_type": value.get("text_type", "paragraph")}
        if body["text_type"] not in ("tags", "paragraph") or not (body["positive"].strip() or body["negative"].strip()):
            raise Invalid("请填写风格提示词并选择有效的文本类型")
        with self.store.connect() as db:
            revision = self.store._check(db, "style", key, value.get("revision", 0))
            old = self.store._get(db, "style", key) if revision > 1 else {}
            body["image"] = old.get("image", "")
            if value.get("cover"):
                match = re.fullmatch(r"data:image/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", text(value["cover"], "封面", 1500000))
                if not match:
                    raise Invalid("无效封面")
                body["image"] = self.cover(base64.b64decode(match[1], validate=True))
            db.execute("INSERT OR REPLACE INTO records VALUES ('style',?,?,?)", (key, revision, json.dumps(body, ensure_ascii=False)))
            return dict(body, id=key, revision=revision)

    def favorite(self, key, enabled):
        key = text(key, "风格 ID", 128, True)
        if type(enabled) is not bool:
            raise Invalid("收藏开关无效")
        with self.store.connect() as db:
            self.store._get(db, "style", key)
            if enabled:
                db.execute("INSERT OR REPLACE INTO records VALUES ('favorite',?,1,'{}')", (key,))
            else:
                db.execute("DELETE FROM records WHERE kind='favorite' AND id=?", (key,))
        return {"id": key, "favorite": enabled}

    def delete(self, key, revision):
        key = text(key, "风格 ID", 128, True)
        with self.store.connect() as db:
            self.store._get(db, "style", key)
            self.store._check(db, "style", key, revision)
            db.execute("DELETE FROM records WHERE kind IN ('style','favorite') AND id=?", (key,))
        return {"deleted": key}

    def image(self, key):
        with self.store.connect() as db:
            item = self.store._get(db, "style", text(key, "风格 ID", 128, True))
        name = item.get("image", "")
        if not re.fullmatch(r"[a-f0-9]{64}\.(png|jpg|webp)", name):
            raise Missing("风格没有封面")
        path = self.covers / name
        if not path.is_file():
            raise Missing("封面缺失，文本仍可使用")
        return path

    def import_local(self, source):
        root = Path(text(source, "风格目录", 2048, True)).resolve()
        if not root.is_dir() or not (root / "styles.json").is_file():
            raise Invalid("请选择包含 styles.json 和 thumbs 的本地风格目录")
        if (root / "styles.json").stat().st_size > 8 * 1024 * 1024:
            raise Invalid("风格库文件过大")
        records = json.loads((root / "styles.json").read_text(encoding="utf-8-sig"))
        if not isinstance(records, list) or len(records) > 2000:
            raise Invalid("风格库必须是列表，最多 2000 项")
        # Validate the whole source before changing the library. Never evaluate paths in JSON.
        items = []
        for entry in records:
            if not isinstance(entry, dict):
                raise Invalid("风格条目无效")
            english = text(entry.get("name"), "风格英文名", 128, True)
            categories = {"3D Render": "3D渲染", "Anime": "动漫", "Cartoon": "卡通", "Comics": "漫画", "Cover Art": "封面艺术", "Design": "设计", "Digital Painting": "数字绘画", "Drawing": "素描", "Painting": "绘画", "Photography": "摄影"}
            section = text(entry.get("section") or "未分类", "分类", 128, True)
            body = {"name": text(entry.get("name_cn") or english, "名称", 128, True), "english": english,
                    "positive": text(entry.get("prompt", "")), "negative": "", "text_type": "paragraph",
                    "category": categories.get(section, section), "theme": root.name.title(), "image": ""}
            if not body["positive"].strip():
                raise Invalid("导入风格提示词不能为空")
            key = "import-" + hashlib.sha256((root.name.lower() + "\0" + english).encode()).hexdigest()[:40]
            thumb = entry.get("thumb", "")
            if not isinstance(thumb, str) or ":" in thumb:
                raise Invalid("无效缩略图文件名")
            parts = thumb.replace("\\", "/").split("/")
            if len(parts) > 1 and parts[:-1] not in ([root.name, "thumbs"], ["thumbs"]):
                raise Invalid("无效缩略图文件名")
            thumb = parts[-1]
            if thumb in (".", ".."):
                raise Invalid("无效缩略图文件名")
            image = root / "thumbs" / thumb
            if thumb and not image.resolve().is_relative_to((root / "thumbs").resolve()):
                raise Invalid("缩略图不能位于风格目录之外")
            data = image.read_bytes() if thumb and image.is_file() and image.stat().st_size <= 1024 * 1024 else None
            if data:
                try:
                    image_bytes(data)
                except Invalid:
                    data = None
            items.append((key, body, data))
        imported = 0
        missing = 0
        with self.store.connect() as db:
            for key, body, data in items:
                old = db.execute("SELECT revision,body FROM records WHERE kind='style' AND id=?", (key,)).fetchone()
                if data:
                    body["image"] = self.cover(data)
                else:
                    missing += 1
                serialized = json.dumps(body, ensure_ascii=False)
                if old and old[1] == serialized:
                    continue
                db.execute("INSERT OR REPLACE INTO records VALUES ('style',?,?,?)", (key, old[0] + 1 if old else 1, serialized))
                imported += 1
        return {"imported": imported, "total": len(items), "missing_covers": missing}
