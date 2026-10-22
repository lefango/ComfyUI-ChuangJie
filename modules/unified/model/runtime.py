"""Compile manager nodes into independently scheduled, typed loader tasks."""
import copy
import hashlib
import importlib.util
import inspect
import json
import logging
from .core import ASSET, MANAGER, EMPTY_JSON, Invalid, KINDS, parse_state, options, filename
from .catalog import Catalog, scaled_fp8


def task_id(manager_id, slot_id):
    return "__cjml__" + hashlib.sha256((str(manager_id) + "\0" + slot_id).encode()).hexdigest()[:32]


def compile_prompt(data):
    """Transactional graph rewrite before native validation; also supports raw API prompts."""
    original = data.get("prompt", {})
    if not isinstance(original, dict):
        return data
    managers = {key: value for key, value in original.items() if isinstance(value, dict) and value.get("class_type") == MANAGER}
    if not managers:
        return data
    prompt = copy.deepcopy(original)
    replacements = {}
    try:
        for manager_id, manager in managers.items():
            state = parse_state(manager.get("inputs", {}).get("config", EMPTY_JSON))
            by_slot = {s["id"]: s for s in state["slots"]}
            groups = {g["id"]: g for g in state["groups"]}
            for s in state["slots"]:
                key = task_id(manager_id, s["id"])
                if key in prompt:
                    raise Invalid("内部加载任务标识冲突")
                opts = dict(s["options"])
                if s["kind"] == "clip" and opts["clip_type"] == "auto":
                    architecture = s["architecture"] or groups.get(s["group"], {}).get("architecture", "")
                    if architecture:
                        opts["clip_type"] = architecture.lower()
                prompt[key] = {"class_type": ASSET, "inputs": {
                    "kind": s["kind"], "files": json.dumps(s["files"], ensure_ascii=False),
                    "options_json": json.dumps(opts, sort_keys=True),
                    # Only actual loading options affect native execution caching.
                }, "_meta": {"title": f"模型加载 #{manager_id} · {s['name']}", "manager": str(manager_id), "slot": s["id"]}}
            for index, p in enumerate(state["ports"]):
                replacements[(str(manager_id), index)] = [task_id(manager_id, p["slot"]), ("MODEL", "CLIP", "VAE").index(p["type"])]
            del prompt[manager_id]
        for node in prompt.values():
            for name, value in node.get("inputs", {}).items():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in managers:
                    if type(value[1]) is not int or (value[0], value[1]) not in replacements:
                        raise Invalid("连线引用了不存在的模型输出端口")
                    node["inputs"][name] = replacements[(value[0], value[1])]
        return dict(data, prompt=prompt)
    except Exception as exc:
        logging.warning("[模型加载] 配置展开失败：%s", exc)
        # The server swallows hook exceptions. Leave a sentinel that fails validation
        # instead of allowing a partially transformed graph to enter the queue.
        failed = copy.deepcopy(original)
        for key in managers:
            failed[key]["inputs"] = {"config": json.dumps({"preprocess_error": str(exc)}, ensure_ascii=False)}
        return dict(data, prompt=failed)


def paths_catalog():
    import folder_paths
    return Catalog(folder_paths)


def decode_task(kind, files, options_json):
    if kind not in KINDS:
        raise Invalid("模型类别无效")
    values = json.loads(files)
    if not isinstance(values, list) or not 1 <= len(values) <= (4 if kind == "clip" else 1):
        raise Invalid("加载文件数量无效")
    values = [filename(n) for n in values]
    opts = options(json.loads(options_json))
    paths = [paths_catalog().resolve(kind, n) for n in values]
    gguf = any(p.suffix.lower() == ".gguf" for p in paths)
    if gguf and kind not in ("model", "clip"):
        raise Invalid("GGUF 仅用于支持的 UNet／文本编码器，Checkpoint 与 VAE 请使用原生格式")
    if gguf and importlib.util.find_spec("gguf") is None:
        raise Invalid("GGUF 依赖未安装，请用 ComfyUI 的 Python 安装本插件 requirements.txt；原生格式不受影响")
    if gguf and kind == "clip" and any(p.suffix.lower() != ".gguf" and scaled_fp8(p) for p in paths):
        raise Invalid("GGUF 与 scaled-FP8 编码器不能混合在一个 CLIP 槽位中；请选择非缩放量化编码器或分开加载")
    return values, opts, paths, gguf


def clip_type(opts, paths):
    import comfy.sd
    name = opts["clip_type"]
    if name == "auto":
        raise Invalid("无法可靠判断 CLIP 用途。请在槽位中选择 FLUX、FLUX2、SDXL 等架构／用途，或填写组件组合架构")
    name = {"sdxl": "stable_diffusion", "sd1": "stable_diffusion", "sd15": "stable_diffusion", "sd2": "stable_diffusion"}.get(name, name)
    value = getattr(comfy.sd.CLIPType, name.upper(), None)
    if value is None:
        raise Invalid(f"当前 ComfyUI 不支持 CLIP 用途 {name}，请更新 ComfyUI 或修正槽位用途")
    return value


