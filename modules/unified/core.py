"""Single-suite snapshots and an extensible, deterministic socket contract."""
import copy
import hashlib
import json
import re
from .model.core import Invalid, options, filename, cover_key, text
from .lora.core import state as lora_state

VERSION = "0.2.19"
EDIT_MIN_DIMENSION = 16
MANAGER = "CJUnifiedModelLoaderTest"
ASSET = "CJUnifiedAssetTest"
PATCH = "CJUnifiedLoRATest"
TRIGGERS = "CJUnifiedTriggersTest"
PROMPT_STAGE = "CJUnifiedPromptStageTest"
EDIT_IMAGE_STAGE = "CJUnifiedEditImageStageTest"
MASK_COMPOSITE_STAGE = "CJUnifiedMaskCompositeStageTest"
MODULES = {
    "model": {"label": "主模型", "type": "MODEL", "input": "model"},
    "clip": {"label": "CLIP", "type": "CLIP", "input": "clip"},
    "vae": {"label": "VAE", "type": "VAE", "input": "vae"},
    "lora": {"label": "LoRA", "type": "STRING", "input": None},
}


def empty_state():
    return {"version": 1, "modules": {
        k: {"source": "internal", "files": [], "file_names": [], "architecture": "", "options": {}, "name": "", "cover": None}
        for k in ("model", "clip", "vae")}, "lora": {"enabled": True, "entries": [], "preset": None},
        "preset": None, "name": "", "cover": None,
        "generation": {"enabled": True, "edit_image_id": "", "edit_image_width": 0, "edit_image_height": 0}}


EMPTY_JSON = json.dumps(empty_state(), ensure_ascii=False)


def parse_state(raw):
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > 2 * 1024 * 1024:
            raise Invalid("配置过大")
        try:
            raw = json.loads(raw)
        except (ValueError, RecursionError) as exc:
            raise Invalid("配置不是有效 JSON") from exc
    if not isinstance(raw, dict) or type(raw.get("version")) is not int or raw["version"] != 1:
        raise Invalid("一体节点配置版本无效，原配置已保留")
    out = empty_state()
    # The first generation-capable schema remains v1 so existing model/LoRA
    # workflows keep their saved contract. Missing generation means a legacy
    # loader-only node; a newly-created node uses empty_state() and generates.
    if "generation" not in raw:
        out["generation"]["enabled"] = False
    if raw.get("mode") not in (None, "separate") or raw.get("checkpoint"):
        raise Invalid("不支持旧 Checkpoint 模式配置，请重新分别配置主模型、CLIP 和 VAE")
    modules = raw.get("modules")
    if not isinstance(modules, dict):
        raise Invalid("功能模块配置无效")
    for key in ("model", "clip", "vae"):
        m = modules.get(key)
        if not isinstance(m, dict) or m.get("source") not in ("internal", "external", "off"):
            raise Invalid(f"{MODULES[key]['label']}来源无效")
        files = m.get("files", [])
        if not isinstance(files, list) or len(files) > (4 if key == "clip" else 1):
            raise Invalid("主模型和 VAE 最多一个文件，CLIP 最多四个编码器")
        files = [filename(f) for f in files]
        if len(files) != len(set(files)):
            raise Invalid("同一组件不能重复选择文件")
        names = m.get("file_names", [])
        if not isinstance(names, list) or len(names) not in (0, len(files)):
            raise Invalid("模型显示名称与文件数量不一致")
        out["modules"][key] = {"source": m["source"], "files": files, "options": options(m.get("options", {})),
            "name": text(m.get("name", "")), "cover": cover_key(m.get("cover")),
            "file_names": [text(n) for n in names], "architecture": text(m.get("architecture", ""), 80)}
    lora = raw.get("lora", {})
    if not isinstance(lora, dict) or type(lora.get("enabled")) is not bool:
        raise Invalid("LoRA 开关必须是布尔值")
    normalized = lora_state({"version": 1, "entries": lora.get("entries", []), "preset": lora.get("preset")})
    out["lora"] = dict(normalized, enabled=lora["enabled"])
    out["lora"].pop("version")
    out["name"] = text(raw.get("name", ""))
    out["cover"] = cover_key(raw.get("cover"))
    generation = raw.get("generation")
    if "generation" in raw:
        if not isinstance(generation, dict) or type(generation.get("enabled")) is not bool:
            raise Invalid("一体出图设置无效")
        image_id = generation.get("edit_image_id", "")
        if not isinstance(image_id, str) or (image_id and not re.fullmatch(r"[0-9a-f]{32}", image_id)):
            raise Invalid("待编辑图片 ID 无效")
        dimensions = {}
        for name in ("edit_image_width", "edit_image_height"):
            value = generation.get(name, 0)
            if type(value) is not int or value < 0 or value > 12000:
                raise Invalid("待编辑图片尺寸无效")
            dimensions[name] = value
        if bool(image_id) != bool(dimensions["edit_image_width"] and dimensions["edit_image_height"]):
            raise Invalid("待编辑图片及尺寸信息不完整")
        out["generation"] = {"enabled": generation["enabled"], "edit_image_id": image_id,
                             **dimensions}
    p = raw.get("preset")
    if p is not None:
        if not isinstance(p, dict) or type(p.get("revision")) is not int or p["revision"] < 1:
            raise Invalid("完整预设引用无效")
        out["preset"] = {"id": text(p.get("id"), 128), "revision": p["revision"],
                         "digest": text(p.get("digest", ""), 64)}
    return out


