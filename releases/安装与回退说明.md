# 创界 · ComfyUI-ChuangJie

**中英双语 | 简单安装 | 可读源码**

当前版本为 **0.5.25**，集成创界集成控制台 **0.2.25** 和创界保存图像 **0.1.1**。提示词管理界面与 API 已由创界集成控制台内置；主插件不再注册独立 `PromptManager` 节点。

## 0.5.25 更新

- Krea2 单图参考默认将参考 K 强度设为 0，并默认使用快速 RF 计算；参考缓存冷构建约减半模型前向次数。K=0 只关闭空间 K 路径，V 风格参考仍有效；可在风格参考设置中切回高保真模式。
- 关闭风格后不再意外启用、显示或加载已保留的封面；较早排队任务完成时不会覆盖当前任务预览。实时采样预览标注为潜空间估算。
- 旧版参考 K 默认 1.1 自动迁移为 0；其他已保存强度和工作流端口保持不变。

## 0.5.24 更新

- 修复 Krea2 外接二次采样改变 latent 分辨率后，参考 latent 仍保持首轮空间尺寸而触发 spatial mismatch 的问题；每轮 RF 按当前目标 latent 尺寸构建。
- 不改工作流端口、配置字段、默认参考强度或相同尺寸下的参考值。自动回归通过，真实 GPU 放大后二采尚待安装验收。

## 0.5.23 更新

- 修复 Krea2 带封面风格在二次采样时丢失：现有“模型”输出传出首轮实际使用的风格参考模型，外接 KSampler 可以继续沿用参考图。
- 不增加节点端口，不改变工作流端口 ID、类型或顺序；普通模型与文字风格路径保持不变。

## 0.5.22 更新

- 上传、保存和导入风格封面时，长边超过 4096 像素会按比例缩小并转成 JPEG；Krea2、Qwen 入队时也会自动压缩旧风格库中的大图。
- Krea2 70 MB 与 Qwen 20 MB 的入队上限保持不变；工作流端口和内部字段保持兼容。
- 集成控制台升级至 0.2.22，工作流端口和内部字段保持兼容。

## 0.5.21 更新

- 两个节点显示名为“创界保存图像”和“创界集成控制台”；输出端口 `latent` 的界面标签为“潜空间”，内部名称、类型与连接保持兼容。
- 集成控制台封面上限为 70 MB。
- 独立模块 ZIP 使用 `ComfyUI-ChuangJie-Visual-Save-Image` 和 `ComfyUI-ChuangJie-Integrated-Console` 安装目录。由独立旧版升级时，先移除旧目录，避免重复节点；主插件安装目录仍为 `ComfyUI-ChuangJie`。
- 隔离实例已检查 Classic 与 Nodes 2.0 下新建节点及页面重载恢复；Nodes 2.0 重载后仍显示“潜空间”。JSON 文件导出/重开、旧连线工作流和实际 GPU 生成尚未实测。

集合控制台仅对 Qwen Image 2.1 开启原生图像编辑；编辑图在 1080×1920 边界内时按 8 像素向下对齐，任一边超出时等比缩至该边界并让宽高各自按 8 像素对齐。普通小图不放大；缩放、对齐或极端比例使任一边不足 16 像素时会提升到 16，以满足 `PromptStage` 的最小尺寸。遮罩同步缩放。Qwen 原生编码器随后按 32 像素步幅处理参考 latent；最终图像的遮罩黑区逐像素保留原图。其它模型忽略编辑图片与遮罩。

提示词界面继续通过 `/prompt-manager/v1` 工作，并沿用 ComfyUI 用户目录下的 `prompt-manager` 资料。已有提示词资料无需迁移。

## 0.5.20 更新

- 放大风格分类封面、扩展分类内图片列表高度；新建和编辑风格改为独立弹窗。
- 不改变风格 API、用户资料和节点配置格式。Classic、Nodes 2.0、工作流重载及执行待用户实测。