def load_asset(kind, files, options_json):
    names, opts, paths, gguf = decode_task(kind, files, options_json)
    logging.info("[模型加载] 实际加载 %s：%s", kind, names)
    import comfy.sd
    import comfy.utils
    import comfy.model_management
    import folder_paths
    import torch
    embeds = folder_paths.get_folder_paths("embeddings")
    if gguf:
        from .vendor.gguf_core import nodes as upstream
        if kind == "clip":
            typ = clip_type(opts, paths)
            data = upstream.CLIPLoaderGGUF().load_data([str(p) for p in paths])
            # The upstream custom ops cannot mix scaled-FP8 and GGUF. load_data
            # rejects that combination explicitly, before allocating the encoder.
            if opts["device"] == "cpu":
                operations = upstream.GGMLOps
                clip = comfy.sd.load_text_encoder_state_dicts(state_dicts=data, clip_type=typ,
                    model_options={"custom_operations": operations, "load_device": torch.device("cpu"),
                                   "offload_device": torch.device("cpu"), "initial_device": torch.device("cpu")}, embedding_directory=embeds)
                clip.patcher = upstream.GGUFModelPatcher.clone(clip.patcher)
            else:
                clip = upstream.CLIPLoaderGGUF().load_patcher([str(p) for p in paths], typ, data)
            return None, clip, None
        ops = upstream.GGMLOps()
        for name in ("dequant_dtype", "patch_dtype"):
            value = opts[name]
            setattr(ops.Linear, name, None if value == "default" else value if value == "target" else getattr(torch, value))
        sd, extra = upstream.gguf_sd_loader(str(paths[0]))
        kwargs = {"metadata": extra.get("metadata", {})} if "metadata" in inspect.signature(comfy.sd.load_diffusion_model_state_dict).parameters else {}
        model = comfy.sd.load_diffusion_model_state_dict(sd, model_options={"custom_operations": ops}, **kwargs)
        if model is None:
            raise Invalid("GGUF 主模型架构未被当前 ComfyUI／内置适配器支持")
        model = upstream.GGUFModelPatcher.clone(model)
        model.patch_on_device = opts["patch_on_device"]
        return model, None, None
    if kind == "checkpoint":
        result = tuple(comfy.sd.load_checkpoint_guess_config(str(paths[0]), output_model=opts["output_model"], output_vae=opts["output_vae"], output_clip=opts["output_clip"], embedding_directory=embeds)[:3])
        for index, key in enumerate(("model", "clip", "vae")):
            if opts["output_" + key] and result[index] is None:
                raise Invalid(f"Checkpoint 不包含 {key.upper()}，请选择独立文件或外部接入／关闭")
        return result
    if kind == "model":
        model_options = {}
        if opts["weight_dtype"] != "default":
            model_options["dtype"] = getattr(torch, opts["weight_dtype"].replace("fp8_", "float8_").replace("_fast", ""))
            if opts["weight_dtype"].endswith("_fast"):
                model_options["fp8_optimizations"] = True
        model = comfy.sd.load_diffusion_model(str(paths[0]), model_options=model_options)
        if model is None:
            raise Invalid("当前 ComfyUI 无法识别此主模型结构")
        return model, None, None
    if kind == "clip":
        opt = {} if opts["device"] == "default" else {"load_device": torch.device("cpu"), "offload_device": torch.device("cpu")}
        clip = comfy.sd.load_clip(ckpt_paths=[str(p) for p in paths], embedding_directory=embeds,
                                 clip_type=clip_type(opts, paths), model_options=opt)
        return None, clip, None
    kwargs = {"return_metadata": True} if "return_metadata" in inspect.signature(comfy.utils.load_torch_file).parameters else {}
    data = comfy.utils.load_torch_file(str(paths[0]), safe_load=True, **kwargs)
    weights, metadata = data if kwargs else (data, None)
    vae_args = {"metadata": metadata} if "metadata" in inspect.signature(comfy.sd.VAE).parameters else {}
    vae = comfy.sd.VAE(sd=weights, **vae_args)
    vae.throw_exception_if_invalid()
    return None, None, vae


class ModelManager:
    CATEGORY = "模型加载"
    DESCRIPTION = "可视化配置多种模型。仅执行被工作流使用的槽位；资料与工作流状态独立保存。"
    FUNCTION = "load"
    # The frontend builds exactly the configured sockets. The prompt hook
    # rewrites the manager away before ComfyUI validates executable nodes.
    RETURN_TYPES = ()
    RETURN_NAMES = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("STRING", {"default": EMPTY_JSON, "multiline": True, "dynamicPrompts": False})}}

    @classmethod
    def VALIDATE_INPUTS(cls, config):
        try:
            value = json.loads(config)
            return "模型加载配置未能展开：" + value.get("preprocess_error", "提交前处理钩子未启用，请重启 ComfyUI")
        except Exception:
            return "模型加载配置损坏，请打开管理窗口检查"

    def load(self, config):
        raise Invalid("模型加载配置未展开，已停止执行")


class AssetLoader:
    CATEGORY = "模型加载/内部"
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("模型", "CLIP", "VAE")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"kind": ("STRING",), "files": ("STRING",), "options_json": ("STRING",)}}

    @classmethod
    def IS_CHANGED(cls, kind, files, options_json):
        values, opts, paths, gguf = decode_task(kind, files, options_json)
        return hashlib.sha256(json.dumps([kind, opts, [paths_catalog().signature(kind, n) for n in values]], sort_keys=True).encode()).hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, kind, files, options_json):
        try:
            decode_task(kind, files, options_json)
            return True
        except Exception as exc:
            return str(exc)

    def load(self, kind, files, options_json):
        return load_asset(kind, files, options_json)