def ports(state):
    result = [{"id": k, "type": v["type"], "label": "模型" if k == "model" else v["label"]}
              for k, v in MODULES.items() if k != "lora" and state["modules"][k]["source"] != "off"]
    result.append({"id": "image", "type": "IMAGE", "label": "图像"})
    result.extend((
        {"id": "positive_conditioning", "type": "CONDITIONING", "label": "正面条件"},
        {"id": "negative_conditioning", "type": "CONDITIONING", "label": "负面条件"},
        {"id": "latent", "type": "LATENT", "label": "Latent"},
    ))
    return result


def inputs(state):
    return [{"id": k, "type": v["type"], "label": "外部模型" if k == "model" else f"外部 {v['label']}"}
            for k, v in MODULES.items() if k != "lora" and state["modules"][k]["source"] == "external"]


def content_digest(state):
    value = copy.deepcopy(state)
    value["preset"] = None
    # Preserve hashes for complete presets saved before the image-generation
    # fields existed. Disabled generation is the legacy behavior.
    if not value.get("generation", {}).get("enabled", False):
        value.pop("generation", None)
    # Empty optional metadata must not mark existing v1 workflows as modified.
    for module in value["modules"].values():
        for field in ("file_names", "architecture"):
            if not module.get(field):
                module.pop(field, None)
    def integers(v):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: integers(x) for k, x in v.items()}
        if isinstance(v, list):
            return [integers(x) for x in v]
        return v
    return hashlib.sha256(json.dumps(integers(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def clip_purpose(state):
    """Resolve automatic CLIP use from the snapshotted primary model, without loading weights."""
    chosen = state["modules"]["clip"]["options"]["clip_type"]
    if chosen != "auto":
        return {"type": chosen, "source": "手动选择", "message": ""}
    model = state["modules"]["model"]
    file = next(iter(model["files"]), "")
    if model["source"] != "internal" or not file:
        return {"type": None, "source": "", "message": "无法自动识别：请先启用并选择内部主模型，或手动选择 CLIP 用途。"}
    aliases = {"sd1": "stable_diffusion", "sd15": "stable_diffusion", "sd2": "stable_diffusion",
               "sdxl": "stable_diffusion", "stable_diffusion": "stable_diffusion", "sd3": "sd3",
               "flux": "flux", "flux2": "flux2", "krea2": "krea2", "lumina2": "lumina2",
               "z_image": "lumina2", "zimage": "lumina2", "qwen_image": "qwen_image",
               "wan": "wan", "hidream": "hidream", "chroma": "chroma", "hunyuan_video": "hunyuan_video"}
    def identify(value):
        normalized = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
        if normalized in aliases:
            return aliases[normalized]
        # Specific families precede broad ones, e.g. flux2 must never become flux.
        for pattern, result in ((r"krea_?2", "krea2"), (r"flux_?2", "flux2"),
                                (r"qwen_?image", "qwen_image"), (r"lumina_?2|z_?image", "lumina2"),
                                (r"sdxl|stable_diffusion_xl|stable_diffusion_v[12]|sd_?1_?5|sd_?2", "stable_diffusion"),
                                (r"sd_?3", "sd3"), (r"flux", "flux"), (r"wan(?:2[12])?", "wan"),
                                (r"hidream", "hidream"), (r"chroma", "chroma"), (r"hunyuan_video", "hunyuan_video")):
            if re.search(r"(?:^|_)" + "(?:" + pattern + ")" + r"(?:_|$)", normalized):
                return result
        return None
    for value, source in ((model.get("architecture", ""), "主模型架构"),
                          (model.get("name", "") + " " + file, "主模型名称")):
        resolved = identify(value)
        if resolved:
            return {"type": resolved, "source": source, "message": ""}
    return {"type": None, "source": "", "message": "无法自动识别主模型架构，请手动选择 CLIP 用途，或在主模型资料中填写架构标签。"}


def model_family(state):
    """Identify the selected model family without honoring a manual CLIP override."""
    model = state["modules"]["model"]
    aliases = {"sd1": "stable_diffusion", "sd15": "stable_diffusion", "sd2": "stable_diffusion",
               "sdxl": "stable_diffusion", "stable_diffusion": "stable_diffusion", "sd3": "sd3",
               "flux": "flux", "flux2": "flux2", "krea2": "krea2", "lumina2": "lumina2",
               "z_image": "lumina2", "zimage": "lumina2", "qwen_image": "qwen_image",
               "wan": "wan", "hidream": "hidream", "chroma": "chroma", "hunyuan_video": "hunyuan_video"}

    def identify(value):
        normalized = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
        if normalized in aliases:
            return aliases[normalized]
        patterns = ((r"krea_?2", "krea2"), (r"flux_?2", "flux2"),
                    (r"qwen_?image", "qwen_image"), (r"lumina_?2|z_?image", "lumina2"),
                    (r"sdxl|stable_diffusion_xl|stable_diffusion_v[12]|sd_?1_?5|sd_?2", "stable_diffusion"),
                    (r"sd_?3", "sd3"), (r"flux", "flux"), (r"wan(?:2[12])?", "wan"),
                    (r"hidream", "hidream"), (r"chroma", "chroma"), (r"hunyuan_video", "hunyuan_video"))
        for pattern, result in patterns:
            if re.search(r"(?:^|_)(?:" + pattern + r")(?:_|$)", normalized):
                return result
        return None

    file = next(iter(model.get("files", [])), "")
    for value in (model.get("architecture", ""), model.get("name", "") + " " + file):
        family = identify(value)
        if family:
            return family
    return None


def qwen_image_21_edit_capable(state):
    """Recognize the Qwen Image 2.1 model variant independently of its family."""
    model = state["modules"]["model"]
    for value in (model.get("architecture", ""), model.get("name", ""),
                  " ".join(model.get("files", []))):
        normalized = re.sub(r"[^a-z0-9]+", "_", str(value).lower()).strip("_")
        if re.search(r"(?:^|_)qwen_?image_?2_?1(?:_|$)", normalized):
            return True
    return False


def fitted_dimensions(width, height):
    """Fit edit images into 1080x1920 with each latent axis aligned to eight."""
    for label, value in (("宽度", width), ("高度", height)):
        if type(value) is not int or value < 1 or value > 12000:
            raise Invalid(f"待编辑图片{label}无效")
    scale = min(1.0, 1080 / width, 1920 / height)
    # Preserve the previous nearest-pixel fit when shrinking. In-bounds images
    # round down; the explicit 16-pixel PromptStage minimum is the only case
    # where alignment may enlarge a source shorter than that contract.
    align = int if scale == 1.0 else lambda value: int(value + 0.5)
    fitted_width = min(1080, max(EDIT_MIN_DIMENSION, align(width * scale / 8) * 8))
    fitted_height = min(1920, max(EDIT_MIN_DIMENSION, align(height * scale / 8) * 8))
    return fitted_width, fitted_height


def patch_config(state, target):
    # Display metadata and irrelevant branch strengths must not invalidate weights.
    entries = [{"file": i["file"], "enabled": True,
                "strength_model": i["strength_model"] if target == "model" else 0,
                "strength_clip": i["strength_clip"] if target == "clip" else 0}
               for i in state["lora"]["entries"] if i["enabled"] and i[f"strength_{target}"] != 0]
    return json.dumps({"version": 1, "entries": entries, "preset": None}, sort_keys=True)
