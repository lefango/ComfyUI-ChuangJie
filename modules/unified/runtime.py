"""Compile the unified node into native ComfyUI model, prompt and sampling tasks."""
import copy
import hashlib
import io
import json
import math
import re

from .core import (MANAGER, ASSET, PATCH, TRIGGERS, PROMPT_STAGE, EDIT_IMAGE_STAGE,
                   MASK_COMPOSITE_STAGE, EMPTY_JSON, Invalid, parse_state, ports,
                   patch_config, clip_purpose, model_family,
                   qwen_image_21_edit_capable, fitted_dimensions)
from .model.runtime import AssetLoader
from .lora.nodes import LoRAManager
from .lora.core import state as lora_state, triggers


EMPTY_PROMPT_CONFIG = '{"schema":2,"presets":[],"styles":[],"style_enabled":false,"style_order":"user","multi_select":false}'
EMPTY_SAMPLER_CONFIG = '{"seed":0,"steps":20,"cfg":7,"sampler_name":"euler","scheduler":"normal","denoise":1,"control_after_generate":"randomize"}'
MAX_SEED = (1 << 53) - 1


def task_id(manager, suffix):
    return "__cjum__" + hashlib.sha256(f"{manager}\0{suffix}".encode()).hexdigest()[:32]


def _number(value, label, minimum, maximum, integer=False):
    if integer:
        if type(value) is not int or not minimum <= value <= maximum:
            raise Invalid(f"{label}须为 {minimum} 到 {maximum} 之间的整数")
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise Invalid(f"{label}须为 {minimum} 到 {maximum} 之间的数字")
    return float(value)


def sampler_settings(raw):
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > 64 * 1024:
            raise Invalid("K 采样器设置过大")
        try:
            raw = json.loads(raw)
        except (ValueError, RecursionError) as exc:
            raise Invalid("K 采样器设置不是有效 JSON") from exc
    if not isinstance(raw, dict):
        raise Invalid("K 采样器设置无效")
    defaults = json.loads(EMPTY_SAMPLER_CONFIG)
    value = dict(defaults, **raw)
    seed = _number(value.get("seed"), "种子", 0, MAX_SEED, integer=True)
    steps = _number(value.get("steps"), "步数", 1, 1000, integer=True)
    cfg = _number(value.get("cfg"), "CFG", 0, 100)
    denoise = _number(value.get("denoise"), "降噪强度", 0, 1)
    sampler = value.get("sampler_name")
    scheduler = value.get("scheduler")
    if not isinstance(sampler, str) or not re.fullmatch(r"[A-Za-z0-9_+-]{1,64}", sampler):
        raise Invalid("采样器名称无效")
    if not isinstance(scheduler, str) or not re.fullmatch(r"[A-Za-z0-9_+-]{1,64}", scheduler):
        raise Invalid("调度器名称无效")
    try:
        import nodes as comfy_nodes
        sampler_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("KSampler")
        required = sampler_cls.INPUT_TYPES().get("required", {}) if sampler_cls else {}
        choices = {}
        for key in ("sampler_name", "scheduler"):
            spec = required.get(key)
            if isinstance(spec, (list, tuple)) and spec and isinstance(spec[0], (list, tuple)):
                choices[key] = set(spec[0])
        if "sampler_name" in choices and sampler not in choices["sampler_name"]:
            raise Invalid("当前 ComfyUI 不支持此采样器，请重新选择")
        if "scheduler" in choices and scheduler not in choices["scheduler"]:
            raise Invalid("当前 ComfyUI 不支持此调度器，请重新选择")
    except ImportError:
        pass
    return {"seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler,
            "scheduler": scheduler, "denoise": denoise}


def _dimensions(width, height, label="latent"):
    result = []
    for name, value in (("宽度", width), ("高度", height)):
        value = _number(value, f"{label}{name}", 16, 16384, integer=True)
        if value % 8:
            raise Invalid(f"{label}{name}需为 8 的倍数")
        result.append(value)
    return result[0], result[1]


def _krea_style_selected(prompt_config):
    if not isinstance(prompt_config, str):
        return False
    try:
        config = json.loads(prompt_config)
    except (ValueError, RecursionError):
        return False
    styles = config.get("styles") if isinstance(config, dict) else None
    return bool(isinstance(styles, list) and styles and isinstance(styles[0], dict) and styles[0].get("image"))


