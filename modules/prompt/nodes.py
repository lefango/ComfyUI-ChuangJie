import hashlib
import json
from .core import EMPTY_CONFIG, merge


def execution_key(positive, negative, config, positive_extra="", negative_extra=""):
    return hashlib.sha256(json.dumps([positive, negative, config, positive_extra, negative_extra], ensure_ascii=False).encode()).hexdigest()


class PromptManager:
    CATEGORY = "提示词工具"
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("正面提示词", "负面提示词")
    # ComfyUI retains cached UI in history only for output nodes. This also lets
    # users execute this text utility without attaching a temporary sink.
    OUTPUT_NODE = True
    DESCRIPTION = "用户输入优先；按顺序合并预设快照与上游文本，不改变公共预设。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "positive": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "negative": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "config": ("STRING", {"default": EMPTY_CONFIG, "multiline": True, "dynamicPrompts": False, "advanced": True})},
            "optional": {"positive_extra": ("STRING", {"forceInput": True}),
                         "negative_extra": ("STRING", {"forceInput": True})}}

    def execute(self, positive="", negative="", config=EMPTY_CONFIG, positive_extra="", negative_extra=""):
        result = merge(positive, negative, config, positive_extra, negative_extra)
        return {"ui": {"prompt_manager": [{"positive": result["positive"]["text"],
                    "negative": result["negative"]["text"],
                    "input_values": {"positive": positive, "negative": negative, "config": config},
                    "input_key": execution_key(positive, negative, config, positive_extra, negative_extra)}]},
                "result": (result["positive"]["text"], result["negative"]["text"])}
