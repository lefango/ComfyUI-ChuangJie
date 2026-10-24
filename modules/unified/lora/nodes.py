"""Native LoRA application with a single-file CPU weight cache per node."""
import hashlib
import inspect
import json
import logging
from .core import EMPTY_STATE, state, triggers
from .catalog import Catalog

_LOG = logging.getLogger(__name__)
_DIAGNOSTIC_KEY_LIMIT = 6
_RAW_COMPANION_SUFFIXES = (".alpha", ".dora_scale", ".reshape_weight", ".config")
_SIDE_RAW_PREFIXES = {
    "MODEL": ("lora_unet_", "lora_prior_unet_", "lora_transformer_", "lycoris_",
              "base_model.model.", "unet.base_model.model.", "model.",
              "diffusion_model.", "unet.", "transformer."),
    "CLIP": ("lora_te", "lora_prior_te", "text_encoder.", "text_encoder_2.",
             "text_encoders.", "hydit_clip.", "clip_", "clip.", "t5xxl"),
}


def catalog():
    import folder_paths
    return Catalog(folder_paths)


def _lora_key_maps(comfy_lora, model, clip):
    """Build the same combined key map as comfy.sd.load_lora_for_models."""
    model_map = {}
    clip_map = {}
    if model is not None:
        model_map = dict(comfy_lora.model_lora_keys_unet(model.model, {}))
    if clip is not None:
        clip_map = dict(comfy_lora.model_lora_keys_clip(clip.cond_stage_model, {}))
    key_map = dict(model_map)
    key_map.update(clip_map)
    # ComfyUI applies a shared key to both patchers when both maps resolve it to
    # the same target key. If the CLIP map overrides a different MODEL target,
    # match the native combined map and keep that key CLIP-only.
    model_map = {key: value for key, value in model_map.items()
                 if clip_map.get(key, value) == value}
    return key_map, model_map, clip_map


def _target_patches(loaded, key_map, include_config=False):
    """Select patches owned by one target, including LoRA-generated bias keys."""
    target_keys = set(key_map.values())
    target_keys.update(key[:-len(".weight")] + ".bias" for key in key_map.values()
                       if isinstance(key, str) and key.endswith(".weight"))
    if include_config:
        target_keys.update(key for key in loaded if isinstance(key, str) and key.endswith(".config"))
    return {key: value for key, value in loaded.items() if key in target_keys}


def _target_raw_roots(key_map):
    """Return architecture roots exposed by this target's native key map."""
    return {key.partition(".")[0] + "." for key in key_map
            if isinstance(key, str) and "." in key}


def _unmapped_target_raw_keys(weights, key_map, loaded_patches, target):
    """Report target-owned raw keys omitted by the current map without log capture."""
    target_prefixes = _SIDE_RAW_PREFIXES[target]
    other_target = "CLIP" if target == "MODEL" else "MODEL"
    other_prefixes = _SIDE_RAW_PREFIXES[other_target]
    target_roots = _target_raw_roots(key_map)
    loaded_keys = set(loaded_patches)
    unmatched = []
    for raw_key in weights:
        if not isinstance(raw_key, str) or raw_key.endswith(_RAW_COMPANION_SUFFIXES):
            continue
        parts = raw_key.split(".")
        source = next((".".join(parts[:i]) for i in range(len(parts), 0, -1)
                       if ".".join(parts[:i]) in key_map), None)
        if source is not None:
            target_key = key_map[source]
            possible = {target_key}
            if isinstance(target_key, str) and target_key.endswith(".weight"):
                possible.add(target_key[:-len(".weight")] + ".bias")
            if not possible.intersection(loaded_keys):
                unmatched.append(raw_key)
            continue
        if raw_key.startswith(other_prefixes):
            continue
        if raw_key.startswith(target_prefixes) or raw_key.startswith(tuple(target_roots)):
            unmatched.append(raw_key)
    return unmatched


def _key_sample(keys):
    values = sorted((str(key) for key in keys))
    sample = ", ".join(values[:_DIAGNOSTIC_KEY_LIMIT])
    if len(values) > _DIAGNOSTIC_KEY_LIMIT:
        sample += f"，另有 {len(values) - _DIAGNOSTIC_KEY_LIMIT} 个"
    return sample


