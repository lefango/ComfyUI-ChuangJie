"""Private, per-user image and mask library for image editing workflows."""

from contextlib import contextmanager
import io
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path


class ImageLibraryError(ValueError):
    """Invalid library input or an image that is not available."""


class ImageNotFound(ImageLibraryError):
    """A validated image ID has no record or backing image file."""


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_MASK_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_DIMENSION = 12_000
EDIT_MAX_WIDTH = 1080
EDIT_MAX_HEIGHT = 1920
EDIT_MIN_DIMENSION = 16
_UUID_HEX = re.compile(r"[0-9a-f]{32}\Z")
_OWNER_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_SUPPORTED_FORMATS = {"PNG", "JPEG", "WEBP"}
PENDING_IMAGE_TTL_SECONDS = 60 * 60
MAX_PENDING_IMAGES = 32
MAX_PENDING_BYTES = 512 * 1024 * 1024
MAX_PENDING_IMAGES_PER_USER = 8
MAX_PENDING_BYTES_PER_USER = 128 * 1024 * 1024
_pending_images = OrderedDict()
_pending_lock = threading.RLock()
_UNSET = object()


def _purge_pending(now):
    expired = [token for token, (created, _, _, _) in _pending_images.items()
               if now - created >= PENDING_IMAGE_TTL_SECONDS]
    for token in expired:
        _pending_images.pop(token, None)


def stage_pending_image(owner_id, image_bytes, mask_bytes=None):
    """Store request-validated image bytes under a bounded, one-time token."""
    owner_id = _validate_owner_id(owner_id)
    if not isinstance(image_bytes, bytes) or not image_bytes:
        raise ImageLibraryError("图片内容为空，无法准备图像编辑")
    if mask_bytes is not None and not isinstance(mask_bytes, bytes):
        raise ImageLibraryError("遮罩数据无效，无法准备图像编辑")
    if len(image_bytes) + (len(mask_bytes) if mask_bytes else 0) > MAX_PENDING_BYTES:
        raise ImageLibraryError("该图像超过待处理缓存容量限制")
    now = time.monotonic()
    with _pending_lock:
        _purge_pending(now)
        user_items = [item for item in _pending_images.values() if item[1] == owner_id]
        item_size = len(image_bytes) + (len(mask_bytes) if mask_bytes else 0)
        global_used = sum(len(item[2]) + (len(item[3]) if item[3] else 0)
                          for item in _pending_images.values())
        user_used = sum(len(item[2]) + (len(item[3]) if item[3] else 0)
                        for item in user_items)
        if (len(user_items) >= MAX_PENDING_IMAGES_PER_USER
                or user_used + item_size > MAX_PENDING_BYTES_PER_USER
                or len(_pending_images) >= MAX_PENDING_IMAGES
                or global_used + item_size > MAX_PENDING_BYTES):
            raise ImageLibraryError("待处理图像缓存已满，请稍后重试")
        token = secrets.token_urlsafe(32)
        _pending_images[token] = (now, owner_id, image_bytes, mask_bytes)
    return token


def consume_pending_image(token):
    """Return and remove prepared bytes; each token can be consumed only once."""
    if not isinstance(token, str) or not token or len(token) > 128:
        raise ImageLibraryError("待处理图像令牌无效或已过期")
    now = time.monotonic()
    with _pending_lock:
        _purge_pending(now)
        item = _pending_images.pop(token, None)
    if item is None:
        raise ImageLibraryError("待处理图像令牌无效、已过期或已使用")
    _, _, image_bytes, mask_bytes = item
    return image_bytes, mask_bytes


def _validate_owner_id(value):
    if (not isinstance(value, str) or not _OWNER_ID.fullmatch(value)
            or value.startswith("__") or ".." in value):
        raise ImageLibraryError("无效用户")
    return value


def _validate_uuid(value):
    if not isinstance(value, str) or not _UUID_HEX.fullmatch(value):
        raise ImageLibraryError("图像 ID 无效")
    return value


def _new_id():
    return uuid.uuid4().hex


