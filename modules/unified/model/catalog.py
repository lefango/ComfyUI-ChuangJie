"""Read registered model paths and bounded headers, never model weights."""
import hashlib
import json
import struct
import os
import re
from pathlib import Path
from .core import Invalid, filename, LABELS

FOLDERS = {"checkpoint": ("checkpoints",), "model": ("diffusion_models", "unet"),
           "clip": ("text_encoders", "clip"), "vae": ("vae",)}
EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".gguf"}


def safe_header(path):
    path = Path(path)
    with path.open("rb") as f:
        length = struct.unpack("<Q", f.read(8))[0]
        if not 2 <= length <= 16 * 1024 * 1024 or length > path.stat().st_size - 8:
            raise Invalid("Safetensors 文件头损坏")
        result = json.loads(f.read(length))
        if not isinstance(result, dict):
            raise Invalid("Safetensors 文件头结构无效")
        return result


def scaled_fp8(path):
    if Path(path).suffix.lower() not in (".safetensors", ".sft"):
        return False
    head = safe_header(path)
    tensors = {k: v for k, v in head.items() if k != "__metadata__"}
    if "scaled_fp8" in tensors:
        return True
    return any(str(v.get("dtype", "")).startswith("F8") for v in tensors.values()) and any(
        "weight_scale" in k or "scale_weight" in k for k in tensors)


class Catalog:
    def __init__(self, paths):
        self.paths = paths

    def roots(self, kind):
        result = []
        if kind not in FOLDERS:
            raise Invalid("未知模型类别")
        for folder in FOLDERS[kind]:
            try:
                values = self.paths.get_folder_paths(folder)
            except KeyError:
                continue
            for p in values:
                path = Path(p).resolve()
                if path not in result:
                    result.append(path)
        return result

    def scan(self):
        items = []
        for kind in FOLDERS:
            found = set()
            for root in self.roots(kind):
                if not root.is_dir():
                    continue
                visited = set()
                for directory, dirs, files in os.walk(root, followlinks=True):
                    actual = Path(directory).resolve()
                    if actual in visited:
                        dirs[:] = []
                        continue
                    visited.add(actual)
                    for value in files:
                        path = Path(directory) / value
                        if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                            continue
                        name = path.relative_to(root).as_posix()
                        if name in found:
                            continue
                        found.add(name)
                        stat = path.stat()
                        items.append({"id": self.key(kind, name), "kind": kind, "file": name,
                                      "name": path.stem, "format": path.suffix[1:].lower(), "size": stat.st_size,
                                      "folder": str(Path(name).parent).replace("\\", "/"), "missing": False})
        return sorted(items, key=lambda i: (i["kind"], i["file"].casefold()))

    @staticmethod
    def key(kind, name):
        return hashlib.sha256((kind + "\0" + filename(name)).encode("utf-8")).hexdigest()

    def resolve(self, kind, name):
        name = filename(name)
        for root in self.roots(kind):
            candidate = root / name
            # Symlinked model files are valid ComfyUI registered model entries.
            if candidate.is_file() and candidate.suffix.lower() in EXTENSIONS:
                return candidate
        raise Invalid(f"找不到{LABELS.get(kind, kind)}：{name}。请恢复文件或手动重新关联")

    def signature(self, kind, name):
        p = self.resolve(kind, name)
        s = p.stat()
        return [str(p.resolve()), s.st_size, s.st_mtime_ns, s.st_ctime_ns]

    def inspect(self, kind, name):
        path = self.resolve(kind, name)
        result = {"architecture": "", "confidence": "未知", "source": "未识别", "encoder": "", "quantization": ""}
        try:
            if path.suffix.lower() in (".safetensors", ".sft"):
                head = safe_header(path)
                metadata = head.get("__metadata__", {})
                keys = " ".join(k.lower() for k in head if k != "__metadata__")
                explicit = str(metadata.get("modelspec.architecture", metadata.get("architecture", ""))).lower()
                normalized_header = re.sub(r"[^a-z0-9]+", "_", explicit + " " + keys).strip("_")
                moss_signature = {"shared_block_modulation.weight", "layers.0.proj.ffn_up_gate.weight"}.issubset(head)
                if "moss_image" in normalized_header or moss_signature:
                    result.update(architecture="moss_image", confidence="较高", source="文件头结构／元数据")
                else:
                    for label, tests in [("flux2", ("flux2", "flux.2", "double_stream_modulation_img.")), ("flux", ("flux", "double_blocks.", "double_stream_blocks.")),
                                         ("sdxl", ("sdxl", "conditioner.embedders.1.")), ("sd3", ("sd3", "joint_blocks.")),
                                         ("wan", ("wan",)), ("qwen_image", ("qwen_image",)), ("stable_diffusion", ("stable-diffusion-v1", "stable-diffusion-v2"))]:
                        if any(t in (explicit + " " + keys) for t in tests):
                            result.update(architecture=label, confidence="较高", source="文件头结构／元数据")
                            break
            elif path.suffix.lower() == ".gguf":
                from gguf import GGUFReader
                reader = GGUFReader(str(path))
                def field(key):
                    value = reader.get_field(key)
                    if value is None:
                        return ""
                    data = value.parts[value.data[0]]
                    return data.tobytes().decode("utf-8", errors="replace") if data.dtype.itemsize == 1 else str(data.tolist())
                arch = field("general.architecture")
                result.update(encoder=arch, quantization=" / ".join(sorted({t.tensor_type.name for t in reader.tensors})), source="GGUF 元数据")
                from .vendor import capabilities
                supported = capabilities()["text_architectures" if kind == "clip" else "image_architectures"]
                result["compatibility"] = "架构在内置适配器名单内，实际用途与量化仍需匹配" if arch in supported else "此架构不在内置适配器名单内"
                if kind == "model" and arch in {"flux", "sd1", "sdxl", "sd3", "wan", "qwen_image", "ltxv", "hyvid", "lumina2"}:
                    result.update(architecture="stable_diffusion" if arch == "sd1" else arch, confidence="较高")
                del reader
        except ImportError:
            result["source"] = "未安装 GGUF 依赖，原生格式仍可使用"
        except Exception as exc:
            result["source"] = f"文件头读取失败：{exc}"
        if not result["architecture"]:
            lower = path.stem.lower()
            normalized_name = re.sub(r"[^a-z0-9]+", "_", lower).strip("_")
            if "moss_image" in normalized_name:
                result.update(architecture="moss_image", confidence="低", source="文件名推测，请人工确认")
            for value in ("flux2", "sdxl", "sd3", "qwen_image", "flux", "wan"):
                if result["architecture"]:
                    break
                if value in lower:
                    result.update(architecture=value, confidence="低", source="文件名推测，请人工确认")
                    break
        return result
