# 创界 · ComfyUI-ChuangJie

**中英双语 | 简单安装 | 可读源码**

创界提供 LoRA 管理、提示词管理和可视化保存图像三个 ComfyUI 节点。当前版本 **0.2.1**。

## 界面预览 | Interface preview

以下为插件在 ComfyUI 中的实际运行截图；LoRA 卡片和提示词条目是用于展示的演示资料。

**节点入口：在“创界节点”分类下选择管理工具。**

<p align="center"><img src="https://raw.githubusercontent.com/lefango/ComfyUI-ChuangJie/main/docs/images/node-categories.jpg" width="850" alt="创界节点分类入口" /></p>

**LoRA 管理：浏览卡片、分类和当前启用项。**

<p align="center"><img src="https://raw.githubusercontent.com/lefango/ComfyUI-ChuangJie/main/docs/images/lora-manager.jpg" width="850" alt="LoRA 管理器界面" /></p>

**提示词管理：可视化编辑正面与负面提示词、管理预设。**

<p align="center"><img src="https://raw.githubusercontent.com/lefango/ComfyUI-ChuangJie/main/docs/images/prompt-manager.jpg" width="850" alt="提示词管理器界面" /></p>

These are screenshots of the plugin running in ComfyUI. LoRA cards and prompt entries are demo data.

## 新手先看：成品还是源码？

| 你想做什么 | 下载什么 | 说明 |
| --- | --- | --- |
| **只想安装使用** | [成品：ComfyUI-ChuangJie-0.2.1.zip](https://github.com/lefango/ComfyUI-ChuangJie/raw/refs/heads/main/releases/ComfyUI-ChuangJie-0.2.1.zip) | 下载 ZIP，解压后放入 `ComfyUI/custom_nodes/`。不需要看代码。 |
| **想看代码或自己修改** | [开源源码：本仓库文件](https://github.com/lefango/ComfyUI-ChuangJie) | Python 和 JavaScript 源码都在这里。改动需要自己检查并安装。 |

**成品**就是已经打包、给普通用户安装的 ZIP；**源码**是程序员可以阅读和修改的原始文件。两者功能相同，成品只是更方便安装。`releases/` 文件夹提供成品 ZIP；仓库的 Code 页面提供源码。

## 安装（适合新手）

1. 点击上面的“成品：ComfyUI-ChuangJie-0.2.1.zip”下载成品包。
2. 先关闭 ComfyUI，再把 ZIP 解压到 `ComfyUI/custom_nodes/`。
3. 确认最终目录是 `ComfyUI/custom_nodes/ComfyUI-ChuangJie/`，里面能看到 `__init__.py`。
4. 启动 ComfyUI，并刷新浏览器页面。

如果压缩包解压后多套了一层文件夹，请把内层 `ComfyUI-ChuangJie` 文件夹移到 `custom_nodes` 中。若你之前单独安装过本项目的 LoRA、提示词或可视化保存图像节点，请先停用旧的独立版本，再使用创界。

## 在 ComfyUI Manager 中安装或更新

在 Manager 搜索 `ComfyUI-ChuangJie`，点安装或更新。若暂时搜不到，可用上面的成品 ZIP 手动安装；也可以在 `ComfyUI/custom_nodes/` 中运行：

```bash
git clone https://github.com/lefango/ComfyUI-ChuangJie.git
```

通过 Git 安装后，在 Manager 点击更新；或在插件文件夹中执行 `git pull`。本插件已经发布到 Comfy Registry。目录同步可能需要一点时间；如果暂时搜不到，请稍后刷新 Manager，或先用上方成品 ZIP。

## 插件做什么

- **可视化管理 LoRA**：在节点选择器的“创界节点 / 模型工具”中浏览和管理 LoRA；可把触发词传给提示词工具。
- **可视化管理提示词**：在“创界节点 / 提示词工具”中编辑正面、负面提示词和预设，并连接到 CLIP 文本编码。
- **可视化保存图像**：在“创界节点 / 图像工具”中选择或新建 ComfyUI `output` 下的文件夹，保存 PNG、浏览结果，并将图像继续传给后续节点。

旧工作流继续使用 `LoRAManager`、`PromptManager` 和 `VisualSaveImage` 节点标识。插件公共资料保存在 ComfyUI 用户目录的 `lora-manager` 与 `prompt-manager` 文件夹中；升级不会删除这些资料。请勿手动删除它们。

## 卸载或回退

关闭 ComfyUI，把 `ComfyUI/custom_nodes/ComfyUI-ChuangJie` 文件夹移出 `custom_nodes`，再恢复之前备份的插件文件夹并重启。不要删除 ComfyUI 用户目录中的 `lora-manager` 和 `prompt-manager`。

## English: Quick guide

### Product or source code?

- **Ready-to-install product:** Download [ComfyUI-ChuangJie-0.2.1.zip](https://github.com/lefango/ComfyUI-ChuangJie/raw/refs/heads/main/releases/ComfyUI-ChuangJie-0.2.1.zip). Extract it into `ComfyUI/custom_nodes/ComfyUI-ChuangJie/`, then restart ComfyUI. No coding required.
- **Open source code:** Browse or clone the files in this repository if you want to inspect or modify the code. The code is readable Python and JavaScript; the ZIP is the packaged version for easier installation.

### Install

1. Download `releases/ComfyUI-ChuangJie-0.2.1.zip` from this repository.
2. Stop ComfyUI and extract the ZIP into `ComfyUI/custom_nodes/`.
3. Make sure `ComfyUI/custom_nodes/ComfyUI-ChuangJie/__init__.py` exists.
4. Restart ComfyUI and refresh the browser.

If you previously installed this project's LoRA, Prompt, or Visual Save Image nodes as standalone packages, disable those older copies before using ChuangJie.

### Install or update with ComfyUI Manager

Search for `ComfyUI-ChuangJie` in Manager and choose Install or Update. If it is not listed yet, use the ZIP above or clone this repository into `ComfyUI/custom_nodes/`. This plugin has been published to Comfy Registry. Catalog synchronization may take a little while; refresh Manager later if it does not appear immediately, or use the ready-to-install ZIP above.

### What it does

- **Visual LoRA management:** Browse and manage LoRAs under “ChuangJie Nodes / Model Tools”; trigger words can be passed to the prompt tool.
- **Visual prompt management:** Edit positive and negative prompts and presets under “ChuangJie Nodes / Prompt Tools,” then connect them to CLIP text encoders.
- **Visual image saving:** Choose or create folders under ComfyUI's `output`, save PNG files, preview results, and pass images through to later nodes.

Existing workflows retain the `LoRAManager`, `PromptManager`, and `VisualSaveImage` node identifiers. User data stays in the ComfyUI user folders `lora-manager` and `prompt-manager` when the plugin is updated or removed.

## License / 许可

Licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**. You may use, modify, and redistribute this project for non-commercial purposes with attribution; shared adaptations must use the same or a compatible license. Commercial use requires separate permission. See [LICENSE](LICENSE) and the [full license terms](https://creativecommons.org/licenses/by-nc-sa/4.0/).

This license matches the requested non-commercial and share-alike terms, but it is not an OSI-approved open-source software license. Creative Commons recommends its licenses primarily for content, rather than software.
