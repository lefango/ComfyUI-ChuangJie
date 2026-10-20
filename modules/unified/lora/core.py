"""Versioned workflow snapshots, shared by execution and the HTTP service."""
import json
import math
import re

MAX_ENTRIES = 512
MAX_JSON = 2 * 1024 * 1024


class Invalid(ValueError):
    pass


class Conflict(Invalid):
    pass


class Missing(Invalid):
    pass


def text(value, label, limit=8192, required=False):
    if not isinstance(value, str) or len(value) > limit:
        raise Invalid(f"{label}必须是长度不超过 {limit} 的文本")
    if required and not value.strip():
        raise Invalid(f"{label}不能为空")
    return value.strip()


def filename(value):
    value = text(value, "LoRA 文件名", 1024, True).replace("\\", "/")
    if any(p in ("", ".", "..") for p in value.split("/")) or re.search(r"[:\x00-\x1f]", value):
        raise Invalid("LoRA 文件名必须是注册目录内的相对路径")
    return value


def strength(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Invalid("强度必须为数值")
    if not math.isfinite(value) or not -100 <= value <= 100:
        raise Invalid("强度必须在 -100 至 100 之间")
    return float(value)


def state(value):
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_JSON:
            raise Invalid("节点配置过大")
        try:
            value = json.loads(value)
        except (ValueError, RecursionError) as exc:
            raise Invalid("节点配置不是有效 JSON") from exc
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise Invalid("节点配置版本无效（需要 version: 1）")
    entries = value.get("entries")
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise Invalid(f"entries 必须为列表，最多 {MAX_ENTRIES} 项")
    result, seen = [], set()
    for item in entries:
        if not isinstance(item, dict):
            raise Invalid("LoRA 配置项必须为对象")
        name = filename(item.get("file"))
        if name in seen:
            raise Invalid(f"LoRA 重复：{name}")
        seen.add(name)
        enabled = item.get("enabled", True)
        if type(enabled) is not bool:
            raise Invalid("enabled 必须为布尔值")
        result.append({"file": name, "enabled": enabled,
                       "strength_model": strength(item.get("strength_model", 1.0)),
                       "strength_clip": strength(item.get("strength_clip", 1.0)),
                       "trigger": text(item.get("trigger", ""), "触发词"),
                       "name": text(item.get("name", name), "名称", 1024)})
    preset = value.get("preset")
    if preset is not None:
        if not isinstance(preset, dict) or type(preset.get("revision")) is not int or preset["revision"] < 1:
            raise Invalid("预设快照信息无效")
        preset = {"id": text(preset.get("id"), "预设 ID", 128, True),
                  "name": text(preset.get("name", ""), "预设名称", 256), "revision": preset["revision"]}
    return {"version": 1, "entries": result, "preset": preset}


def triggers(entries):
    seen, result = set(), []
    for item in entries:
        word = item["trigger"].strip()
        if item["enabled"] and word and word not in seen:
            seen.add(word)
            result.append(word)
    return ", ".join(result)


EMPTY_STATE = '{"version":1,"entries":[],"preset":null}'
