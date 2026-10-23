import hashlib
import json
from .core import EMPTY_CONFIG, merge, merge_selected

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


def execution_key(positive, negative, config, positive_extra="", negative_extra=""):
    return hashlib.sha256(json.dumps([positive, negative, config, positive_extra, negative_extra], ensure_ascii=False).encode()).hexdigest()


class PromptManager:
    CATEGORY = "提示词工具"
    FUNCTION = "execute"
    RETURN_TYPES = ("*", "*", "STRING", "STRING", "MODEL", "LATENT")
    RETURN_NAMES = ("正面输出", "负面输出", "正面文本", "负面文本", "模型", "空 latent")
    # ComfyUI retains cached UI in history only for output nodes. This also lets
    # users execute this text utility without attaching a temporary sink.
    OUTPUT_NODE = True
    DESCRIPTION = "融合提示词、预设和文字风格；输出正负条件/文本、原模型及可选分辨率空 latent。"

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
        # Keep legacy inputs in the signature so saved workflows still load;
        # style covers are no longer used as Krea2 generation references.
        result = merge(positive, negative, config, positive_extra, negative_extra)
        positive_text = result["positive"]["text"]
        negative_text = result["negative"]["text"]
        if self._needs_conditioning(prompt, unique_id):
            if clip is None:
                raise ValueError("输出连接到条件输入时，请连接 CLIP")
            positive_output = clip.encode_from_tokens_scheduled(clip.tokenize(positive_text))
            negative_output = clip.encode_from_tokens_scheduled(clip.tokenize(negative_text))
        else:
            positive_output, negative_output = positive_text, negative_text
        model_output = model
        if text_output_enabled:
            selected = merge_selected(positive, negative, config, positive_extra, negative_extra,
                                      user=text_output_user, extra=text_output_extra,
                                      presets=text_output_presets, styles=text_output_styles)
            positive_text_output = selected["positive"]["text"]
            negative_text_output = selected["negative"]["text"]
        else:
            positive_text_output = negative_text_output = ""
        return {"ui": {"prompt_manager": [{"positive": result["positive"]["text"],
                    "negative": result["negative"]["text"],
                    "input_values": {"positive": positive, "negative": negative, "config": config,
                                     "krea_enabled": False,
                                     "text_output_enabled": text_output_enabled,
                                     "text_output_user": text_output_user, "text_output_extra": text_output_extra,
                                     "text_output_presets": text_output_presets, "text_output_styles": text_output_styles},
                    "input_key": execution_key(positive, negative, config, positive_extra, negative_extra)}]},
                "result": (positive_output, negative_output, positive_text_output, negative_text_output, model_output, latent)}
