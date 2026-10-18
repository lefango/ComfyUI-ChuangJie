"""���� integration adapter; module copies are generated, never edited here."""
from .modules.lora.nodes import LoRAManager as _LoRAManager
from .modules.prompt.nodes import PromptManager as _PromptManager
from .modules.visual_save.nodes import VisualSaveImage as _VisualSaveImage
from .modules.lora.api import register as _register_lora
from .modules.prompt.api import register as _register_prompt
from .modules.visual_save.api import register as _register_visual_save


class LoRAManager(_LoRAManager):
    CATEGORY = "����ڵ�/ģ�͹���"


class PromptManager(_PromptManager):
    CATEGORY = "����ڵ�/��ʾ�ʹ���"


class VisualSaveImage(_VisualSaveImage):
    CATEGORY = "����ڵ�/ͼ�񹤾�"


NODE_CLASS_MAPPINGS = {"LoRAManager": LoRAManager, "PromptManager": PromptManager, "VisualSaveImage": VisualSaveImage}
NODE_DISPLAY_NAME_MAPPINGS = {"LoRAManager": "LoRA ������", "PromptManager": "��ʾ�ʹ�����", "VisualSaveImage": "���ӻ�����ͼ��"}
WEB_DIRECTORY = "./web"
__version__ = "0.3.3"


def _register():
    from server import PromptServer
    server = PromptServer.instance
    # One registration per host instance, including a repeated package import.
    if getattr(server, "_chuangjie_registered", False):
        return
    prefixes = ("/lora-manager/v1", "/prompt-manager/v1", "/visual-save-image/v1")
    if any(getattr(route, "path", "").startswith(prefixes) for route in server.routes):
        raise RuntimeError("���磺���־ɶ���ģ��·�ɡ���ֹͣ ComfyUI���� ComfyUI-LoRA-Manager��ComfyUI-Prompt-Manager �� ComfyUI-Visual-Save-Image �Ƴ� custom_nodes����������")
    _register_lora()
    _register_prompt()
    _register_visual_save()
    server._chuangjie_registered = True


_register()
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
