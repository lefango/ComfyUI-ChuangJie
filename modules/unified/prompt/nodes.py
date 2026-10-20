import hashlib
import json
import base64
import io
import re
from .core import EMPTY_CONFIG, merge, merge_selected, config as parse_config

LATENT_MAX_RESOLUTION = 16384


def make_empty_latent(width, height, batch_size):
    """Use ComfyUI's own empty-latent implementation for model-aware sampling."""
    try:
        import nodes as comfy_nodes
        latent_node = comfy_nodes.EmptyLatentImage()
        return latent_node.generate(width, height, batch_size)[0]
    except (ImportError, AttributeError) as exc:
        raise RuntimeError("当前环境未提供 ComfyUI 空 latent 节点") from exc


def validate_latent_settings(width, height, batch_size):
    for name, value in (("宽度", width), ("高度", height)):
        if type(value) is not int or value < 16 or value > LATENT_MAX_RESOLUTION:
            raise ValueError(f"latent{ name }需在 16 到 {LATENT_MAX_RESOLUTION} 像素之间")
        if value % 8:
            raise ValueError(f"latent{ name }需为 8 的倍数，请在分辨率选择中调整")
    if type(batch_size) is not int or not 1 <= batch_size <= 4096:
        raise ValueError("latent 批量数需在 1 到 4096 之间")


def validate_krea2_conditioning(conditioning):
    try:
        features = int(conditioning[0][0].shape[-1])
    except (IndexError, KeyError, AttributeError, TypeError, ValueError):
        features = None
    if features != 30720:
        actual = "无法识别" if features is None else str(features)
        raise ValueError(
            f"Krea2 专用模式收到 {actual} 维 CLIP 条件，要求 30720 维。"
            "请将 CLIPLoader 类型设为 krea2，并确保正负文本编码也使用这个 CLIP。"
        )


def execution_key(positive, negative, config, positive_extra="", negative_extra=""):
    return hashlib.sha256(json.dumps([positive, negative, config, positive_extra, negative_extra], ensure_ascii=False).encode()).hexdigest()


def krea_text_config(config_value):
    snapshot = parse_config(config_value)
    if snapshot.get("schema") != 2 or not snapshot.get("styles"):
        return None, config_value
    primary = snapshot["styles"][0]
    if not primary.get("image"):
        return None, config_value
    text_snapshot = dict(snapshot, styles=snapshot["styles"][1:], style_enabled=bool(snapshot["styles"][1:]))
    return primary, json.dumps(text_snapshot, ensure_ascii=False)


