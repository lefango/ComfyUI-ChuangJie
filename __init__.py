"""创界 integration adapter; module copies are generated, never edited here."""
from .modules.visual_save.nodes import VisualSaveImage as _VisualSaveImage
from .modules.unified.runtime import (UnifiedManager as _UnifiedManager, AssetLoader, LoRAStage,
    TriggerStage, PromptStage, EditImageStage, MaskCompositeStage, compile_prompt)
from .modules.unified.core import (MANAGER, ASSET, PATCH, TRIGGERS, PROMPT_STAGE,
    EDIT_IMAGE_STAGE, MASK_COMPOSITE_STAGE)
from .modules.unified.model.api import register as _register_models
from .modules.unified.lora.api import register as _register_unified_lora
from .modules.unified.api import register as _register_unified
from .modules.visual_save.api import register as _register_visual_save


class VisualSaveImage(_VisualSaveImage):
    CATEGORY = "创界节点/图像工具"


class UnifiedManager(_UnifiedManager):
    CATEGORY = "创界节点/模型工具"


NODE_CLASS_MAPPINGS = {"VisualSaveImage": VisualSaveImage,
    MANAGER: UnifiedManager, ASSET: AssetLoader, PATCH: LoRAStage, TRIGGERS: TriggerStage,
    PROMPT_STAGE: PromptStage, EDIT_IMAGE_STAGE: EditImageStage, MASK_COMPOSITE_STAGE: MaskCompositeStage}
NODE_DISPLAY_NAME_MAPPINGS = {"VisualSaveImage": "创界保存图像",
    MANAGER: "创界集成控制台", ASSET: "一体节点 · 内部加载", PATCH: "一体节点 · 内部 LoRA",
    TRIGGERS: "一体节点 · 内部触发词", PROMPT_STAGE: "一体节点 · 内部提示词",
    EDIT_IMAGE_STAGE: "一体节点 · 内部图像编辑", MASK_COMPOSITE_STAGE: "一体节点 · 内部遮罩合成"}
WEB_DIRECTORY = "./web"
__version__ = "0.5.30"


def _register():
    from server import PromptServer
    server = PromptServer.instance
    # One registration per host instance, including a repeated package import.
    if getattr(server, "_chuangjie_registered", False):
        return
    prefixes = ("/lora-manager/v1", "/prompt-manager/v1", "/visual-save-image/v1", "/cj-unified-loader-test/v1")
    if any(getattr(route, "path", "").startswith(prefixes) for route in server.routes):
        raise RuntimeError("创界：发现独立节点扩展的重复路由。请停止 ComfyUI，将旧目录 ComfyUI-Visual-Save-Image、ComfyUI-Unified-Model-Loader-Test，或新目录 ComfyUI-ChuangJie-Visual-Save-Image、ComfyUI-ChuangJie-Integrated-Console 移出 custom_nodes，再重启。")
    _register_visual_save()
    import folder_paths
    _register_models(server, folder_paths)
    _register_unified_lora()
    _register_unified(server, folder_paths)
    server.add_on_prompt_handler(compile_prompt)
    server._chuangjie_registered = True


_register()
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
