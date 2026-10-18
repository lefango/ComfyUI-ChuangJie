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
    if not isinstance(value, dict) or type(value.get("schema")) is not int or value["schema"] not in (1, 2):
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
    if value["schema"] == 1:
        return {"schema": 1, "presets": result}
    styles = value.get("styles")
    if not isinstance(styles, list) or len(styles) > 3:
        raise Invalid("最多选择 3 个风格")
    normalized, seen = [], set()
    for item in styles:
        if not isinstance(item, dict):
            raise Invalid("无效风格快照")
        key = text(item.get("id"), "风格 ID", 128, True)
        if key in seen or type(item.get("revision")) is not int or item["revision"] < 1:
            raise Invalid("风格重复或版本无效")
        seen.add(key)
        if item.get("text_type") not in ("tags", "paragraph"):
            raise Invalid("无效风格文本类型")
        normalized.append({"id": key, "revision": item["revision"], "name": text(item.get("name"), "风格名称", 128, True),
                           "positive": text(item.get("positive")), "negative": text(item.get("negative")), "text_type": item["text_type"]})
    if type(value.get("style_enabled")) is not bool or type(value.get("multi_select")) is not bool:
        raise Invalid("无效风格开关")
    if not value["multi_select"] and len(normalized) > 1:
        raise Invalid("单选模式只能选择一个风格")
    if value.get("style_order") not in ("user", "style", "krea"):
        raise Invalid("无效风格拼接方式")
    return {"schema": 2, "presets": result, "styles": normalized, "style_enabled": value["style_enabled"],
            "style_order": "style" if value["style_order"] == "krea" else value["style_order"], "multi_select": value["multi_select"]}


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
    output = {}
    for side, user, extra in (("positive", positive, positive_extra), ("negative", negative, negative_extra)):
        base = merge_side(user, extra, snapshot["presets"], side)
        if not snapshot.get("style_enabled") or not snapshot.get("styles"):
            output[side] = base
            continue
        tokens, _ = split_terms(base["text"])
        seen = {match_key(t)[0] for t in tokens}
        paragraphs = {base["text"].strip()} if base["text"].strip() else set()
        paragraphs.update(p[side].strip() for p in snapshot["presets"] if p["enabled"] and p[side].strip())
        paragraphs.update(v.strip() for v in (user, extra) if v.strip())
        additions = []
        for style in snapshot["styles"]:
            raw = style[side]
            if not raw.strip():
                continue
            parts, notes = ([raw], []) if style["text_type"] == "paragraph" else split_terms(raw)
            base["warnings"].extend(notes)
            for part in parts:
                paragraph = style["text_type"] == "paragraph"
                key = part.strip() if paragraph else match_key(part)[0]
                duplicate = key in (paragraphs if paragraph else seen)
                row = {"source": "风格：" + style["name"], "text": part}
                if duplicate:
                    base["skipped"].append(dict(row, reason="与更高优先级内容重复"))
                else:
                    (paragraphs if paragraph else seen).add(key)
                    additions.append(part)
                    base["accepted"].append(row)
        block = ", ".join(additions)
        if block:
            if snapshot["style_order"] == "style":
                base["text"] = block + (", " + base["text"] if base["text"].strip() else "")
            elif base["text"].strip():
                base["text"] += ", " + block
            else:
                base["text"] = block
        output[side] = base
    return output
