import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PromptView } from "./prompt/node.mjs";

const css = document.createElement("link"); css.rel = "stylesheet"; css.href = new URL("./prompt/style.css", import.meta.url).href; document.head.append(css);
const views = new Set();
const cachedRuns = new Map();
async function client(operation, body) {
    const response = await api.fetchApi(`/prompt-manager/v1/${operation}`, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let data; try { data = await response.json(); } catch { throw Error(`请求失败 (${response.status})`); }
    if (!response.ok) throw Error(data.error || `请求失败 (${response.status})`);
    return data;
}
api.addEventListener("execution_start", () => {
    for (const ref of views) {
        const view = ref.deref();
        if (view) { view.executionGraph = view.graphKey(); view.executionSerial = (view.executionSerial || 0) + 1; }
        else views.delete(ref);
    }
});
api.addEventListener("execution_cached", event => {
    const { prompt_id, nodes } = event.detail || {};
    if (prompt_id && Array.isArray(nodes)) cachedRuns.set(prompt_id, nodes.map(String));
    // Bound memory even if a run is interrupted before success.
    if (cachedRuns.size > 32) cachedRuns.delete(cachedRuns.keys().next().value);
});
api.addEventListener("execution_success", async event => {
    const id = event.detail?.prompt_id, ids = cachedRuns.get(id);
    cachedRuns.delete(id); if (!ids?.length) return;
    const targets = [...views].map(ref => ref.deref()).filter(view => view && ids.includes(String(view.node.id)) && app.graph?.getNodeById(view.node.id) === view.node)
        .map(view => ({ view, serial: view.executionSerial }));
    if (!targets.length) return;
    try {
        // A cache hit does not emit onExecuted. Read ComfyUI's own execution
        // history after completion, rather than rerunning or bypassing cache.
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await api.fetchApi(`/history/${encodeURIComponent(id)}`);
            if (!response.ok) return;
            const history = (await response.json())[id];
            if (history) {
                for (const { view, serial } of targets) {
                    if (view.executionSerial !== serial || app.graph?.getNodeById(view.node.id) !== view.node) continue;
                    const message = history.outputs?.[String(view.node.id)];
                    if (message?.prompt_manager) view.executed(message);
                }
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } catch { /* Keep the editable prompt and explicitly absent execution result. */ }
});
// Translate presentation only: names remain stable for workflow/API compatibility.
function localizeInputLabels(node) {
    const labels = {"positive_extra": "正面补充提示词", "negative_extra": "负面补充提示词", "positive": "正面提示词", "negative": "负面提示词", "config": "预设配置"};
    for (const input of node.inputs || []) {
        if (Object.hasOwn(labels, input.name)) input.label = labels[input.name];
    }
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "comfyui.prompt-manager",
    nodeCreated(node) {
        if (node.comfyClass !== "PromptManager") return;
        localizeInputLabels(node);
        for (const name of ["positive", "negative", "config"]) {
            const widget = node.widgets?.find(w => w.name === name);
            if (!widget) continue;
            widget.hidden = true; widget.options ||= {}; widget.options.hidden = true;
            if (widget.inputEl) widget.inputEl.style.display = "none";
        }
        const view = new PromptView(node, client); views.add(new WeakRef(view));
        const onExecuted = node.onExecuted;
        node.onExecuted = function (message) { onExecuted?.call(this, message); view.executed(message); };
        const onConfigure = node.onConfigure;
        node.onConfigure = function (...args) { onConfigure?.apply(this, args); localizeInputLabels(this); view.update(); };
        node.setSize([Math.max(node.size[0], 620), Math.max(node.size[1], 860)]);
    },
    loadedGraphNode(node) {
        if (node.comfyClass === "PromptManager") localizeInputLabels(node);
    },
});