def _safe_name(filename):
    if not isinstance(filename, str):
        raise ImageLibraryError("文件名无效")
    # Strip both POSIX and Windows path components; names are display metadata only.
    leaf = filename.replace("\\", "/").rsplit("/", 1)[-1]
    name = Path(leaf).stem.strip()
    name = "".join(ch for ch in name if ch >= " " and ch not in "\x7f")[:160]
    return name or "未命名图像"


def fitted_dimensions(width, height, max_width=EDIT_MAX_WIDTH, max_height=EDIT_MAX_HEIGHT):
    """Fit edit inputs into the configured box with each axis aligned to eight."""
    if any(not isinstance(value, int) or value < 1 for value in (width, height, max_width, max_height)):
        raise ImageLibraryError("图像尺寸无效")
    if max_width < EDIT_MIN_DIMENSION or max_height < EDIT_MIN_DIMENSION:
        raise ImageLibraryError("编辑边界不得小于 16")
    box_width = max_width // 8 * 8
    box_height = max_height // 8 * 8
    scale = min(box_width / width, box_height / height, 1)
    # Shrinking keeps the nearest proportional pixel; in-bounds images round
    # down. Only the explicit 16-pixel PromptStage minimum may enlarge a source.
    align = int if scale == 1 else lambda value: int(value + 0.5)
    fitted_width = min(box_width, max(EDIT_MIN_DIMENSION, align(width * scale / 8) * 8))
    fitted_height = min(box_height, max(EDIT_MIN_DIMENSION, align(height * scale / 8) * 8))
    return fitted_width, fitted_height


