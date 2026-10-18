"""创界 integration adapter; module copies are generated, never edited here."""
from .modules.lora.nodes import LoRAManager as _LoRAManager
from .modules.prompt.nodes import PromptManager as _PromptManager
from .modules.lora.api import register as _register_lora
from .modules.prompt.api import register as _register_prompt


class LoRAManager(_LoRAManager):
    CATEGORY = "创界节点/模型工具"


class PromptManager(_PromptManager):
    CATEGORY = "创界节点/提示词工具"


NODE_CLASS_MAPPINGS = {"LoRAManager": LoRAManager, "PromptManager": PromptManager}
NODE_DISPLAY_NAME_MAPPINGS = {"LoRAManager": "LoRA 管理器", "PromptManager": "提示词管理器"}
WEB_DIRECTORY = "./web"
__version__ = "0.1.0"


def _register():
    from server import PromptServer
    server = PromptServer.instance
    # One registration per host instance, including a repeated package import.
    if getattr(server, "_chuangjie_registered", False):
        return
    prefixes = ("/lora-manager/v1", "/prompt-manager/v1")
    if any(getattr(route, "path", "").startswith(prefixes) for route in server.routes):
        raise RuntimeError("创界：发现旧独立模块路由。请停止 ComfyUI，将 ComfyUI-LoRA-Manager 和 ComfyUI-Prompt-Manager 移出 custom_nodes，再重启。")
    _register_lora()
    _register_prompt()
    server._chuangjie_registered = True


_register()
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
