"""Deterministic prompt merging. Never rewrites a user's original text."""
import json
import math
import re

MAX_JSON = 2 * 1024 * 1024
EMPTY_CONFIG = '{"schema":1,"presets":[]}'


class Invalid(ValueError):
    pass


class Conflict(Invalid):
    pass


class Missing(Invalid):
    pass


def text(value, label="文本", limit=200000, required=False):
    if not isinstance(value, str) or len(value) > limit:
        raise Invalid(f"{label}必须是文本，且不超过 {limit} 字符")
    if required and not value.strip():
        raise Invalid(f"{label}不能为空")
    return value


def config(value=EMPTY_CONFIG):
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_JSON:
            raise Invalid("节点配置过大")
        value = json.loads(value)
    if not isinstance(value, dict) or type(value.get("schema")) is not int or value["schema"] != 1:
        raise Invalid("不支持的节点配置版本")
    items = value.get("presets")
    if not isinstance(items, list) or len(items) > 256:
        raise Invalid("预设快照必须是列表，最多 256 项")
    result, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise Invalid("无效预设快照")
        key = text(item.get("id"), "来源 ID", 128, True)
        if key in seen:
            raise Invalid("节点内不能重复添加同一来源")
        seen.add(key)
        if type(item.get("revision")) is not int or item["revision"] < 1 or type(item.get("enabled")) is not bool:
            raise Invalid("无效 revision 或 enabled")
        result.append({"id": key, "revision": item["revision"], "enabled": item["enabled"],
                       "name": text(item.get("name"), "名称", 128, True),
                       "positive": text(item.get("positive")), "negative": text(item.get("negative"))})
    return {"schema": 1, "presets": result}


def split_terms(value):
    """Split only outside balanced structures. Malformed input stays opaque."""
    stack, terms, start, escaped = [], [], 0, False
    pairs = {"(": ")", "[": "]", "<": ">"}
    for i, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
        elif char in pairs:
            stack.append(pairs[char])
        elif char in ")]>":
            if not stack or stack.pop() != char:
                return [value.strip()] if value.strip() else [], ["括号不平衡，整段按原文保留"]
        elif char in ",，\n\r" and not stack:
            if value[start:i].strip():
                terms.append(value[start:i].strip())
            start = i + 1
    if stack or escaped:
        return [value.strip()] if value.strip() else [], ["括号或转义未闭合，整段按原文保留"]
    if value[start:].strip():
        terms.append(value[start:].strip())
    return terms, []


def ascii_lower(value):
    return value.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")


def match_key(term):
    original = ascii_lower(term.strip())
    value = term.strip()
    if any(c in value for c in "\\<>{}|"):
        return original, True
    # Iterative unwrap avoids recursion even with deeply nested prompts.
    wrappers = 0
    while value.startswith(("(", "[")):
        wrappers += 1
        if wrappers > 32:
            return original, True
        closing = ")" if value[0] == "(" else "]"
        depth, end = 0, -1
        for i, char in enumerate(value):
            if char == value[0]:
                depth += 1
            elif char == closing:
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end != len(value) - 1:
            return original, True
        inner = value[1:-1].strip()
        if value[0] == "(" and ":" in inner:
            candidate, weight = inner.rsplit(":", 1)
            if NUMBER.fullmatch(weight.strip()) and math.isfinite(float(weight)):
                inner = candidate.strip()
        # A nested weight is allowed; scheduling and grouped lists are not.
        parts, warnings = split_terms(inner)
        if warnings or len(parts) != 1:
            return original, True
        value = inner
    if not value or any(c in value for c in "():[],，\r\n"):
        return original, True
    return ascii_lower(value.strip()), False


def merge_side(user, extra, presets, side):
    user, extra = text(user), text(extra)
    terms, warnings = split_terms(user)
    seen = {match_key(t)[0]: "用户" for t in terms}
    warnings.extend(f"用户：复杂或特殊词条按完整结构匹配：{t}" for t in terms if match_key(t)[1])
    accepted, skipped, additions = [], [], []
    sources = [("上游追加", extra)] + [(p["name"], p[side]) for p in presets if p["enabled"]]
    for source, raw in sources:
        tokens, notes = split_terms(raw)
        warnings.extend(f"{source}：{note}" for note in notes)
        for term in tokens:
            key, opaque = match_key(term)
            if opaque:
                warnings.append(f"{source}：复杂或特殊词条按完整结构匹配：{term}")
            row = {"source": source, "text": term}
            if key in seen:
                skipped.append(dict(row, reason=f"与{seen[key]}重复"))
            else:
                seen[key] = source
                additions.append(term)
                accepted.append(row)
    result = user
    if additions:
        if not user.strip():
            result = ", ".join(additions)
        else:
            # Only treat a trailing delimiter as top-level after a valid parse.
            _, malformed = split_terms(user)
            suffix = ("" if user[-1:].isspace() else " ") if not malformed and user.rstrip(" \t").endswith((",", "，", "\n", "\r")) else ", "
            if not malformed and user.endswith(("\n", "\r")):
                suffix = ""
            result += suffix + ", ".join(additions)
    return {"text": result, "accepted": accepted, "skipped": skipped, "warnings": list(dict.fromkeys(warnings))}


def merge(positive="", negative="", config_value=EMPTY_CONFIG, positive_extra="", negative_extra=""):
    snapshot = config(config_value)
    return {"positive": merge_side(positive, positive_extra, snapshot["presets"], "positive"),
            "negative": merge_side(negative, negative_extra, snapshot["presets"], "negative")}