## 0.5.19 更新

- 重做集合控制台的分辨率、提示词预设和风格参考二级页面，继续使用真实 API、资料库和封面。
- 分辨率比例卡片自动选择方向范围内的最大尺寸并按 8 像素对齐；保留自定义尺寸与批次数，采样步数和 CFG 仍在“K 采样器”。
- 保留提示词分类/预设/当前节点组合管理，以及风格收藏、导入、编辑、多选排序和 Krea2 参考强度。
- 不修改节点端口、配置格式、后端 API 或用户资料结构。

## 0.5.18 更新

- 修复 Krea2 参考风格 RF 缓存在采样每一步重复识别条件、重复准备参考状态的问题；按稳定条件 UUID 和正/负分支在同一采样轮次复用。
- 保留有容量上限的 CPU 内存缓存与阶段耗时日志；不改画面算法、采样步数和默认强度。首次生成新的提示词/参考条件仍需构建 RF schedule；匹配的后续请求可复用已缓存结果。
- 安装包与 Registry 发布状态以本次版本记录及 GitHub 工作流为准。

## 0.5.17 更新

- Krea2 参考风格增加有容量上限的 CPU 内存缓存，并记录封面读取、参考编码、RF cache 与采样耗时。
- 保留原 `flowturbo_pc` 算法与画面设置；首次遇到新的条件组合时构建 RF schedule。

## 0.5.16 更新

- 集合控制台“选择风格”弹窗的“收藏风格”后新增“参考强度”按钮；点击后显示 Krea2 单图的“风格参考强度”分块，包括“参考强度”（`low_scale_end`）和“风格还原强度”（`ref_k_strength`），默认均为 1.1，支持上下调节。
- 多图风格参考路径保持原样。参数效果受模型及取值影响；调低参考强度可能保留更多生成细节。

## 0.5.15 更新

- 集成集合控制台 0.2.15：Krea2 单图风格参考新增“风格参考强度”分块，可分别调节“参考强度”（`low_scale_end`）与“风格还原强度”（`ref_k_strength`），默认均为 1.1，支持向上或向下调整。
- 多图风格参考路径保持原样。参数效果和出图质量受模型及取值影响；两个参数用于自行平衡风格迁移与画质。

## 0.5.14 历史修复

- 清除旧版集合控制台 0.2.12 的前端入口，避免它先注册同名扩展并让新版 0.2.14 入口加载失败。更新后由唯一的控制台入口生成完整输出端口。
- 控制台自身输出正面条件、负面条件和内部首轮采样后的 Latent；内部首轮采样继续执行，可连接外部 KSampler 二次采样。

## 0.5.13 更新

- 集合控制台新增“正面条件”“负面条件”和首轮采样后的“Latent”输出，端口追加在旧“图像”输出之后，保持已有工作流端口编号。
- 条件输出复用内部首轮 KSampler 实际使用的正负 CONDITIONING；Qwen Image 2.1 图像编辑连接 Qwen 编码器条件。连接新增输出时保留首轮内部采样，Latent 可接外部 KSampler 继续二次采样。
- Classic 与 Nodes 2.0 使用中文端口标签；旧工作流加载与输出连线保留。
- 集合控制台 0.2.14 已装配到主插件 0.5.13；GitHub 与 Comfy Registry 发布状态见项目交付记录。

## 0.5.12 历史更新

- 集合控制台从独立源码更新至 0.2.12；提示词管理 API 和界面随集合控制台装配，避免单独重复注册。
- 补齐集合控制台预览事件与随机种子前端依赖的装配白名单，避免入口模块因缺失依赖加载失败、节点退回原始字段界面。
- 保持集合控制台节点标识、`/cj-unified-loader-test/v1` 路由及 `unified-model-loader-test` 资料目录；保存图片节点保持现有标识、接口和用户资料路径。
- 不再提供独立 `PromptManager` 节点。依赖该节点的旧工作流需要手动替换为集合控制台；不自动改写工作流。冻结的提示词 0.6.2 独立分支不会随主插件安装。
- `prompt-manager` 用户资料路径保持不变，升级不会删除或迁移其中的数据。
- 集成回归、Classic 与 Nodes 2.0 界面、保存重载、旧连线和 Flux2 Klein → 可视化保存图像的隔离出图验收随 0.5.12 记录。
- GitHub 安装包、源码、校验值和说明更新至 0.5.12；本次 GitHub 发布通过现有 Actions 同步发布到 Comfy Registry。

