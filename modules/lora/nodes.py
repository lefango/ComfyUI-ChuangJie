"""Native LoRA application with a single-file CPU weight cache per node."""
import hashlib
import inspect
import json
from .core import EMPTY_STATE, state, triggers
from .catalog import Catalog


def catalog():
    import folder_paths
    return Catalog(folder_paths)


class LoRAManager:
    CATEGORY = "LoRA 管理器"
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "触发词")
    DESCRIPTION = "按顺序加载多个原生 LoRA；管理公共分类、封面和预设；触发词随工作流保存。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",),
                             "config": ("STRING", {"default": EMPTY_STATE, "multiline": True,
                                                     "dynamicPrompts": False, "advanced": True,
                                                     "tooltip": "随工作流保存的配置快照，由管理窗口维护"})},
                "optional": {"clip": ("CLIP",)}}

    @classmethod
    def VALIDATE_INPUTS(cls, config):
        try:
            snapshot = state(config)
            files = catalog()
            for item in snapshot["entries"]:
                if item["enabled"]:
                    files.resolve(item["file"])
            return True
        except (ValueError, OSError) as exc:
            return str(exc)

    @classmethod
    def IS_CHANGED(cls, config, **kwargs):
        snapshot = state(config)
        files = catalog()
        signatures = [files.signature(i["file"]) for i in snapshot["entries"] if i["enabled"]]
        return hashlib.sha256(json.dumps([snapshot, signatures], sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def __init__(self):
        self._cached = None

    def load(self, model, config=EMPTY_STATE, clip=None):
        snapshot = state(config)
        active = [i for i in snapshot["entries"] if i["enabled"]]
        files = catalog()
        # Preflight every reference before modifying any model, including zero weights.
        signatures = {i["file"]: files.signature(i["file"]) for i in active}
        if not active:
            self._cached = None
            return model, clip, ""
        import comfy.sd
        import comfy.utils
        load = comfy.utils.load_torch_file
        apply = comfy.sd.load_lora_for_models
        metadata_supported = "return_metadata" in inspect.signature(load).parameters
        apply_metadata = "lora_metadata" in inspect.signature(apply).parameters
        for item in active:
            model_weight = item["strength_model"]
            clip_weight = item["strength_clip"] if clip is not None else 0
            if model_weight == 0 and clip_weight == 0:
                continue
            key = signatures[item["file"]]
            if self._cached is None or self._cached[0] != key:
                self._cached = None
                loaded = load(key[0], safe_load=True, **({"return_metadata": True} if metadata_supported else {}))
                weights, metadata = loaded if metadata_supported else (loaded, None)
                self._cached = (key, weights, metadata)
            _, weights, metadata = self._cached
            kwargs = {"lora_metadata": metadata} if apply_metadata else {}
            model, clip = apply(model, clip, weights, model_weight, clip_weight, **kwargs)
        return model, clip, triggers(active)
