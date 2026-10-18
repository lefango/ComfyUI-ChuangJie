"""All client paths are relative to ComfyUI's configured output directory."""
import os
import re
from pathlib import Path

_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", re.I)


def component(value, label="文件夹名称", prefix=False):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}不能为空")
    if len(value) > 180 or value in (".", "..") or value.endswith((".", " ")):
        raise ValueError(f"{label}过长，或以空格、点结尾")
    if any(ord(c) < 32 or c in '<>:"/\\|?*' for c in value) or _RESERVED.match(value):
        raise ValueError(f"{label}含无效字符、路径分隔符或系统保留名称")
    if prefix and "%" in value:
        raise ValueError("文件名前缀只支持普通文字，不支持 % 占位符")
    return value


def relative(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("保存文件夹必须是 output 内的相对路径")
    value = value.replace("\\", "/")
    if not value:
        return ""
    if value.startswith("/") or ":" in value:
        raise ValueError("只能选择 output 内的相对路径，不能使用绝对路径或盘符")
    parts = value.split("/")
    for part in parts:
        component(part)
    return "/".join(parts)


def root_path():
    import folder_paths
    return Path(folder_paths.get_output_directory()).resolve()


def target_path(value, *, must_exist=True):
    value = relative(value)
    root = root_path()
    candidate = root.joinpath(*value.split("/")) if value else root
    target = candidate.resolve()
    if not target.is_relative_to(root):
        raise ValueError("文件夹链接指向 output 外部，不能访问或保存")
    # Resolve every operation anew; do not trust the path selected in the browser.
    if must_exist and not target.is_dir():
        raise FileNotFoundError("保存文件夹不存在，请重新选择或新建")
    return root, target, value


def list_folders(value):
    root, target, value = target_path(value)
    directories = []
    with os.scandir(target) as entries:
        for entry in entries:
            try:
                if not entry.is_dir():
                    continue
                component(entry.name)
                child = "/".join(filter(None, (value, entry.name)))
                target_path(child)
                directories.append({"name": entry.name, "path": child})
            except (ValueError, OSError):
                # An inaccessible or out-of-root link must never become a choice.
                continue
    return {"path": value, "directories": sorted(directories, key=lambda x: x["name"].casefold()),
            "output_root": str(root), "absolute_path": str(target)}


def create_folder(value, name):
    component(name)
    _, parent, value = target_path(value)
    child = "/".join(filter(None, (value, name)))
    _, destination, _ = target_path(child, must_exist=False)
    # parent is canonical and checked, so a link alias cannot redirect mkdir.
    if destination != parent / name:
        raise ValueError("目标名称已被链接占用，请使用其他名称")
    destination.mkdir(exist_ok=False)
    target_path(child)
    return {"path": child}