## 0.5.11 历史更新

- 模型预设和风格参考封面等比居中完整显示；封面区适度加高，风格列表缩略图保持原有规则。

- 集成集合控制台 0.2.9。图像编辑自动缩放后的宽高现按 8 像素对齐，修复 2720×1536 等原图得到 1080×610 后触发 `PromptStage` latent 校验错误的问题。
- 内部主模型分支启用但未选择文件时，准备执行会在集合控制台给出一次具体配置错误；失败回退保持有效的动态输出占位类型，不再让“保存图像”节点报 `tuple index out of range`。
- Classic / Nodes 2.0 实际界面、旧工作流重载以及 Qwen Image 2.1 真实生成仍需在用户自己的 ComfyUI 和模型环境中验收；自动化测试不代替这些操作。
- 当时本地安装包为 `ComfyUI-ChuangJie-0.5.11.zip`，尚未同步至 GitHub。

## 本地 0.5.1 历史更新

GGUF 依赖随根目录 `requirements.txt` 提供；如环境缺少依赖，使用 ComfyUI 的 Python 安装此文件。

- 主插件只提供“模型与 LoRA 一体”节点，不再发行拆分的 LoRA 管理器或模型加载器。旧独立源码和安装包已从当前模块目录退役，校验备份保存在 `全部备份`；旧工作流需要手动改接一体节点，不自动迁移。
- 集成一体模块 0.1.2：模型卡片使用启用／关闭切换，主模型和 VAE 单选，CLIP 最多四项并支持排序；配置区使用资料显示名称。
- CLIP 用途默认跟随主模型架构资料或常见名称识别；未知时提示手动选择，手动设置会保留。四项功能默认开启，未选择文件时不会自动加载。
- 完整预设卡片显示封面、名称、备注；编辑窗口可修改名称和备注，并查看保存配置中的组件友好名称。
- 保留 `CJUnifiedModelLoaderTest` 等内部标识及 `/cj-unified-loader-test/v1` 接口以兼容临时版工作流。资料继续使用用户目录 `unified-model-loader-test`，不自动导入其他模块资料库；原 LoRA/model-loader 用户资料不随这次源码清理删除。
- 更新时停用独立 `ComfyUI-Unified-Model-Loader-Test`，避免同名节点与重复接口；旧工作流连线和配置快照保留。
- 本地成品为 `ComfyUI-ChuangJie-0.5.11.zip`；下文 GitHub 链接仍指向已公开的 0.3.3，本次未发布到 GitHub。

## 本地 0.4.2 更新 | Local changes

- 提示词管理器提供可视化比例、尺寸档、自定义宽高及批量数选择，并输出可直接连接 KSampler 的空 latent。
- Prompt Manager adds visual aspect-ratio, resolution, custom-size and batch selection, with an empty LATENT output for KSampler.
- Krea2 开关移至顶部工具栏，主参考封面预览可折叠；连接提示要求使用 `type = krea2` 的 CLIP。
- The Krea2 toggle moves to the toolbar, the primary cover preview is collapsible, and the connection guidance specifies a `type = krea2` CLIP.

## 0.3.2 更新 | Changes