class ImageLibrary:
    """SQLite-backed library scoped to one ComfyUI user.

    ``user_data_dir`` is ComfyUI's ``paths.get_user_directory()`` result. All
    content is placed beneath ``<user_data_dir>/<owner_id>/unified-model-loader-test/image-edit``.
    """

    def __init__(self, user_data_dir, owner_id):
        self.owner_id = _validate_owner_id(owner_id)
        self.root = Path(user_data_dir) / self.owner_id / "unified-model-loader-test" / "image-edit"
        self.images_dir = self.root / "images"
        self.masks_dir = self.root / "masks"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.masks_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "library.sqlite3"
        self.lock = threading.RLock()
        with self._connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, 3):
                raise ImageLibraryError("图像资料库版本较新，请升级插件")
            if version == 0:
                self._create_folders_table(db)
                self._create_images_table(db)
                db.execute("PRAGMA user_version=3")
            elif version in (1, 2):
                if version == 1:
                    self._create_folders_table(db)
                    db.execute("""INSERT INTO folders(id,owner_id,name,parent_id,notes,cover_image_id)
                        SELECT id,owner_id,name,NULL,'',NULL FROM categories""")
                db.execute("ALTER TABLE images RENAME TO images_migrating_v3")
                self._create_images_table(db)
                if version == 1:
                    db.execute("""INSERT INTO images
                        (id,owner_id,name,category_id,folder_id,width,height,has_mask)
                        SELECT id,owner_id,name,category_id,category_id,width,height,has_mask
                        FROM images_migrating_v3 ORDER BY rowid""")
                else:
                    db.execute("""INSERT INTO images
                        (id,owner_id,name,category_id,folder_id,width,height,has_mask)
                        SELECT id,owner_id,name,category_id,coalesce(folder_id,category_id),width,height,has_mask
                        FROM images_migrating_v3 ORDER BY rowid""")
                db.execute("DROP TABLE images_migrating_v3")
                db.execute("DROP TABLE IF EXISTS categories")
                if db.execute("PRAGMA foreign_key_check").fetchall():
                    raise ImageLibraryError("图像资料库迁移后发现无效关联，已保留原数据")
                db.execute("PRAGMA user_version=3")

    @staticmethod
    def _create_folders_table(db):
        db.execute("""CREATE TABLE folders (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
            parent_id TEXT, notes TEXT NOT NULL DEFAULT '', cover_image_id TEXT,
            FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE)""")
        db.execute("CREATE UNIQUE INDEX folders_parent_name ON folders(owner_id, ifnull(parent_id,''), name COLLATE NOCASE)")

    @staticmethod
    def _create_images_table(db):
        db.execute("""CREATE TABLE images (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
            category_id TEXT, folder_id TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL,
            has_mask INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL)""")

    @contextmanager
    def _connect(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=15)
            try:
                db.execute("PRAGMA foreign_keys=ON")
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

    @staticmethod
    def _commit(db):
        db.commit()

    def _category_rows(self, db):
        return self._folder_rows(db)

    def _folder_rows(self, db):
        return [{"id": row[0], "owner_id": row[1], "name": row[2], "parent_id": row[3],
                 "notes": row[4], "cover_image_id": row[5]} for row in db.execute(
            """SELECT id,owner_id,name,parent_id,notes,cover_image_id FROM folders
               WHERE owner_id=? ORDER BY name COLLATE NOCASE,id""", (self.owner_id,))]

    @staticmethod
    def _image_metadata(row):
        image_id, owner_id, name, category_id, width, height, has_mask, *rest = row
        folder_id = rest[0] if rest else category_id
        return {"id": image_id, "owner_id": owner_id, "name": name, "folder_id": folder_id,
                "category": folder_id, "category_id": folder_id,
                "width": width, "height": height, "has_mask": bool(has_mask)}

    def _image_row(self, db, image_id):
        row = db.execute("""SELECT id,owner_id,name,category_id,width,height,has_mask,folder_id
            FROM images WHERE id=? AND owner_id=?""", (image_id, self.owner_id)).fetchone()
        if row is None:
            raise ImageNotFound("图像不存在")
        return row

    def library(self):
        with self._connect() as db:
            folders = self._folder_rows(db)
            images = [self._image_metadata(row) for row in db.execute(
                """SELECT id,owner_id,name,category_id,width,height,has_mask,folder_id FROM images
                   WHERE owner_id=? ORDER BY rowid""", (self.owner_id,))]
        return {"owner_id": self.owner_id, "folders": folders, "categories": folders, "images": images}

    def create_category(self, name):
        folder = self.create_folder(name)
        return {"id": folder["id"], "name": folder["name"]}

    @staticmethod
    def _validate_folder_name(name):
        if not isinstance(name, str):
            raise ImageLibraryError("文件夹名称无效")
        name = name.strip()
        if not name or len(name) > 80 or any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
            raise ImageLibraryError("文件夹名称无效")
        return name

    @staticmethod
    def _validate_notes(notes):
        if not isinstance(notes, str) or len(notes) > 2000:
            raise ImageLibraryError("文件夹备注无效")
        if any(ord(ch) < 32 and ch not in "\n\r\t" or ord(ch) == 127 for ch in notes):
            raise ImageLibraryError("文件夹备注无效")
        return notes

    def _validate_parent(self, db, parent_id, folder_id=None):
        if parent_id is None or parent_id == "":
            return None
        parent_id = _validate_uuid(parent_id)
        parent = db.execute("SELECT 1 FROM folders WHERE id=? AND owner_id=?", (parent_id, self.owner_id)).fetchone()
        if parent is None:
            raise ImageLibraryError("上级文件夹不存在")
        current = parent_id
        while folder_id is not None and current:
            if current == folder_id:
                raise ImageLibraryError("不能将文件夹移动到自身或其子文件夹")
            row = db.execute("SELECT parent_id FROM folders WHERE id=? AND owner_id=?", (current, self.owner_id)).fetchone()
            current = row[0] if row else None
        return parent_id

    def _validate_cover(self, db, cover_image_id):
        if cover_image_id is None or cover_image_id == "":
            return None
        cover_image_id = _validate_uuid(cover_image_id)
        if not db.execute("SELECT 1 FROM images WHERE id=? AND owner_id=?", (cover_image_id, self.owner_id)).fetchone():
            raise ImageLibraryError("封面图像不存在")
        return cover_image_id

    def create_folder(self, name, parent_id=None, notes="", cover_image_id=None):
        name = self._validate_folder_name(name)
        notes = self._validate_notes(notes)
        folder_id = _new_id()
        with self._connect() as db:
            parent_id = self._validate_parent(db, parent_id)
            cover_image_id = self._validate_cover(db, cover_image_id)
            try:
                db.execute("""INSERT INTO folders(id,owner_id,name,parent_id,notes,cover_image_id)
                    VALUES (?,?,?,?,?,?)""", (folder_id, self.owner_id, name, parent_id, notes, cover_image_id))
            except sqlite3.IntegrityError as exc:
                raise ImageLibraryError("同一上级文件夹中已存在同名文件夹") from exc
            row = db.execute("SELECT id,owner_id,name,parent_id,notes,cover_image_id FROM folders WHERE id=?", (folder_id,)).fetchone()
        return dict(zip(("id", "owner_id", "name", "parent_id", "notes", "cover_image_id"), row))

    def update_folder(self, folder_id, name=_UNSET, parent_id=_UNSET, notes=_UNSET, cover_image_id=_UNSET):
        folder_id = _validate_uuid(folder_id)
        with self._connect() as db:
            row = db.execute("SELECT id,owner_id,name,parent_id,notes,cover_image_id FROM folders WHERE id=? AND owner_id=?",
                             (folder_id, self.owner_id)).fetchone()
            if row is None:
                raise ImageNotFound("文件夹不存在")
            name = row[2] if name is _UNSET else self._validate_folder_name(name)
            parent_id = self._validate_parent(db, row[3] if parent_id is _UNSET else parent_id, folder_id)
            notes = row[4] if notes is _UNSET else self._validate_notes(notes)
            cover_image_id = self._validate_cover(db, row[5] if cover_image_id is _UNSET else cover_image_id)
            try:
                db.execute("""UPDATE folders SET name=?,parent_id=?,notes=?,cover_image_id=?
                    WHERE id=? AND owner_id=?""", (name, parent_id, notes, cover_image_id, folder_id, self.owner_id))
            except sqlite3.IntegrityError as exc:
                raise ImageLibraryError("同一上级文件夹中已存在同名文件夹") from exc
            return {"id": folder_id, "owner_id": self.owner_id, "name": name, "parent_id": parent_id,
                    "notes": notes, "cover_image_id": cover_image_id}

    @staticmethod
    def _decode_image(data, allowed_formats, max_bytes):
        if not isinstance(data, bytes) or not data:
            raise ImageLibraryError("图像数据无效")
        if len(data) > max_bytes:
            raise ImageLibraryError("图像文件超过大小限制")
        try:
            from PIL import Image, ImageOps
            with Image.open(io.BytesIO(data)) as probe:
                image_format = probe.format
                if image_format not in allowed_formats:
                    raise ImageLibraryError("仅支持 PNG、JPEG、WebP 图像")
                probe.verify()
            with Image.open(io.BytesIO(data)) as opened:
                if (opened.width < 1 or opened.height < 1
                        or opened.width > MAX_IMAGE_DIMENSION or opened.height > MAX_IMAGE_DIMENSION
                        or opened.width * opened.height > MAX_IMAGE_PIXELS):
                    raise ImageLibraryError("图像尺寸超过限制")
                image = ImageOps.exif_transpose(opened)
                if "A" in image.getbands():
                    image = image.convert("RGBA")
                else:
                    image = image.convert("RGB")
                return image.copy(), image_format
        except ImageLibraryError:
            raise
        except Exception as exc:
            raise ImageLibraryError("图像无法解码") from exc

    def upload(self, data, filename, category=""):
        image, _ = self._decode_image(data, _SUPPORTED_FORMATS, MAX_UPLOAD_BYTES)
        image_id = _new_id()
        category_id = category or None
        if category_id is not None:
            category_id = _validate_uuid(category_id)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=False)
        content = buffer.getvalue()
        if len(content) > MAX_UPLOAD_BYTES:
            raise ImageLibraryError("处理后的图像超过大小限制")
        path = self.images_dir / (image_id + ".png")
        pending = self.images_dir / (image_id + ".pending")
        try:
            pending.write_bytes(content)
            pending.replace(path)
            with self._connect() as db:
                if category_id and not db.execute(
                        "SELECT 1 FROM folders WHERE id=? AND owner_id=?", (category_id, self.owner_id)).fetchone():
                    raise ImageLibraryError("图像文件夹不存在")
                db.execute("""INSERT INTO images
                    (id,owner_id,name,category_id,folder_id,width,height,has_mask) VALUES (?,?,?,?,?,?,?,0)""",
                    (image_id, self.owner_id, _safe_name(filename), category_id, category_id,
                     image.width, image.height))
                row = self._image_row(db, image_id)
        except Exception:
            pending.unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            raise
        return self._image_metadata(row)

    def delete_image(self, image_id):
        image_id = _validate_uuid(image_id)
        with self._connect() as db:
            self._image_row(db, image_id)
            db.execute("UPDATE folders SET cover_image_id=NULL WHERE owner_id=? AND cover_image_id=?",
                       (self.owner_id, image_id))
            db.execute("DELETE FROM images WHERE id=? AND owner_id=?", (image_id, self.owner_id))
        (self.images_dir / (image_id + ".png")).unlink(missing_ok=True)
        (self.masks_dir / (image_id + ".png")).unlink(missing_ok=True)

    def _known_image(self, image_id):
        image_id = _validate_uuid(image_id)
        with self._connect() as db:
            self._image_row(db, image_id)
        return image_id

    def _stored_path(self, folder, image_id):
        path = folder / (image_id + ".png")
        if path.is_symlink() or not path.is_file():
            raise ImageNotFound("图像文件不存在")
        return path

    def image_path(self, image_id):
        return self._stored_path(self.images_dir, self._known_image(image_id))

    def mask_path(self, image_id):
        image_id = _validate_uuid(image_id)
        with self._connect() as db:
            row = self._image_row(db, image_id)
            if not row[6]:
                return None
        path = self.masks_dir / (image_id + ".png")
        if path.is_symlink() or not path.is_file():
            raise ImageNotFound("遮罩文件不存在或不可用，请重新保存遮罩")
        return path

    def save_mask(self, image_id, data):
        image_id = _validate_uuid(image_id)
        mask, _ = self._decode_image(data, {"PNG"}, MAX_MASK_BYTES)
        mask = mask.convert("L")
        with self._connect() as db:
            row = self._image_row(db, image_id)
            width, height = row[4], row[5]
            if mask.size != (width, height):
                raise ImageLibraryError("遮罩尺寸必须与原图完全一致")
            output = io.BytesIO()
            mask.save(output, format="PNG", optimize=False)
            content = output.getvalue()
            if len(content) > MAX_MASK_BYTES:
                raise ImageLibraryError("处理后的遮罩超过大小限制")
            target = self.masks_dir / (image_id + ".png")
            pending = self.masks_dir / (image_id + ".pending")
            backup = self.masks_dir / (image_id + ".backup")
            installed = False
            backup_exists = False
            try:
                if backup.exists():
                    if target.is_symlink() or target.exists():
                        backup.unlink()
                    else:
                        os.replace(backup, target)
                if target.is_symlink() or (target.exists() and not target.is_file()):
                    raise ImageLibraryError("遮罩文件路径不可用")
                pending.write_bytes(content)
                if target.exists():
                    os.replace(target, backup)
                    backup_exists = True
                os.replace(pending, target)
                installed = True
                db.execute("UPDATE images SET has_mask=1 WHERE id=? AND owner_id=?", (image_id, self.owner_id))
                self._commit(db)
            except Exception:
                try:
                    pending.unlink(missing_ok=True)
                except OSError:
                    pass
                if backup_exists:
                    os.replace(backup, target)
                elif installed:
                    target.unlink(missing_ok=True)
                db.rollback()
                raise
            else:
                try:
                    backup.unlink(missing_ok=True)
                except OSError:
                    pass
        return {"image_id": image_id, "has_mask": True, "width": width, "height": height}

    def delete_mask(self, image_id):
        image_id = _validate_uuid(image_id)
        with self._connect() as db:
            self._image_row(db, image_id)
            db.execute("UPDATE images SET has_mask=0 WHERE id=? AND owner_id=?", (image_id, self.owner_id))
        (self.masks_dir / (image_id + ".png")).unlink(missing_ok=True)
