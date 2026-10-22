"""Versioned workflow snapshots. No ComfyUI/torch imports in the control plane."""
import json
import re
from pathlib import PurePosixPath

VERSION = "0.2.0"
MANAGER = "CJModelLoader"
ASSET = "CJModelAssetLoader"
KINDS = {"checkpoint": ("MODEL", "CLIP", "VAE"), "model": ("MODEL",), "clip": ("CLIP",), "vae": ("VAE",)}
LABELS = {"checkpoint": "Checkpoint", "model": "主模型", "clip": "CLIP", "vae": "VAE"}
EMPTY = {"version": 1, "slots": [], "ports": [], "groups": []}
EMPTY_JSON = json.dumps(EMPTY)
MAX_JSON = 512 * 1024


class Invalid(ValueError):
    pass


class Conflict(Invalid):
    pass


def text(value, limit=256):
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise Invalid("文字字段格式或长度不正确")
    return value.strip()


def filename(value):
    value = text(value, 2048).replace("\\", "/")
    if not value or value.startswith("/") or ":" in value or any(p in ("", ".", "..") for p in value.split("/")):
        raise Invalid("模型文件名必须是注册目录内的相对路径")
    if PurePosixPath(value).is_absolute():
        raise Invalid("不接受绝对模型路径")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise Invalid("槽位或组合标识无效")
    return value


def cover_key(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}\.png", value):
        raise Invalid("封面标识无效")
    return value


def options(value):
    if not isinstance(value, dict):
        raise Invalid("加载参数必须是对象")
    result = {}
    allowed = {"weight_dtype": ("default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"),
               "device": ("default", "cpu"), "dequant_dtype": ("default", "target", "float32", "float16", "bfloat16"),
               "patch_dtype": ("default", "target", "float32", "float16", "bfloat16")}
    for key, choices in allowed.items():
        result[key] = value.get(key, choices[0])
        if result[key] not in choices:
            raise Invalid(f"不支持的加载参数：{key}")
    result["clip_type"] = text(value.get("clip_type", "auto"), 80)
    if not re.fullmatch(r"[a-z0-9_]+", result["clip_type"]):
        raise Invalid("CLIP 用途无效")
    for key in ("output_model", "output_clip", "output_vae"):
        result[key] = value.get(key, True)
        if type(result[key]) is not bool:
            raise Invalid("Checkpoint 输出开关必须是布尔值")
    result["patch_on_device"] = value.get("patch_on_device", False)
    if type(result["patch_on_device"]) is not bool:
        raise Invalid("patch_on_device 必须是布尔值")
    return result


def parse_state(raw):
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > MAX_JSON:
            raise Invalid("节点配置过大")
        try:
            raw = json.loads(raw)
        except (ValueError, RecursionError) as exc:
            raise Invalid("节点配置不是有效 JSON") from exc
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise Invalid("节点配置版本无效，请使用相应插件版本")
    if not isinstance(raw.get("slots"), list):
        raise Invalid("模型槽位数量无效")
    groups, group_ids = [], set()
    values = raw.get("groups", [])
    if not isinstance(values, list):
        raise Invalid("组合配置无效")
    for g in values:
        if not isinstance(g, dict):
            raise Invalid("组合配置无效")
        key = identifier(g.get("id"))
        if key in group_ids:
            raise Invalid("组合标识重复")
        groups.append({"id": key, "name": text(g.get("name", key)), "architecture": text(g.get("architecture", ""), 80)})
        group_ids.add(key)
    slots, by_id = [], {}
    for s in raw["slots"]:
        if not isinstance(s, dict) or s.get("kind") not in KINDS:
            raise Invalid("模型类别无效")
        key, kind = identifier(s.get("id")), s["kind"]
        if key in by_id:
            raise Invalid("槽位标识重复")
        files = s.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= (4 if kind == "clip" else 1):
            raise Invalid("CLIP 槽位需 1–4 个编码器，其他槽位只接受一个文件")
        files = [filename(n) for n in files]
        if len(set(files)) != len(files):
            raise Invalid("同一 CLIP 组合不能重复选择同一编码器")
        group = text(s.get("group", ""), 80)
        if group and group not in group_ids:
            raise Invalid("模型引用了不存在的组件组合")
        item = {"id": key, "kind": kind, "files": files, "name": text(s.get("name", files[0])),
                "notes": text(s.get("notes", ""), 32000), "cover": cover_key(s.get("cover")),
                "architecture": text(s.get("architecture", ""), 80), "group": group,
                "options": options(s.get("options", {}))}
        slots.append(item)
        by_id[key] = item
    ports, seen, numbers = [], set(), {t: set() for t in ("MODEL", "CLIP", "VAE")}
    if not isinstance(raw.get("ports"), list):
        raise Invalid("端口映射无效")
    for p in raw["ports"]:
        if not isinstance(p, dict):
            raise Invalid("端口映射无效")
        slot, typ, number = p.get("slot"), p.get("type"), p.get("number")
        if slot not in by_id or typ not in KINDS[by_id[slot]["kind"]]:
            raise Invalid("输出类型与模型槽位不符")
        key = f"{slot}:{typ}"
        if p.get("id") != key or key in seen or type(number) is not int or number < 1 or number in numbers[typ]:
            raise Invalid("端口标识或编号重复／无效")
        ports.append({"id": key, "slot": slot, "type": typ, "number": number})
        seen.add(key)
        numbers[typ].add(number)
    expected = {f"{s['id']}:{t}" for s in slots for t in KINDS[s["kind"]]}
    if expected != seen:
        raise Invalid("槽位与端口映射不完整，已保留原配置")
    return {"version": 1, "slots": slots, "ports": ports, "groups": groups}


def warnings(snapshot):
    result = []
    for group in snapshot["groups"]:
        slots = [s for s in snapshot["slots"] if s["group"] == group["id"]]
        provided = {t for s in slots for t in KINDS[s["kind"]]}
        if "MODEL" in provided:
            missing = {"CLIP", "VAE"} - provided
            if missing:
                result.append(f"{group['name']}：未配置 {'、'.join(sorted(missing))}，请确认组件是否齐全")
        architectures = {s["architecture"].lower() for s in slots if s["architecture"]}
        if group["architecture"]:
            architectures.add(group["architecture"].lower())
        if len(architectures) > 1:
            result.append(f"{group['name']}：组件架构标签不同（{'、'.join(sorted(architectures))}），请确认搭配")
    return result