class PromptManager:
    CATEGORY = "提示词工具"
    FUNCTION = "execute"
    RETURN_TYPES = ("*", "*", "STRING", "STRING", "MODEL", "LATENT")
    RETURN_NAMES = ("正面输出", "负面输出", "正面文本", "负面文本", "风格参考模型", "空 latent")
    # ComfyUI retains cached UI in history only for output nodes. This also lets
    # users execute this text utility without attaching a temporary sink.
    OUTPUT_NODE = True
    DESCRIPTION = "融合提示词、预设和风格；输出正负条件/文本、风格参考模型及可选分辨率空 latent。Krea2 模式请连接 krea2 类型 CLIP。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "positive": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "negative": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "config": ("STRING", {"default": EMPTY_CONFIG, "multiline": True, "dynamicPrompts": False, "advanced": True}),
            "krea_enabled": ("BOOLEAN", {"default": False}),
            "krea_reference_key": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False, "advanced": True}),
            "krea_reference_data": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False, "advanced": True}),
            "text_output_enabled": ("BOOLEAN", {"default": False}),
            "text_output_user": ("BOOLEAN", {"default": True}),
            "text_output_extra": ("BOOLEAN", {"default": False}),
            "text_output_presets": ("BOOLEAN", {"default": False}),
            "text_output_styles": ("BOOLEAN", {"default": False}),
            "latent_width": ("INT", {"default": 1024, "min": 16, "max": LATENT_MAX_RESOLUTION, "step": 8}),
            "latent_height": ("INT", {"default": 1024, "min": 16, "max": LATENT_MAX_RESOLUTION, "step": 8}),
            "latent_batch_size": ("INT", {"default": 1, "min": 1, "max": 4096})},
            "optional": {"model": ("MODEL",), "vae": ("VAE",),
                         "positive_extra": ("STRING", {"forceInput": True}),
                         "negative_extra": ("STRING", {"forceInput": True}),
                         "clip": ("CLIP",)},
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"}}

    @staticmethod
    def _needs_conditioning(prompt, unique_id):
        if not isinstance(prompt, dict) or unique_id is None:
            return False
        try:
            import nodes as comfy_nodes
            class_mappings = comfy_nodes.NODE_CLASS_MAPPINGS
        except (ImportError, AttributeError):
            class_mappings = {}
        for target in prompt.values():
            target_inputs = target.get("inputs", {}) if isinstance(target, dict) else {}
            for input_name, link in target_inputs.items():
                if not isinstance(link, (list, tuple)) or len(link) < 2 or str(link[0]) != str(unique_id):
                    continue
                target_class = class_mappings.get(target.get("class_type"))
                if target_class is None:
                    continue
                try:
                    specs = target_class.INPUT_TYPES()
                except (AttributeError, TypeError):
                    continue
                for group in ("required", "optional"):
                    definition = specs.get(group, {}).get(input_name)
                    if isinstance(definition, (list, tuple)) and definition and definition[0] == "CONDITIONING":
                        return True
        return False

    def execute(self, positive="", negative="", config=EMPTY_CONFIG, positive_extra="", negative_extra="", clip=None,
                prompt=None, unique_id=None, text_output_enabled=False, text_output_user=True,
                text_output_extra=False, text_output_presets=False, text_output_styles=False,
                krea_enabled=False, krea_reference_key="", krea_reference_data="", model=None, vae=None,
                latent_width=1024, latent_height=1024, latent_batch_size=1):
        validate_latent_settings(latent_width, latent_height, latent_batch_size)
        latent = make_empty_latent(latent_width, latent_height, latent_batch_size)
        enabled = bool(krea_enabled)
        text_config = config
        primary_style = None
        if enabled:
            primary_style, text_config = krea_text_config(config)
            if primary_style:
                expected_key = f"{primary_style['id']}:{primary_style['revision']}:{primary_style['image']}"
                if krea_reference_key != expected_key:
                    raise ValueError("主风格封面尚未同步，请稍后重新执行")
                if not krea_reference_data:
                    raise ValueError("主风格封面尚未载入，请重新选择风格")
                # The primary style supplies the image. Later selected styles supply text.
        result = merge(positive, negative, text_config, positive_extra, negative_extra)
        positive_text = result["positive"]["text"]
        negative_text = result["negative"]["text"]
        if self._needs_conditioning(prompt, unique_id):
            if clip is None:
                if enabled:
                    raise ValueError("Krea2 专用模式需要 CLIPLoader 类型为 krea2 的 CLIP")
                raise ValueError("输出连接到条件输入时，请连接 CLIP")
            positive_output = clip.encode_from_tokens_scheduled(clip.tokenize(positive_text))
            negative_output = clip.encode_from_tokens_scheduled(clip.tokenize(negative_text))
            if enabled:
                validate_krea2_conditioning(positive_output)
                validate_krea2_conditioning(negative_output)
        else:
            positive_output, negative_output = positive_text, negative_text
        model_output = model
        if enabled and primary_style:
            if model is None or vae is None:
                raise ValueError("Krea2 专用模式需要连接 Krea2 模型和 VAE")
            if clip is None:
                raise ValueError("Krea2 专用模式需要连接 CLIPLoader 类型为 krea2 的 CLIP")
            try:
                encoded = krea_reference_data_data(krea_reference_data)
                import numpy as np
                import torch
                from PIL import Image
                from .vendor.krea2_style_transfer import Krea2StyleReference, Krea2StyleTransfer

                with Image.open(io.BytesIO(encoded)) as cover:
                    cover.load()
                    if cover.width > 8192 or cover.height > 8192 or cover.width * cover.height > 16_000_000:
                        raise ValueError("主风格封面尺寸过大")
                    pixels = np.asarray(cover.convert("RGB"), dtype=np.float32) / 255.0
                image = torch.from_numpy(pixels).unsqueeze(0)
                reference_latent, _preview, _debug = Krea2StyleReference().build(
                    vae, latent, image, "crop", "lanczos"
                )
                ref_conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(positive_text))
                validate_krea2_conditioning(ref_conditioning)
                model_output, _rf_reference, _debug = Krea2StyleTransfer().patch(
                    model, reference_latent, ref_conditioning, "recommended", 1.0, 0.65, 1.0, 1.06,
                    "flowturbo_pc", 0.5, 2.5, 1.04, 0.0, 1.0, 1.10, 0.85, "7-27"
                )
            except ValueError:
                raise
            except Exception as exc:
                raise RuntimeError(f"Krea2 风格参考处理失败：{exc}") from exc
        if text_output_enabled:
            selected = merge_selected(positive, negative, text_config, positive_extra, negative_extra,
                                      user=text_output_user, extra=text_output_extra,
                                      presets=text_output_presets, styles=text_output_styles)
            positive_text_output = selected["positive"]["text"]
            negative_text_output = selected["negative"]["text"]
        else:
            positive_text_output = negative_text_output = ""
        return {"ui": {"prompt_manager": [{"positive": result["positive"]["text"],
                    "negative": result["negative"]["text"],
                    "input_values": {"positive": positive, "negative": negative, "config": config,
                                     "krea_enabled": enabled,
                                     "text_output_enabled": text_output_enabled,
                                     "text_output_user": text_output_user, "text_output_extra": text_output_extra,
                                     "text_output_presets": text_output_presets, "text_output_styles": text_output_styles},
                    "input_key": execution_key(positive, negative, config, positive_extra, negative_extra)}]},
                "result": (positive_output, negative_output, positive_text_output, negative_text_output, model_output, latent)}


def krea_reference_data_data(value):
    if not isinstance(value, str) or len(value) > 1_500_000:
        raise ValueError("主风格封面无效或过大，请重新选择风格")
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", value)
    if not match:
        raise ValueError("主风格封面尚未载入或格式不支持")
    raw = base64.b64decode(match.group(2), validate=True)
    if len(raw) > 1_048_576:
        raise ValueError("主风格封面超过 1 MB")
    return raw
