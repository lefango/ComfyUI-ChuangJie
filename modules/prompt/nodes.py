import hashlib
import json
from .core import EMPTY_CONFIG, merge, merge_selected


def execution_key(positive, negative, config, positive_extra="", negative_extra=""):
    return hashlib.sha256(json.dumps([positive, negative, config, positive_extra, negative_extra], ensure_ascii=False).encode()).hexdigest()


class PromptManager:
    CATEGORY = "提示词工具"
    FUNCTION = "execute"
    RETURN_TYPES = ("*", "*", "STRING", "STRING")
    RETURN_NAMES = ("正面输出", "负面输出", "正面文本", "负面文本")
    # ComfyUI retains cached UI in history only for output nodes. This also lets
    # users execute this text utility without attaching a temporary sink.
    OUTPUT_NODE = True
    DESCRIPTION = "用户输入优先并合并预设与上游文本。前两路按下游自动输出正负文本或 CONDITIONING；另有可开关、可选来源的正负文本输出。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "positive": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "negative": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "config": ("STRING", {"default": EMPTY_CONFIG, "multiline": True, "dynamicPrompts": False, "advanced": True}),
            "text_output_enabled": ("BOOLEAN", {"default": False}),
            "text_output_user": ("BOOLEAN", {"default": True}),
            "text_output_extra": ("BOOLEAN", {"default": False}),
            "text_output_presets": ("BOOLEAN", {"default": False}),
            "text_output_styles": ("BOOLEAN", {"default": False})},
            "optional": {"positive_extra": ("STRING", {"forceInput": True}),
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
                text_output_extra=False, text_output_presets=False, text_output_styles=False):
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
                                     "text_output_enabled": text_output_enabled,
                                     "text_output_user": text_output_user, "text_output_extra": text_output_extra,
                                     "text_output_presets": text_output_presets, "text_output_styles": text_output_styles},
                    "input_key": execution_key(positive, negative, config, positive_extra, negative_extra)}]},
                "result": (positive_output, negative_output, positive_text_output, negative_text_output)}
