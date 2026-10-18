# ���� �� ComfyUI-ChuangJie

**��Ӣ˫�� | �򵥰�װ | �ɶ�Դ��**

�����ṩ LoRA ��������ʾ�ʹ����Ϳ��ӻ�����ͼ������ ComfyUI �ڵ㡣��ǰ�汾 **0.3.3**��������ʾ�ʹ����� **0.4.2**��

## 0.3.3 ���� | Changes

- ��ʾ�ʷ����Ϊ����ʱ�������أ������Ը����������⣬�����״δ�ʱһ����Ⱦ������Ƭ��ɽ��濨�ٵķ��ա�
- Prompt style cards now load in batches as the grid scrolls; search still covers the full library.

## 0.3.2 ���� | Changes

- �������������ı��������ı�����������Զ��л����ı� / CONDITIONING �����ͬʱʹ�ã������ӵ�������ʾ�ʽڵ㡣
- �ı�����ɰ������ã���ѡ���û����롢���β��䡢Ԥ��ͷ����Ϊ��Դ��δ����ʱ��Ӱ���������
- ����ͼƬ���ѡ���ղس־û����ɹ��������ݡ����Ķ˿ڱ�ǩ����ʾ�ʿ��ա�
- ���ض�����ʾ��ģ�� 0.4.0 �������ҳ����ִ�����գ������ 0.3.2 ��װ���� modules.json ����������װ�䲢У�顣

The prompt node adds separate positive and negative text outputs for downstream prompt nodes. These can run alongside the main outputs, which switch between text and CONDITIONING based on their connections. Choose which prompt sources feed the text outputs. Existing styles, favorites, Chinese labels and saved workflows remain supported. User libraries, favorites and imported covers stay out of the release ZIP.

## ����Ԥ�� | Interface preview

����Ϊ����� ComfyUI �е�ʵ�����н�ͼ��LoRA ��Ƭ����ʾ����Ŀ������չʾ����ʾ���ϡ�

**�ڵ���ڣ��ڡ�����ڵ㡱������ѡ��������ߡ�**

<p align="center"><img src="https://raw.githubusercontent.com/lefango/ComfyUI-ChuangJie/main/docs/images/node-categories.jpg" width="850" alt="����ڵ�������" /></p>

**LoRA �����������Ƭ������͵�ǰ�����**

<p align="center"><img src="https://raw.githubusercontent.com/lefango/ComfyUI-ChuangJie/main/docs/images/lora-manager.jpg" width="850" alt="LoRA ����������" /></p>

**��ʾ�ʹ��������ӻ��༭�����븺����ʾ�ʡ�����Ԥ�衣**

<p align="center"><img src="https://raw.githubusercontent.com/lefango/ComfyUI-ChuangJie/main/docs/images/prompt-manager.jpg" width="850" alt="��ʾ�ʹ���������" /></p>

These are screenshots of the plugin running in ComfyUI. LoRA cards and prompt entries are demo data.

## �����ȿ�����Ʒ����Դ�룿