def compile_prompt(data):
    original = data.get("prompt")
    if not isinstance(original, dict):
        return data
    managers = {k: n for k, n in original.items() if isinstance(n, dict) and n.get("class_type") == MANAGER}
    if not managers:
        return data
    prompt = copy.deepcopy(original)
    replacements = {}
    try:
        for mid, manager in managers.items():
            source_inputs = manager.get("inputs", {})
            state = parse_state(source_inputs.get("config", EMPTY_JSON))
            refs = {}

            def add(suffix, node_type, values):
                key = task_id(mid, suffix)
                if key in prompt:
                    raise Invalid("内部任务标识冲突")
                prompt[key] = {"class_type": node_type, "inputs": values,
                               "_meta": {"title": f"一体节点 #{mid} · {suffix}", "manager": str(mid)}}
                return key

            demanded = set()
            output_ports = ports(state)
            for node in original.values():
                if not isinstance(node, dict):
                    continue
                for value in node.get("inputs", {}).values():
                    if isinstance(value, (list, tuple)) and len(value) == 2 and str(value[0]) == str(mid):
                        if type(value[1]) is not int or not 0 <= value[1] < len(output_ports):
                            raise Invalid("连线引用了不存在的一体节点输出，请重新应用配置")
                        demanded.add(output_ports[value[1]]["id"])

            generation = state["generation"]
            should_generate = generation["enabled"] or "image" in demanded
            if should_generate:
                for key in ("model", "clip", "vae"):
                    if state["modules"][key]["source"] == "off":
                        raise Invalid(f"一体出图需要启用 {key.upper()} 模块")
                    demanded.add(key)

            for key in ("model", "clip", "vae"):
                if key not in demanded:
                    continue
                module = state["modules"][key]
                if module["source"] == "external":
                    ref = source_inputs.get(key)
                    if not isinstance(ref, (list, tuple)) or len(ref) != 2 or not isinstance(ref[0], str) or type(ref[1]) is not int:
                        raise Invalid(f"请连接外部 {key.upper()} 输入")
                    refs[key] = list(ref)
                elif module["source"] == "internal":
                    if not module["files"]:
                        raise Invalid(f"请为 {key.upper()} 选择文件，或切换为外部接入／关闭")
                    options = dict(module["options"])
                    if key == "clip" and options["clip_type"] == "auto":
                        purpose = clip_purpose(state)
                        if not purpose["type"]:
                            raise Invalid(purpose["message"])
                        options["clip_type"] = purpose["type"]
                    task = add(key, ASSET, {"kind": key, "files": json.dumps(module["files"], ensure_ascii=False),
                                            "options_json": json.dumps(options, sort_keys=True)})
                    refs[key] = [task, ("model", "clip", "vae").index(key)]

            if state["lora"]["enabled"]:
                for key in ("model", "clip"):
                    config = patch_config(state, key)
                    if key in refs and json.loads(config)["entries"]:
                        task = add("lora-" + key, PATCH, {"config": config, key: refs[key]})
                        refs[key] = [task, 0 if key == "model" else 1]
                if "triggers" in demanded:
                    config = json.dumps({"version": 1, "entries": state["lora"]["entries"], "preset": None}, ensure_ascii=False)
                    refs["triggers"] = [add("triggers", TRIGGERS, {"config": config}), 0]

            for index, output in enumerate(output_ports):
                if output["id"] in refs:
                    replacements[(str(mid), index)] = refs[output["id"]]

            if should_generate:
                settings = sampler_settings(source_inputs.get("sampling_config", EMPTY_SAMPLER_CONFIG))
                width = source_inputs.get("latent_width", 1024)
                height = source_inputs.get("latent_height", 1024)
                batch_size = source_inputs.get("latent_batch_size", 1)
                edit_id = generation.get("edit_image_id", "")
                edit_ref = None
                edit_mask_enabled = False
                qwen_edit_enabled = qwen_image_21_edit_capable(state) and bool(edit_id)
                if qwen_edit_enabled:
                    try:
                        import nodes as comfy_nodes
                        available_nodes = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
                    except ImportError:
                        available_nodes = {}
                    if "TextEncodeQwenImage21" not in available_nodes:
                        raise Invalid("当前 ComfyUI 核心缺少 TextEncodeQwenImage21，无法执行 Qwen Image 2.1 图像编辑；请升级 ComfyUI 核心")

                if qwen_edit_enabled:
                    token = source_inputs.get("edit_image_token", "")
                    has_mask = source_inputs.get("edit_has_mask", False)
                    if not isinstance(token, str) or not token:
                        raise Invalid("已选择待编辑图片，但本次排队没有准备图像令牌，请重新排队")
                    if type(has_mask) is not bool:
                        raise Invalid("待编辑图片遮罩状态无效")
                    source_width = generation["edit_image_width"]
                    source_height = generation["edit_image_height"]
                    if not source_width or not source_height:
                        raise Invalid("待编辑图片尺寸缺失，请在图像编辑中重新选择")
                    width, height = fitted_dimensions(source_width, source_height)
                    edit_task = add("edit-image", EDIT_IMAGE_STAGE, {"image_token": token,
                        "width": width, "height": height, "has_mask": has_mask,
                        "reference_data": source_inputs.get("qwen_reference_data", "")})
                    edit_ref = [edit_task, 1]
                    latent_ref = None
                    if has_mask:
                        edit_mask_enabled = True
                else:
                    width, height = _dimensions(width, height)
                    if type(batch_size) is not int or not 1 <= batch_size <= 4096:
                        raise Invalid("latent 批量数须为 1 到 4096 之间")
                    empty_task = add("empty-latent", "EmptyLatentImage", {
                        "width": width, "height": height, "batch_size": batch_size})
                    latent_ref = [empty_task, 0]

                prompt_config = source_inputs.get("prompt_config", EMPTY_PROMPT_CONFIG)
                # Krea2 style-reference processing is automatic when a selected
                # style has a cover. Text-only styles stay in the normal prompt path.
                krea_enabled = model_family(state) == "krea2" and _krea_style_selected(prompt_config)
                prompt_task = add("prompt", PROMPT_STAGE, {
                    "positive": source_inputs.get("positive", ""),
                    "negative": source_inputs.get("negative", ""),
                    "config": prompt_config,
                    "krea_enabled": krea_enabled,
                    "text_output_enabled": source_inputs.get("text_output_enabled", False),
                    "text_output_user": source_inputs.get("text_output_user", True),
                    "text_output_extra": source_inputs.get("text_output_extra", False),
                    "text_output_presets": source_inputs.get("text_output_presets", False),
                    "text_output_styles": source_inputs.get("text_output_styles", False),
                    "krea_reference_key": source_inputs.get("krea_reference_key", ""),
                    "krea_reference_data": source_inputs.get("krea_reference_data", ""),
                    "latent_width": max(16, width),
                    "latent_height": max(16, height),
                    "latent_batch_size": batch_size,
                    "model": refs["model"], "clip": refs["clip"], "vae": refs["vae"],
                    **({"positive_extra": ", ".join(part for part in (
                        str(source_inputs.get("positive_extra", "")).strip(),
                        triggers(state["lora"]["entries"]) if state["lora"]["enabled"] else "",
                    ) if part)} if source_inputs.get("positive_extra") or (state["lora"]["enabled"] and triggers(state["lora"]["entries"])) else {}),
                    **({"negative_extra": source_inputs["negative_extra"]} if "negative_extra" in source_inputs else {}),
                })
                qwen_task = None
                if qwen_edit_enabled:
                    qwen_inputs = {"clip": refs["clip"], "vae": refs["vae"],
                                   "prompt": [prompt_task, 2], "negative_prompt": [prompt_task, 3],
                                   "resolution": 0, "images.image_1": edit_ref}
                    if source_inputs.get("qwen_reference_data"):
                        qwen_inputs["images.image_2"] = [edit_task, 4]
                    qwen_task = add("qwen-image-21", "TextEncodeQwenImage21", qwen_inputs)
                sampler_task = add("ksampler", "KSampler", {
                    "model": [prompt_task, 4], "seed": settings["seed"], "steps": settings["steps"],
                    "cfg": settings["cfg"], "sampler_name": settings["sampler_name"],
                    "scheduler": settings["scheduler"],
                    "positive": [qwen_task, 0] if qwen_task else [prompt_task, 0],
                    "negative": [qwen_task, 1] if qwen_task else [prompt_task, 1],
                    "latent_image": [qwen_task, 2] if qwen_task else latent_ref,
                    "denoise": settings["denoise"]})
                decode_task = add("vae-decode", "VAEDecode", {"samples": [sampler_task, 0], "vae": refs["vae"]})
                add("sample-preview", "PreviewImage", {"images": [decode_task, 0]})
                if qwen_edit_enabled and edit_mask_enabled:
                    final_task = add("mask-composite", MASK_COMPOSITE_STAGE, {
                        "original": [edit_task, 0], "generated": [decode_task, 0], "mask": [edit_task, 2]})
                    final_ref = [final_task, 0]
                else:
                    final_ref = [decode_task, 0]
                add("final-preview", "PreviewImage", {"images": final_ref})
                image_index = next(i for i, output in enumerate(output_ports) if output["id"] == "image")
                replacements[(str(mid), image_index)] = final_ref
            del prompt[mid]

        def resolve(ref, seen=None):
            if not (isinstance(ref, (list, tuple)) and len(ref) == 2 and isinstance(ref[0], str) and ref[0] in managers):
                return ref
            key = (ref[0], ref[1])
            seen = set() if seen is None else seen
            if key in seen or key not in replacements:
                raise Invalid("外部组件连线形成循环或引用关闭的输出")
            return resolve(replacements[key], seen | {key})

        for node in prompt.values():
            for name, value in node.get("inputs", {}).items():
                node["inputs"][name] = resolve(value)
        return dict(data, prompt=prompt)
    except Exception as exc:
        failed = copy.deepcopy(original)
        for mid in managers:
            failed_inputs = failed[mid].get("inputs")
            if not isinstance(failed_inputs, dict):
                failed_inputs = {}
            failed_inputs["config"] = json.dumps({"preprocess_error": str(exc)}, ensure_ascii=False)
            failed[mid]["inputs"] = failed_inputs
        return dict(data, prompt=failed)


