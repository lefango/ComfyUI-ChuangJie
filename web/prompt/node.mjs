import { parseConfig } from "./state.mjs";
import { el, button, isolate, copyText, pasteText, renderCombination, openManager } from "./ui.mjs";
import { openStyles, renderStyleSummary } from "./styles.mjs";

export class PromptView {
    constructor(node, client) {
        this.node = node; this.client = client; this.version = 0; this.sides = {}; this.lastExecution = null;
        this.element = el("div", "pm-node"); isolate(this.element);
        this.status = el("div", "pm-muted"); this.status.role = "status";
        this.combo = el("div", "pm-node-combo");
        const toolbar = el("div", "pm-toolbar");
        toolbar.append(button("管理预设", () => openManager(client, () => this.config(), c => this.setConfig(c))),
            button("选择风格", () => openStyles(client, () => this.config(), c => this.setConfig(c))));
        this.styleSummary = el("div", "pm-node-styles");
        this.element.append(toolbar, this.styleSummary, this.status, this.combo);
        for (const side of ["positive", "negative"]) this.createSide(side);
        const widget = node.addDOMWidget("prompt_manager_ui", "prompt-manager", this.element, {
            serialize: false, hideOnZoom: false, getMinHeight: () => 760, getHeight: () => 760,
            surfaces: { canvas: "shown", vueNode: "shown", panel: "never" },
        }); widget.serialize = false;
        this.timer = setInterval(() => this.update(), 350);
        const remove = widget.onRemove;
        widget.onRemove = () => { clearInterval(this.timer); clearTimeout(this.debounce); this.version++; remove?.call(widget); };
        this.update();
    }
    native(name) { return this.node.widgets?.find(w => w.name === name); }
    config() { return parseConfig(this.native("config").value); }
    setConfig(value) { this.write("config", JSON.stringify(value)); this.update(); }
    write(name, value) {
        const widget = this.native(name); widget.value = value; widget.callback?.(value);
        this.node.graph?.change(); this.node.setDirtyCanvas?.(true, true);
    }
    graphKey() {
        // Includes upstream widgets and links, so changing an upstream invalidates old results.
        return JSON.stringify(this.node.graph?._nodes?.map(n => [n.id, n.type,
            n.widgets?.filter(w => w.serialize !== false && w.options?.serialize !== false).map(w => [w.name, w.value]),
            n.inputs?.map(i => [i.name, i.link])]) || []);
    }
    inputs() {
        return { positive: this.native("positive").value, negative: this.native("negative").value, config: this.native("config").value };
    }
    connected() { return this.node.inputs?.some(i => i.link != null && ["positive", "negative", "positive_extra", "negative_extra", "config"].includes(i.name)); }
    createSide(side) {
        const label = side === "positive" ? "正面" : "负面";
        const section = el("section", `pm-side pm-${side}`); section.append(el("h3", "", `${label}提示词 · 用户输入`));
        const area = el("textarea", "pm-user"); area.ariaLabel = `${label}用户输入`; area.spellcheck = false;
        const actions = el("div", "pm-toolbar"), supplement = el("div", "pm-supplement");
        const supplementDetails = el("details", "pm-supplement-details");
        const supplementSummary = el("summary", "", "预设与风格补充");
        const copySupplement = button("复制补充结果", () => copyText(this.sides[side].supplementText)); copySupplement.disabled = true;
        copySupplement.ariaLabel = `${label}复制补充结果`;
        supplementDetails.append(supplementSummary, el("p", "pm-muted", "只读；复制不含来源标签与重复说明"), supplement, copySupplement);
        const details = el("details", "pm-preview-details"), summary = el("summary", "", "编辑预览结果");
        const result = el("textarea", "pm-result"); result.readOnly = true; result.ariaLabel = `${label}编辑预览结果`;
        const execution = el("textarea", "pm-result"); execution.readOnly = true; execution.ariaLabel = `${label}最近执行结果`; execution.hidden = true;
        const runStatus = el("p", "pm-muted"), copyRun = button("复制上次结果", () => copyText(this.lastExecution?.[side] ?? "")); copyRun.hidden = true;
        const history = [], redo = [];
        const state = this.sides[side] = { area, supplement, supplementSummary, copySupplement, supplementText: "", result, summary, execution, runStatus, copyRun, history, redo, selection: [0, 0], last: "" };
        const remember = () => { state.selection = [area.selectionStart, area.selectionEnd]; };
        for (const name of ["select", "keyup", "click", "blur"]) area.addEventListener(name, remember);
        const commit = value => {
            history.push(area.value); if (history.length > 100) history.shift(); redo.length = 0;
            area.value = value; state.last = value; this.write(side, value); this.update();
        };
        area.addEventListener("input", () => {
            history.push(state.last); if (history.length > 100) history.shift(); redo.length = 0;
            state.last = area.value; this.write(side, area.value); remember(); this.update();
        });
        const undo = forward => {
            const from = forward ? redo : history, to = forward ? history : redo;
            if (!from.length) return;
            to.push(area.value); area.value = from.pop(); state.last = area.value;
            this.write(side, area.value); this.update(); area.focus();
        };
        area.addEventListener("keydown", e => {
            if ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
                e.preventDefault(); undo(e.shiftKey || e.key.toLowerCase() === "y");
            }
        });
        actions.append(button("复制原文", () => copyText(area.value)), button("粘贴", () => pasteText(value => {
            const [start, end] = state.selection; commit(area.value.slice(0, start) + value + area.value.slice(end));
            area.focus(); area.setSelectionRange(start + value.length, start + value.length); remember();
        })), button("清空", () => { commit(""); state.selection = [0, 0]; }), button("撤销", () => undo(false)));
        details.append(summary, result, button("复制结果", () => copyText(result.value)), runStatus, execution, copyRun);
        section.append(area, actions, supplementDetails, details); this.element.append(section);
    }
    update() {
        const inputs = this.inputs(), signature = JSON.stringify(inputs), graph = this.graphKey();
        if (this.lastExecution) {
            const stale = this.lastExecution.graph !== graph;
            for (const state of Object.values(this.sides)) state.runStatus.textContent = stale ? "最近执行结果 · 已过期，请重新执行" : "最近执行结果";
        }
        if (signature === this.signature && graph === this.graphSignature) return;
        this.graphSignature = graph;
        const changed = signature !== this.signature; this.signature = signature;
        for (const [side, state] of Object.entries(this.sides)) {
            if (state.area.value !== inputs[side]) {
                state.area.value = inputs[side]; state.last = inputs[side]; state.selection = [inputs[side].length, inputs[side].length];
                state.history.length = 0; state.redo.length = 0;
            }
            const wired = this.node.inputs?.some(i => i.name === side && i.link != null);
            state.area.disabled = wired;
            state.summary.textContent = this.connected() ? "编辑预览 · 未包含上游执行文本" : "编辑预览结果";
            state.supplementSummary.textContent = this.connected() ? "预设与风格补充 · 未包含上游执行文本" : "预设与风格补充";
        }
        if (changed) {
            try {
                renderCombination(this.combo, () => this.config(), c => this.setConfig(c));
                renderStyleSummary(this.styleSummary, () => this.config(), c => this.setConfig(c));
            }
            catch (e) {
                ++this.version; clearTimeout(this.debounce); this.status.textContent = e.message;
                for (const state of Object.values(this.sides)) { state.result.value = ""; state.supplementText = ""; state.copySupplement.disabled = true; state.supplement.textContent = "配置无效，原文已保留"; }
                return;
            }
        }
        this.status.textContent = this.connected() ? "编辑预览未包含上游执行文本；完整输出请执行节点。" : "用户输入优先于上游追加和预设；关闭预设可保留快照。";
        const id = ++this.version; clearTimeout(this.debounce);
        for (const state of Object.values(this.sides)) { state.result.value = ""; state.supplementText = ""; state.copySupplement.disabled = true; state.supplement.textContent = "正在计算…"; }
        this.debounce = setTimeout(async () => {
            try {
                const result = await this.client("merge", inputs);
                if (id !== this.version) return;
                for (const [side, state] of Object.entries(this.sides)) {
                    const data = result[side]; state.result.value = data.text; state.supplement.replaceChildren();
                    state.supplementText = data.accepted.map(row => row.text).join(", ");
                    state.copySupplement.disabled = !state.supplementText;
                    for (const row of data.accepted) state.supplement.append(el("div", "pm-term", `${row.text}　【${row.source}】`));
                    if (!data.accepted.length) state.supplement.append(el("span", "pm-muted", "无补充词条"));
                    const details = el("details"); details.append(el("summary", "", `重复说明与预设原文 · 跳过 ${data.skipped.length} 项`));
                    for (const row of data.skipped) details.append(el("p", "pm-muted", `${row.source}：${row.text} · ${row.reason}`));
                    for (const preset of this.config().presets) details.append(el("pre", "", `${preset.name}${preset.enabled ? "" : "（停用）"}：${preset[side]}`));
                    for (const warning of data.warnings) details.append(el("p", "pm-warning", warning));
                    state.supplement.append(details);
                }
            } catch (e) {
                if (id === this.version) { this.status.textContent = `${e.message} · 输入已保留`; for (const s of Object.values(this.sides)) s.supplement.textContent = "预览暂不可用"; }
            }
        }, 180);
    }
    executed(message) {
        const result = message?.prompt_manager?.[0]; if (!result) return;
        this.lastExecution = { ...result, graph: this.executionGraph ?? "" };
        if (result.input_values && JSON.stringify(result.input_values) !== JSON.stringify(this.inputs())) this.lastExecution.graph = "";
        for (const [side, state] of Object.entries(this.sides)) {
            state.execution.hidden = false; state.execution.value = result[side]; state.copyRun.hidden = false;
        }
        this.update();
    }
}