def _report_target_result(filename, target, candidates, applied, unmatched_raw=()):
    candidate_keys = set(candidates)
    applied_keys = set(applied) & candidate_keys
    if not candidate_keys:
        raw_detail = (f"目标侧未映射原始权重键：{_key_sample(unmatched_raw)}。"
                      if unmatched_raw else "")
        raise RuntimeError(
            f"LoRA 文件“{filename}”在 {target} 目标没有匹配到兼容权重键；"
            f"{raw_detail}请检查所选模型架构及该 LoRA 的目标。"
        )
    if not applied_keys:
        raise RuntimeError(
            f"LoRA 文件“{filename}”在 {target} 目标匹配到 {len(candidate_keys)} 个目标补丁键，"
            f"但没有被目标接受；未应用键：{_key_sample(candidate_keys)}"
        )
    unmatched = candidate_keys - applied_keys
    if unmatched or unmatched_raw:
        details = []
        if unmatched:
            details.append(f"未接受 {len(unmatched)} 个映射补丁键（{_key_sample(unmatched)}）")
        if unmatched_raw:
            details.append(f"另有 {len(unmatched_raw)} 个目标侧原始权重键未映射（{_key_sample(unmatched_raw)}）")
        _LOG.warning(
            "LoRA 文件“%s”的 %s 目标部分命中：已应用 %d/%d 个映射补丁键（%s）；%s。"
            "另一侧权重不计入。",
            filename, target, len(applied_keys), len(candidate_keys), _key_sample(applied_keys), "；".join(details),
        )
    else:
        _LOG.info("LoRA 文件“%s”的 %s 目标已应用 %d 个映射补丁键。",
                  filename, target, len(applied_keys))


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
        signatures = {}
        connected_targets = "/".join(target for target, value in (("MODEL", model), ("CLIP", clip))
                                      if value is not None) or "MODEL/CLIP"
        for item in active:
            try:
                signatures[item["file"]] = files.signature(item["file"])
            except Exception as exc:
                raise RuntimeError(
                    f"预检 LoRA 文件“{item['file']}”时失败（目标 {connected_targets}）：{exc}"
                ) from exc
        if not active:
            self._cached = None
            return model, clip, ""
        for item in active:
            model_weight = item["strength_model"]
            clip_weight = item["strength_clip"] if clip is not None else 0
            if model_weight == 0 and clip_weight == 0:
                continue
            targets = []
            if model is not None and model_weight != 0:
                targets.append(("MODEL", model, model_weight))
            if clip is not None and clip_weight != 0:
                targets.append(("CLIP", clip, clip_weight))
            if not targets:
                continue
            target_label = "/".join(target for target, _, _ in targets)
            key = signatures[item["file"]]
            if self._cached is None or self._cached[0] != key:
                self._cached = None
                try:
                    import comfy.sd
                    import comfy.utils
                    load = comfy.utils.load_torch_file
                    metadata_supported = "return_metadata" in inspect.signature(load).parameters
                    loaded = load(key[0], safe_load=True,
                                  **({"return_metadata": True} if metadata_supported else {}))
                    weights, metadata = loaded if metadata_supported else (loaded, None)
                except Exception as exc:
                    raise RuntimeError(
                        f"加载 LoRA 文件“{item['file']}”失败（目标 {target_label}）：{exc}"
                    ) from exc
                self._cached = (key, weights, metadata)
            _, weights, metadata = self._cached
            try:
                import comfy.lora
                import comfy.lora_convert
                import comfy.sd
                metadata_supported = "lora_metadata" in inspect.signature(
                    comfy.sd.load_lora_for_models
                ).parameters
                patch_model = model if model is not None and model_weight != 0 else None
                patch_clip = clip if clip is not None and clip_weight != 0 else None
                key_map, model_map, clip_map = _lora_key_maps(comfy.lora, patch_model, patch_clip)
                converted = comfy.lora_convert.convert_lora(weights)
                loaded_patches = comfy.lora.load_lora(converted, key_map)
                model_patches = _target_patches(loaded_patches, model_map, include_config=True)
                # The native loader offers config patches to both patchers;
                # preserve that path while keeping tensor patches target-scoped.
                clip_patches = _target_patches(loaded_patches, clip_map, include_config=True)
                model_unmatched_raw = _unmapped_target_raw_keys(
                    converted, model_map, model_patches, "MODEL") if patch_model is not None else []
                clip_unmatched_raw = _unmapped_target_raw_keys(
                    converted, clip_map, clip_patches, "CLIP") if patch_clip is not None else []
            except Exception as exc:
                raise RuntimeError(
                    f"解析 LoRA 文件“{item['file']}”的 {target_label} 目标映射失败：{exc}"
                ) from exc

            target_patches = {"MODEL": model_patches, "CLIP": clip_patches}
            target_unmatched_raw = {"MODEL": model_unmatched_raw, "CLIP": clip_unmatched_raw}
            for target, _, _ in targets:
                if not target_patches[target]:
                    _report_target_result(item["file"], target, {}, (), target_unmatched_raw[target])

            results = []
            for target, target_model, strength in targets:
                try:
                    patched = target_model.clone()
                    applied = patched.add_patches(target_patches[target], strength)
                    if metadata_supported and metadata:
                        if target == "MODEL":
                            patched.set_attachments("lora_metadata", metadata)
                        else:
                            patched.patcher.set_attachments("lora_metadata", metadata)
                except Exception as exc:
                    raise RuntimeError(
                        f"应用 LoRA 文件“{item['file']}”到 {target} 目标失败：{exc}"
                    ) from exc
                results.append((target, patched, target_patches[target], applied))

            for target, _, candidates, applied in results:
                _report_target_result(item["file"], target, candidates, applied,
                                      target_unmatched_raw[target])
            for target, patched, _, _ in results:
                if target == "MODEL":
                    model = patched
                else:
                    clip = patched
        return model, clip, triggers(active)