class UnifiedManager:
    CATEGORY = "创界/模型工具"
    DESCRIPTION = "单节点管理模型、LoRA、提示词、K 采样、VAE 解码与图像编辑。"
    FUNCTION = "load"
    # The console's real ports are state-dependent and created by the frontend.
    # Keep wildcard placeholders so a failed prompt expansion can still validate
    # links and reach VALIDATE_INPUTS; successful prompts remove this node first.
    RETURN_TYPES = ("*", "*", "*", "*")
    RETURN_NAMES = ("output_0", "output_1", "output_2", "output_3")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
                    "config": ("STRING", {"default": EMPTY_JSON, "multiline": True, "dynamicPrompts": False}),
                    "positive": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
                    "negative": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
                    "prompt_config": ("STRING", {"default": EMPTY_PROMPT_CONFIG, "multiline": True, "dynamicPrompts": False}),
                    "text_output_enabled": ("BOOLEAN", {"default": False}),
                    "text_output_user": ("BOOLEAN", {"default": True}),
                    "text_output_extra": ("BOOLEAN", {"default": False}),
                    "text_output_presets": ("BOOLEAN", {"default": False}),
                    "text_output_styles": ("BOOLEAN", {"default": False}),
                    "latent_width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                    "latent_height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                    "latent_batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
                    "sampling_config": ("STRING", {"default": EMPTY_SAMPLER_CONFIG, "multiline": False, "dynamicPrompts": False})},
                "optional": {"model": ("MODEL",), "clip": ("CLIP",), "vae": ("VAE",)},
                "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID",
                           "edit_image_token": "STRING", "edit_has_mask": "BOOLEAN",
                           "qwen_reference_data": "STRING",
                           "krea_reference_key": "STRING", "krea_reference_data": "STRING"}}

    @classmethod
    def VALIDATE_INPUTS(cls, config):
        try:
            return "一体节点配置未展开：" + json.loads(config).get("preprocess_error", "请重启后端以启用提交处理器")
        except Exception:
            return "一体节点配置损坏，原配置已保留"

    def load(self, **kwargs):
        raise Invalid("一体节点未展开，已停止执行")


