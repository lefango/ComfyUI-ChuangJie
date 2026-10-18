import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { Client, openManager } from "./lora/manager.mjs";
import { NodePreview } from "./lora/node_preview.mjs";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet"; stylesheet.href = new URL("./lora/manager.css", import.meta.url).href;
document.head.append(stylesheet);
const client = new Client((path, options) => api.fetchApi(path, options),
    (key) => api.apiURL(`/lora-manager/v1/covers/${key}`));
const previews = new WeakMap();

// Translate presentation only: names remain stable for workflow/API compatibility.
function localizeInputLabels(node) {
    const labels = {"model": "模型", "clip": "CLIP", "config": "LoRA 配置"};
    for (const input of node.inputs || []) {
        if (Object.hasOwn(labels, input.name)) input.label = labels[input.name];
    }
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "comfyui.lora-manager",
    nodeCreated(node) {
        if (node.comfyClass !== "LoRAManager") return;
        localizeInputLabels(node);
        const config = node.widgets?.find((widget) => widget.name === "config");
        // Keep the native input serialized while replacing its visual surface.
        if (config) {
            config.hidden = true; config.options.hidden = true;
            if (config.inputEl) { config.inputEl.readOnly = true; config.inputEl.style.display = "none"; }
        }
        node.size = [Math.max(node.size[0], 640), node.size[1]];
        const preview = new NodePreview(node, client, () => {
            try {
                openManager({ client, getConfig: () => config.value,
                    hasClip: () => node.inputs?.some((input) => input.name === "clip" && input.link != null),
                    setConfig: (value) => {
                        config.value = value; config.callback?.(value); preview.update();
                        node.graph?.change(); node.setDirtyCanvas?.(true, true);
                    }, onClose: () => preview.update(true) });
            } catch (error) { app.extensionManager.toast.add({ severity: "error", summary: "LoRA 管理器", detail: error.message, life: 8000 }); }
        });
        previews.set(node, preview);
    },
    loadedGraphNode(node) {
        if (node.comfyClass !== "LoRAManager") return;
        localizeInputLabels(node); previews.get(node)?.update(true);
    },
});