- 新增独立正面文本、负面文本输出，可与自动切换的文本 / CONDITIONING 主输出同时使用，并连接到下游提示词节点。
- 文本输出可按需启用，并选择用户输入、上游补充、预设和风格作为来源；未启用时不影响主输出。
- 保留图片风格选择、收藏持久化、旧工作流兼容、中文端口标签和提示词快照。
- 本地独立提示词模块 0.4.0 已完成其页面与执行验收；主插件 0.3.2 安装包由 modules.json 白名单重新装配并校验。

The prompt node adds separate positive and negative text outputs for downstream prompt nodes. These can run alongside the main outputs, which switch between text and CONDITIONING based on their connections. Choose which prompt sources feed the text outputs. Existing styles, favorites, Chinese labels and saved workflows remain supported. User libraries, favorites and imported covers stay out of the release ZIP.

## 界面预览 | Interface preview

以下截图对应 GitHub 公开版 0.3.3 的独立节点界面，LoRA 卡片和提示词条目是演示资料。当前版本 0.5.25 将模型、LoRA 与提示词管理整合在创界集成控制台中；截图仅供历史参考。

The screenshots below show the older standalone-node UI from public release 0.3.3 and use demo data. Version 0.5.25 integrates model, LoRA and prompt management in the ChuangJie Integrated Console; treat these screenshots as historical references.

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
| **只想安装使用** | [成品：ComfyUI-ChuangJie-0.5.25.zip](https://github.com/lefango/ComfyUI-ChuangJie/raw/refs/heads/main/releases/ComfyUI-ChuangJie-0.5.25.zip) | 下载 ZIP，解压后放入 `ComfyUI/custom_nodes/`。校验值见 `releases/SHA256SUMS.txt`。 |
| **想看代码或自己修改** | [开源源码：本仓库文件](https://github.com/lefango/ComfyUI-ChuangJie) | Python 和 JavaScript 源码都在这里。改动需要自己检查并安装。 |

**成品**就是已经打包、给普通用户安装的 ZIP；**源码**是程序员可以阅读和修改的原始文件。两者功能相同，成品只是更方便安装。`releases/` 文件夹提供成品 ZIP；仓库的 Code 页面提供源码。

## 安装（适合新手）

1. 下载 `ComfyUI-ChuangJie-0.5.25.zip` 安装包，并核对 `releases/SHA256SUMS.txt`。
2. 先关闭 ComfyUI，再把 ZIP 解压到 `ComfyUI/custom_nodes/`。
3. 确认最终目录是 `ComfyUI/custom_nodes/ComfyUI-ChuangJie/`，里面能看到 `__init__.py`。
4. 启动 ComfyUI，并刷新浏览器页面。

如果压缩包解压后多套了一层文件夹，请把内层 `ComfyUI-ChuangJie` 文件夹移到 `custom_nodes` 中。若你之前单独安装过本项目的提示词管理器，请先停用旧插件，避免 `/prompt-manager/v1` 路由冲突。旧 `PromptManager` 工作流需要手动替换为集合控制台；升级不会删除 `prompt-manager` 用户资料。

## 在 ComfyUI Manager 中安装或更新

在 Manager 搜索 `ComfyUI-ChuangJie`，点安装或更新。若暂时搜不到，可用上面的成品 ZIP 手动安装；也可以在 `ComfyUI/custom_nodes/` 中运行：

```bash
git clone https://github.com/lefango/ComfyUI-ChuangJie.git
```

通过 Git 安装后，在 Manager 点击更新；或在插件文件夹中执行 `git pull`。本插件通过 Comfy Registry 发布；新版本在发布流程与目录索引完成后显示。如果暂时搜不到，请稍后刷新 Manager，或先用上方成品 ZIP。

## 插件做什么

- **创界集成控制台**：在“创界节点 / 模型工具”配置模型、LoRA、提示词、风格、分辨率和采样，内置 K 采样与 VAE 解码；LoRA 触发词自动加入正面提示词，节点输出图像。提示词管理界面由此节点打开。
- **创界保存图像**：在“创界节点 / 图像工具”中选择或新建 ComfyUI `output` 下的文件夹，保存 PNG、浏览结果，并将图像继续传给后续节点。

主插件注册创界集成控制台相关节点与 `VisualSaveImage`，不再注册独立 `PromptManager`。节点标识、`/cj-unified-loader-test/v1` 和 `unified-model-loader-test` 路径保持兼容；提示词 API 仍使用 `/prompt-manager/v1`，资料仍位于 `prompt-manager`。拆分的 `LoRAManager` 与独立模型加载节点不再注册。升级不会删除任何上述用户资料。

## 卸载或回退

关闭 ComfyUI，把 `ComfyUI/custom_nodes/ComfyUI-ChuangJie` 文件夹移出 `custom_nodes`，再恢复之前备份的插件文件夹并重启。不要删除 ComfyUI 用户目录中的 `unified-model-loader-test`、`lora-manager` 和 `prompt-manager`。

## English: Quick guide

### Product or source code?

- **Ready-to-install build:** Download [ComfyUI-ChuangJie-0.5.25.zip](https://github.com/lefango/ComfyUI-ChuangJie/raw/refs/heads/main/releases/ComfyUI-ChuangJie-0.5.25.zip). Verify `releases/SHA256SUMS.txt`, extract it into `ComfyUI/custom_nodes/ComfyUI-ChuangJie/`, and restart ComfyUI.
- **Open source code:** Browse or clone the files in this repository if you want to inspect or modify the code. The code is readable Python and JavaScript; the ZIP is the packaged version for easier installation.

### Install

1. Download `releases/ComfyUI-ChuangJie-0.5.25.zip` and verify `releases/SHA256SUMS.txt`.
2. Stop ComfyUI and extract the ZIP into `ComfyUI/custom_nodes/`.
3. Make sure `ComfyUI/custom_nodes/ComfyUI-ChuangJie/__init__.py` exists.
4. Restart ComfyUI and refresh the browser.

If you previously installed the standalone Prompt Manager, disable it before using ChuangJie to avoid an API route conflict. Existing PromptManager workflows need a manual replacement with the collection console; the `prompt-manager` user data directory remains intact.

### Install or update with ComfyUI Manager

Search for `ComfyUI-ChuangJie` in Manager and choose Install or Update. If it is not listed yet, use the ZIP above or clone this repository into `ComfyUI/custom_nodes/`. This plugin has been published to Comfy Registry. Catalog synchronization may take a little while; refresh Manager later if it does not appear immediately, or use the ready-to-install ZIP above.

### What it does

- **ChuangJie Integrated Console:** Manage models, LoRAs, prompts, styles and sampling under “ChuangJie Nodes / Model Tools.” The prompt management interface opens inside this node.
- **ChuangJie Save Image:** Choose or create folders under ComfyUI's `output`, save PNG files, preview results, and pass images through to later nodes.

The standalone `PromptManager` node is no longer registered; replace workflows that use it manually. The collection console identifiers, `/cj-unified-loader-test/v1` route and `unified-model-loader-test` data directory remain compatible. Prompt management keeps `/prompt-manager/v1` and the existing `prompt-manager` data directory. `VisualSaveImage` remains available. Do not install standalone save-image or console packages alongside this plugin; remove either legacy folders `ComfyUI-Visual-Save-Image` and `ComfyUI-Unified-Model-Loader-Test`, or renamed folders `ComfyUI-ChuangJie-Visual-Save-Image` and `ComfyUI-ChuangJie-Integrated-Console` from `custom_nodes` before using the combined plugin.

## License / 许可

Licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**. You may use, modify, and redistribute this project for non-commercial purposes with attribution; shared adaptations must use the same or a compatible license. Commercial use requires separate permission. See [LICENSE](LICENSE) and the [full license terms](https://creativecommons.org/licenses/by-nc-sa/4.0/).

This license matches the requested non-commercial and share-alike terms, but it is not an OSI-approved open-source software license. Creative Commons recommends its licenses primarily for content, rather than software.