class PromptStage:
    CATEGORY = "创界/临时测试/内部"
    FUNCTION = "execute"
    RETURN_TYPES = ("*", "*", "STRING", "STRING", "MODEL", "LATENT")
    RETURN_NAMES = ("正面条件", "负面条件", "正面文本", "负面文本", "风格参考模型", "空 latent")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"positive": ("STRING", {"default": "", "multiline": True}),
                             "negative": ("STRING", {"default": "", "multiline": True}),
                             "config": ("STRING", {"default": EMPTY_PROMPT_CONFIG}),
                             "krea_enabled": ("BOOLEAN", {"default": False}),
                             "text_output_enabled": ("BOOLEAN", {"default": False}),
                             "text_output_user": ("BOOLEAN", {"default": True}),
                             "text_output_extra": ("BOOLEAN", {"default": False}),
                             "text_output_presets": ("BOOLEAN", {"default": False}),
                             "text_output_styles": ("BOOLEAN", {"default": False}),
                             "krea_reference_key": ("STRING", {"default": ""}),
                             "krea_reference_data": ("STRING", {"default": ""}),
                             "latent_width": ("INT", {"default": 1024, "min": 16, "max": 16384}),
                             "latent_height": ("INT", {"default": 1024, "min": 16, "max": 16384}),
                             "latent_batch_size": ("INT", {"default": 1, "min": 1, "max": 4096})},
                "optional": {"model": ("MODEL",), "clip": ("CLIP",), "vae": ("VAE",),
                             "positive_extra": ("STRING", {"forceInput": True}),
                             "negative_extra": ("STRING", {"forceInput": True})},
                "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"}}

    def execute(self, positive="", negative="", config=EMPTY_PROMPT_CONFIG,
                positive_extra="", negative_extra="", model=None, clip=None, vae=None,
                krea_enabled=False, krea_reference_key="", krea_reference_data="",
                text_output_enabled=False, text_output_user=True, text_output_extra=False,
                text_output_presets=False, text_output_styles=False,
                latent_width=1024, latent_height=1024, latent_batch_size=1,
                prompt=None, unique_id=None):
        try:
            # Use the bundled prompt implementation in both standalone and
            # assembled installs; it is the version paired with this runtime.
            from ..prompt.nodes import PromptManager as prompt_class
        except (ImportError, ValueError):
            try:
                from .prompt.nodes import PromptManager as prompt_class
            except ImportError:
                import nodes as comfy_nodes
                prompt_class = comfy_nodes.NODE_CLASS_MAPPINGS.get("PromptManager")
                if prompt_class is None:
                    raise Invalid("内置提示词模块未安装")
        result = prompt_class().execute(
            positive=positive, negative=negative, config=config,
            positive_extra=positive_extra, negative_extra=negative_extra,
            model=model, clip=clip, vae=vae, krea_enabled=bool(krea_enabled),
            text_output_enabled=bool(text_output_enabled), text_output_user=bool(text_output_user),
            text_output_extra=bool(text_output_extra), text_output_presets=bool(text_output_presets),
            text_output_styles=bool(text_output_styles),
            krea_reference_key=krea_reference_key, krea_reference_data=krea_reference_data,
            latent_width=latent_width, latent_height=latent_height,
            latent_batch_size=latent_batch_size, prompt=prompt, unique_id=unique_id)
        return result["result"]


