"""Isolated, pinned GGUF loading core; no third-party custom node registration."""
import json
from pathlib import Path
import ast
import re


def upstream_version():
    data = json.loads(Path(__file__).with_name("upstream.json").read_text(encoding="utf-8"))
    return {"repository": data["repository"], "revision": data["revision"], "license": data["license"]}


def capabilities():
    root = Path(__file__).parent / "gguf_core"
    sets = {}
    for value in ast.parse((root / "loader.py").read_text(encoding="utf-8")).body:
        if isinstance(value, ast.Assign) and isinstance(value.targets[0], ast.Name) and value.targets[0].id in ("IMG_ARCH_LIST", "TXT_ARCH_LIST"):
            sets[value.targets[0].id] = sorted(ast.literal_eval(value.value))
    source = (root / "dequant.py").read_text(encoding="utf-8")
    quant = sorted(set(re.findall(r"GGMLQuantizationType\.([A-Z0-9_]+)", source)))
    return {"image_architectures": sets.get("IMG_ARCH_LIST", []), "text_architectures": sets.get("TXT_ARCH_LIST", []),
            "native_quantizations": quant, "other_quantizations": "上游可能使用 NumPy 回退，性能与可用性需单独验证"}
