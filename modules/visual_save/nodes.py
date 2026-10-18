"""Keep native PNG conversion, metadata, counters and IMAGE pass-through."""
import threading
from .paths import component, target_path

_SAVE_LOCK = threading.RLock()


class VisualSaveImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "filename_prefix": ("STRING", {"default": "ComfyUI", "tooltip": "普通文件名前缀；分辨率和编号自动添加"}),
            "subfolder": ("STRING", {"default": "", "tooltip": "相对于 ComfyUI output 的文件夹，使用选择文件夹按钮设置"}),
        }, "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "图像/保存"
    DESCRIPTION = "选择 output 内的文件夹，保存 PNG 并预览实际保存的图片。"

    def save_images(self, images, filename_prefix="ComfyUI", subfolder="", prompt=None, extra_pnginfo=None):
        from nodes import SaveImage
        try:
            component(filename_prefix, "文件名前缀", prefix=True)
            if len(images.shape) != 4 or images.shape[0] < 1 or images.shape[1] < 1 or images.shape[2] < 1:
                raise ValueError("请输入非空的 IMAGE 图像批次")
            height, width = int(images.shape[1]), int(images.shape[2])
            with _SAVE_LOCK:
                root, destination, relative = target_path(subfolder)
                native = SaveImage()
                # Pass only the validated basename to native formatting. Folder names
                # containing % are literal and cannot turn into native placeholders.
                native.output_dir = str(destination)
                result = native.save_images(images, f"{filename_prefix}_{width}x{height}", prompt, extra_pnginfo)
                saved = []
                for entry in result["ui"]["images"]:
                    entry["subfolder"] = relative
                    saved.append({**entry, "width": width, "height": height})
                result["result"] = (images,)
                result["ui"]["visual_save"] = [{"images": saved, "subfolder": relative,
                    "filename_prefix": filename_prefix, "output_root": str(root), "absolute_path": str(destination)}]
                return result
        except PermissionError as exc:
            raise ValueError("保存失败：没有文件夹写入权限，请选择有权限的 output 子目录") from exc
        except OSError as exc:
            raise ValueError(f"保存失败：{exc.strerror or str(exc)}；请检查目录、磁盘空间和文件权限") from exc