class EditImageStage:
    CATEGORY = "创界/临时测试/内部"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "MASK", "IMAGE")
    RETURN_NAMES = ("原图", "采样图", "原遮罩", "采样遮罩", "参考图")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image_token": ("STRING",), "width": ("INT",), "height": ("INT",), "has_mask": ("BOOLEAN",)},
                "optional": {"reference_data": ("STRING", {"default": ""})}}

    def load(self, image_token, width, height, has_mask, reference_data=""):
        from PIL import Image, ImageOps
        import numpy as np
        import torch
        from .image_edit import consume_pending_image
        if (type(width) is not int or type(height) is not int
                or width < 16 or height < 16 or width % 8 or height % 8):
            raise Invalid("待编辑图片宽高需为不小于 16 的 8 的倍数")
        if width > 1080 or height > 1920:
            raise Invalid("待编辑图片尺寸超出 1080×1920 编辑上限")
        image_bytes, mask_bytes = consume_pending_image(image_token)
        try:
            with Image.open(io.BytesIO(image_bytes)) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
                image.load()
            if image.width < 1 or image.height < 1 or image.width > 12000 or image.height > 12000 or image.width * image.height > 40_000_000:
                raise Invalid("待编辑图片尺寸超过限制")
            sampling = image if image.size == (width, height) else image.resize((width, height), Image.Resampling.LANCZOS)
            sampling_tensor = torch.from_numpy(np.asarray(sampling, dtype=np.float32).copy() / 255.0).unsqueeze(0)
            if mask_bytes is not None:
                with Image.open(io.BytesIO(mask_bytes)) as opened:
                    mask = opened.convert("L")
                    mask.load()
                if mask.size != image.size:
                    raise Invalid("待编辑图片遮罩尺寸与原图不一致")
                sampling_mask = mask if mask.size == (width, height) else mask.resize((width, height), Image.Resampling.BILINEAR)
                sampling_mask_tensor = torch.from_numpy(np.asarray(sampling_mask, dtype=np.float32).copy() / 255.0).unsqueeze(0)
            else:
                sampling_mask_tensor = torch.zeros((1, height, width), dtype=torch.float32)
            if bool(has_mask) != (mask_bytes is not None):
                raise Invalid("待编辑图片遮罩状态已变化，请重新排队")
            reference_tensor = None
            if reference_data:
                import base64
                match = re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", reference_data)
                if not match:
                    raise Invalid("Qwen 风格参考图数据无效")
                try:
                    raw_reference = base64.b64decode(match.group(1), validate=True)
                    if not raw_reference or len(raw_reference) > 20 * 1024 * 1024:
                        raise ValueError("参考图大小无效")
                    with Image.open(io.BytesIO(raw_reference)) as opened:
                        reference = ImageOps.exif_transpose(opened).convert("RGB")
                        reference.load()
                    if reference.width > 12000 or reference.height > 12000 or reference.width * reference.height > 40_000_000:
                        raise ValueError("参考图尺寸超过限制")
                    reference_tensor = torch.from_numpy(np.asarray(reference, dtype=np.float32).copy() / 255.0).unsqueeze(0)
                except Invalid:
                    raise
                except Exception as exc:
                    raise Invalid(f"Qwen 风格参考图读取失败：{exc}") from exc
            # Keep the source and mask at the fitted edit resolution: retaining
            # full-size tensors would undo input compression during compositing.
            return sampling_tensor, sampling_tensor, sampling_mask_tensor, sampling_mask_tensor, reference_tensor
        except Invalid:
            raise
        except Exception as exc:
            raise Invalid(f"待编辑图片读取失败：{exc}") from exc