| ������ʲô | ����ʲô | ˵�� |
| --- | --- | --- |
| **ֻ�밲װʹ��** | [��Ʒ��ComfyUI-ChuangJie-0.3.3.zip](https://github.com/lefango/ComfyUI-ChuangJie/raw/refs/heads/main/releases/ComfyUI-ChuangJie-0.3.3.zip) | ���� ZIP����ѹ����� `ComfyUI/custom_nodes/`������Ҫ�����롣 |
| **�뿴������Լ��޸�** | [��ԴԴ�룺���ֿ��ļ�](https://github.com/lefango/ComfyUI-ChuangJie) | Python �� JavaScript Դ�붼������Ķ���Ҫ�Լ���鲢��װ�� |

**��Ʒ**�����Ѿ����������ͨ�û���װ�� ZIP��**Դ��**�ǳ���Ա�����Ķ����޸ĵ�ԭʼ�ļ������߹�����ͬ����Ʒֻ�Ǹ����㰲װ��`releases/` �ļ����ṩ��Ʒ ZIP���ֿ�� Code ҳ���ṩԴ�롣

## ��װ���ʺ����֣�

1. �����Ϸ��� `ComfyUI-ChuangJie-0.3.3.zip` ��װ�������˶� `releases/SHA256SUMS.txt`��
2. �ȹر� ComfyUI���ٰ� ZIP ��ѹ�� `ComfyUI/custom_nodes/`��
3. ȷ������Ŀ¼�� `ComfyUI/custom_nodes/ComfyUI-ChuangJie/`�������ܿ��� `__init__.py`��
4. ���� ComfyUI����ˢ�������ҳ�档

���ѹ������ѹ�������һ���ļ��У�����ڲ� `ComfyUI-ChuangJie` �ļ����Ƶ� `custom_nodes` �С�����֮ǰ������װ������Ŀ�� LoRA����ʾ�ʻ���ӻ�����ͼ��ڵ㣬����ͣ�þɵĶ����汾����ʹ�ô��硣

## �� ComfyUI Manager �а�װ�����

�� Manager ���� `ComfyUI-ChuangJie`���㰲װ����¡�����ʱ�Ѳ�������������ĳ�Ʒ ZIP �ֶ���װ��Ҳ������ `ComfyUI/custom_nodes/` �����У�

```bash
git clone https://github.com/lefango/ComfyUI-ChuangJie.git
```

ͨ�� Git ��װ���� Manager ������£����ڲ���ļ�����ִ�� `git pull`��������Ѿ������� Comfy Registry��Ŀ¼ͬ��������Ҫһ��ʱ�䣻�����ʱ�Ѳ��������Ժ�ˢ�� Manager���������Ϸ���Ʒ ZIP��

## �����ʲô

- **���ӻ����� LoRA**���ڽڵ�ѡ�����ġ�����ڵ� / ģ�͹��ߡ�������͹��� LoRA���ɰѴ����ʴ�����ʾ�ʹ��ߡ�
- **���ӻ�������ʾ��**���ڡ�����ڵ� / ��ʾ�ʹ��ߡ��б༭���桢������ʾ�ʺ�Ԥ�裬�����ӵ� CLIP �ı����롣
- **���ӻ�����ͼ��**���ڡ�����ڵ� / ͼ�񹤾ߡ���ѡ����½� ComfyUI `output` �µ��ļ��У����� PNG��������������ͼ��������������ڵ㡣

�ɹ���������ʹ�� `LoRAManager`��`PromptManager` �� `VisualSaveImage` �ڵ��ʶ������������ϱ����� ComfyUI �û�Ŀ¼�� `lora-manager` �� `prompt-manager` �ļ����У���������ɾ����Щ���ϡ������ֶ�ɾ�����ǡ�

## ж�ػ����

�ر� ComfyUI���� `ComfyUI/custom_nodes/ComfyUI-ChuangJie` �ļ����Ƴ� `custom_nodes`���ٻָ�֮ǰ���ݵĲ���ļ��в���������Ҫɾ�� ComfyUI �û�Ŀ¼�е� `lora-manager` �� `prompt-manager`��

## English: Quick guide

### Product or source code?

- **Ready-to-install product:** Download [ComfyUI-ChuangJie-0.3.3.zip](https://github.com/lefango/ComfyUI-ChuangJie/raw/refs/heads/main/releases/ComfyUI-ChuangJie-0.3.3.zip). Extract it into `ComfyUI/custom_nodes/ComfyUI-ChuangJie/`, then restart ComfyUI. No coding required.
- **Open source code:** Browse or clone the files in this repository if you want to inspect or modify the code. The code is readable Python and JavaScript; the ZIP is the packaged version for easier installation.

### Install

1. Download `releases/ComfyUI-ChuangJie-0.3.3.zip` and verify `releases/SHA256SUMS.txt`.
2. Stop ComfyUI and extract the ZIP into `ComfyUI/custom_nodes/`.
3. Make sure `ComfyUI/custom_nodes/ComfyUI-ChuangJie/__init__.py` exists.
4. Restart ComfyUI and refresh the browser.

If you previously installed this project's LoRA, Prompt, or Visual Save Image nodes as standalone packages, disable those older copies before using ChuangJie.

### Install or update with ComfyUI Manager

Search for `ComfyUI-ChuangJie` in Manager and choose Install or Update. If it is not listed yet, use the ZIP above or clone this repository into `ComfyUI/custom_nodes/`. This plugin has been published to Comfy Registry. Catalog synchronization may take a little while; refresh Manager later if it does not appear immediately, or use the ready-to-install ZIP above.

### What it does

- **Visual LoRA management:** Browse and manage LoRAs under ��ChuangJie Nodes / Model Tools��; trigger words can be passed to the prompt tool.
- **Visual prompt management:** Edit positive and negative prompts and presets under ��ChuangJie Nodes / Prompt Tools,�� then connect them to CLIP text encoders.
- **Visual image saving:** Choose or create folders under ComfyUI's `output`, save PNG files, preview results, and pass images through to later nodes.

Existing workflows retain the `LoRAManager`, `PromptManager`, and `VisualSaveImage` node identifiers. User data stays in the ComfyUI user folders `lora-manager` and `prompt-manager` when the plugin is updated or removed.

## License / ����

Licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**. You may use, modify, and redistribute this project for non-commercial purposes with attribution; shared adaptations must use the same or a compatible license. Commercial use requires separate permission. See [LICENSE](LICENSE) and the [full license terms](https://creativecommons.org/licenses/by-nc-sa/4.0/).

This license matches the requested non-commercial and share-alike terms, but it is not an OSI-approved open-source software license. Creative Commons recommends its licenses primarily for content, rather than software.
