"""Decode and re-encode uploaded raster images, discarding embedded metadata."""
import hashlib
import io
import warnings
from .core import Invalid

MAX_UPLOAD = 8 * 1024 * 1024


def save_cover(root, data):
    if not data or len(data) > MAX_UPLOAD:
        raise Invalid("封面不能为空且不能超过 8 MB")
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ("PNG", "JPEG", "WEBP"):
                    raise Invalid("仅支持 PNG、JPEG、WebP 图片")
                if image.width * image.height > 32_000_000:
                    raise Invalid("图片超过 3200 万像素，请缩小后上传")
                image.load()
                image = ImageOps.exif_transpose(image).convert("RGB")
                image.thumbnail((1024, 1024))
                out = io.BytesIO()
                image.save(out, "PNG")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise Invalid("图片损坏或无法解码，请更换图片") from exc
    content = out.getvalue()
    key = hashlib.sha256(content).hexdigest() + ".png"
    path = root / "covers" / key
    if not path.exists():
        # Immutable content-addressed file: concurrent identical uploads are safe.
        try:
            with path.open("xb") as stream:
                stream.write(content)
        except FileExistsError:
            pass
    return key