class MaskCompositeStage:
    CATEGORY = "创界/临时测试/内部"
    FUNCTION = "compose"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("最终图像",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"original": ("IMAGE",), "generated": ("IMAGE",), "mask": ("MASK",)}}

    def compose(self, original, generated, mask):
        import torch
        import torch.nn.functional as functional
        if original.ndim != 4 or generated.ndim != 4 or mask.ndim != 3:
            raise Invalid("图像或遮罩张量结构无效")
        batch, height, width, channels = original.shape
        if batch < 1 or height < 1 or width < 1 or channels < 1:
            raise Invalid("原图张量尺寸无效")
        if generated.shape[0] not in (1, batch) or generated.shape[3] != channels:
            raise Invalid("生成图通道或批量与原图不一致")
        if mask.shape[0] not in (1, batch):
            raise Invalid("遮罩批量与待编辑图片批量不一致")
        generated = generated.to(device=original.device, dtype=original.dtype)
        mask = mask.to(device=original.device, dtype=original.dtype)
        generated = generated.permute(0, 3, 1, 2)
        if generated.shape[-2:] != (height, width):
            generated = functional.interpolate(generated, size=(height, width), mode="bilinear", align_corners=False)
        generated = generated.permute(0, 2, 3, 1)
        if generated.shape[0] == 1 and batch > 1:
            generated = generated.expand(batch, -1, -1, -1)
        mask = mask.unsqueeze(1)
        if mask.shape[-2:] != (height, width):
            mask = functional.interpolate(mask, size=(height, width), mode="bilinear", align_corners=False)
        mask = mask.permute(0, 2, 3, 1).clamp(0, 1)
        if mask.shape[0] == 1 and batch > 1:
            mask = mask.expand(batch, -1, -1, -1)
        output = original * (1 - mask) + generated * mask
        return (torch.clamp(output, 0, 1),)


class LoRAStage(LoRAManager):
    CATEGORY = "创界/临时测试/内部"
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("模型", "CLIP")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("STRING",)}, "optional": {"model": ("MODEL",), "clip": ("CLIP",)}}

    def load(self, config, model=None, clip=None):
        return super().load(model=model, clip=clip, config=config)[:2]


class TriggerStage:
    CATEGORY = "创界/临时测试/内部"
    FUNCTION = "load"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("触发词",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("STRING",)}}

    def load(self, config):
        return (triggers(lora_state(config)["entries"]),)
