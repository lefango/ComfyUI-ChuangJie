import { applyPreset, descendants, movePreset } from "./state.mjs";

export function el(tag, cls = "", content) {
    const node = document.createElement(tag); node.className = cls;
    if (content !== undefined) node.textContent = content;
    return node;
}
export function button(label, action) {
    const b = el("button", "pm-button", label); b.type = "button";
    b.addEventListener("click", async () => { b.disabled = true; try { await action(); } catch (e) { message(e.message); } finally { b.disabled = false; } });
    return b;
}
export function isolate(node) {
    for (const name of ["keydown", "keyup", "pointerdown", "mousedown", "dblclick", "wheel"])
        node.addEventListener(name, e => e.stopPropagation());
}
export function message(text) {
    const d = dialog("提示词管理器"); d.body.append(el("p", "", text)); d.body.append(button("关闭", d.close));
}
export function dialog(title) {
    const overlay = el("div", "pm-overlay"), panel = el("section", "pm-dialog");
    panel.role = "dialog"; panel.ariaModal = "true"; panel.ariaLabel = title; panel.tabIndex = -1;
    const heading = el("header", "pm-heading", title), body = el("div", "pm-body");
    const previous = document.activeElement;
    const result = { overlay, panel, body, close: () => { overlay.remove(); previous?.focus(); }, cancel: null };
    const close = () => result.cancel ? result.cancel() : result.close();
    heading.append(button("关闭", close)); panel.append(heading, body); overlay.append(panel);
    isolate(overlay);
    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        if (e.key === "Tab") {
            const items = [...panel.querySelectorAll("button,input,textarea,select,[tabindex='0']")].filter(x => !x.disabled && x.offsetParent !== null);
            if (!items.length) { e.preventDefault(); return; }
            if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); }
            if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
        }
    });
    document.body.append(overlay); panel.focus(); return result;
}
export function confirmAction(text, { title = "确认操作", confirmLabel = "确认", danger = false } = {}) {
    return new Promise(resolve => {
        const d = dialog(title); d.panel.role = "alertdialog";
        let settled = false;
        const finish = accepted => {
            if (settled) return;
            settled = true; d.close(); resolve(accepted);
        };
        d.cancel = () => finish(false);
        const actions = el("div", "pm-confirm-actions");
        const cancel = button("取消", () => finish(false));
        const accept = button(confirmLabel, () => finish(true));
        if (danger) accept.classList.add("pm-button-danger");
        actions.append(cancel, accept); d.body.append(el("p", "pm-confirm-text", text), actions);
        // Keep destructive actions explicit; Enter initially activates Cancel.
        cancel.focus();
    });
}
export async function copyText(value) {
    try { await navigator.clipboard.writeText(value); }
    catch {
        const d = dialog("剪贴板不可用，请选中文字后按 Ctrl+C");
        const area = el("textarea"); area.value = value; area.readOnly = true;
        d.body.append(area, button("关闭", d.close)); area.focus(); area.select();
    }
}
export async function pasteText(insert) {
    try { insert(await navigator.clipboard.readText()); }
    catch {
        const d = dialog("请在下方手动粘贴，再点击插入"); const area = el("textarea");
        d.body.append(area, button("插入", () => { insert(area.value); d.close(); })); area.focus();
    }
}
function field(parent, name, value = "", tag = "input") {
    const label = el("label", "pm-field", name), input = el(tag); input.value = value;
    input.ariaLabel = name;
    label.append(input); parent.append(label); return input;
}

export function renderCombination(parent, getConfig, setConfig, library = null) {
    parent.replaceChildren();
    getConfig().presets.forEach((p, index) => {
        const row = el("div", "pm-combination"); row.draggable = true;
        row.addEventListener("dragstart", e => { e.dataTransfer.setData("text/x-pm-index", String(index)); });
        row.addEventListener("dragover", e => e.preventDefault());
        row.addEventListener("drop", e => {
            e.preventDefault(); const raw = e.dataTransfer.getData("text/x-pm-index");
            if (/^\d+$/.test(raw)) setConfig(movePreset(getConfig(), Number(raw), index));
        });
        const check = el("input"); check.type = "checkbox"; check.checked = p.enabled; check.ariaLabel = `启用 ${p.name}`;
        check.onchange = () => { const c = getConfig(); c.presets[index].enabled = check.checked; setConfig(c); };
        const name = el("span", "pm-combination-name", `${index + 1}. ${p.name}`);
        if (library) {
            const current = library.presets.find(x => x.id === p.id);
            name.append(el("small", "", !current ? " 来源缺失 · 保留快照" : current.revision !== p.revision ? " 有更新 · 点击同步" : ` r${p.revision}`));
        }
        row.append(check, name, button("↑", () => setConfig(movePreset(getConfig(), index, index - 1))),
            button("↓", () => setConfig(movePreset(getConfig(), index, index + 1))));
        if (library) row.append(button("同步", () => {
            const current = library.presets.find(x => x.id === p.id);
            if (!current) throw Error("来源已删除，当前快照仍可使用");
            setConfig(applyPreset(getConfig(), current, true));
        }));
        row.append(button("移除", () => { const c = getConfig(); c.presets.splice(index, 1); setConfig(c); }));
        parent.append(row);
    });
    if (!getConfig().presets.length) parent.append(el("p", "pm-muted", "尚未选择预设"));
}

export async function openManager(client, getConfig, updateConfig) {
    const d = dialog("提示词预设管理"); d.panel.classList.add("pm-manager");
    const toolbar = el("div", "pm-toolbar"), error = el("div", "pm-error"); error.role = "status";
    const tree = el("aside", "pm-tree"), center = el("section", "pm-library"), right = el("aside", "pm-current");
    const grid = el("div", "pm-manager-grid"); grid.append(tree, center, right); d.body.append(toolbar, error, grid);
    let library, selected = "", query = "", folded = new Set();
    try { folded = new Set(JSON.parse(localStorage.getItem("prompt-manager.v1.folded") || "[]")); } catch { /* private mode */ }
    const search = el("input"); search.placeholder = "搜索名称、备注或提示词"; search.ariaLabel = "搜索预设";
    const setConfig = c => { updateConfig(c); render(); };
    async function refresh() {
        try { library = await client("library"); error.textContent = ""; render(); }
        catch (e) { error.textContent = `${e.message}，节点快照已保留`; }
    }
    toolbar.append(search, button("新建预设", () => editPreset()), button("新建根分类", () => editCategory()), button("刷新公共库", refresh));
    search.oninput = () => { query = search.value.toLocaleLowerCase(); render(); };

    function editCategory(category = null, parent = "") {
        if (!library) throw Error("请先加载资料库");
        const editor = dialog(category ? "编辑分类" : "新建分类");
        const name = field(editor.body, "名称", category?.name || "");
        const select = field(editor.body, "父分类 / 移动到", "", "select");
        const excluded = category ? descendants(library.categories, category.id) : new Set();
        select.append(new Option("根目录", ""));
        for (const c of library.categories) if (!excluded.has(c.id)) select.append(new Option(c.name, c.id));
        select.value = category?.parent || parent;
        const before = () => JSON.stringify([name.value, select.value]); const original = before();
        editor.cancel = async () => {
            if (before() === original || await confirmAction("放弃未保存的分类草稿？", { title: "放弃未保存的草稿", confirmLabel: "放弃草稿", danger: true })) editor.close();
        };
        const status = el("p", "pm-error"); editor.body.append(status, button("保存分类", async () => {
            try { await client("category", { id: category?.id, revision: category?.revision || 0, name: name.value, parent: select.value }); editor.close(); await refresh(); }
            catch (e) { status.textContent = e.message; }
        }));
        name.focus();
    }
    function editPreset(preset = null, duplicate = false) {
        if (!library) throw Error("请先加载资料库");
        const editor = dialog(duplicate ? "复制预设" : preset ? "编辑公共预设" : "新建预设");
        const name = field(editor.body, "名称", (preset?.name || "") + (duplicate ? " 副本" : ""));
        const note = field(editor.body, "备注", preset?.note || "");
        const pos = field(editor.body, "正面提示词", preset?.positive || "", "textarea");
        const neg = field(editor.body, "负面提示词", preset?.negative || "", "textarea");
        const categories = el("fieldset"); categories.append(el("legend", "", "分类（可多选）"));
        const checks = library.categories.map(c => {
            const label = el("label", "pm-category-check", c.name), check = el("input"); check.type = "checkbox";
            check.checked = preset ? preset.categories.includes(c.id) : selected === c.id;
            label.prepend(check); categories.append(label); return [c.id, check];
        }); editor.body.append(categories);
        const state = () => JSON.stringify([name.value, note.value, pos.value, neg.value, checks.map(([id, c]) => [id, c.checked])]);
        const original = state(); editor.cancel = async () => {
            if (state() === original || await confirmAction("放弃未保存的预设草稿？", { title: "放弃未保存的草稿", confirmLabel: "放弃草稿", danger: true })) editor.close();
        };
        const status = el("p", "pm-error"); editor.body.append(status, button("保存公共预设", async () => {
            try {
                await client("preset", { id: duplicate ? undefined : preset?.id, revision: duplicate ? 0 : preset?.revision || 0,
                    name: name.value, note: note.value, positive: pos.value, negative: neg.value, categories: checks.filter(([, c]) => c.checked).map(([id]) => id) });
                editor.close(); await refresh();
            } catch (e) { status.textContent = e.message + " 可保留此草稿，关闭后在管理窗口刷新资料。"; }
        })); name.focus();
    }
    function render() {
        if (!library) return;
        const category = library.categories.find(c => c.id === selected);
        const heading = el("div", "pm-tree-header"); heading.append(el("h3", "", "分类"));
        const createChild = button("新建子分类", () => editCategory(null, category.id));
        createChild.disabled = !category;
        createChild.title = category ? `在“${category.name}”下新建子分类` : "请先选择一个分类";
        heading.append(createChild); tree.replaceChildren(heading);
        tree.append(button("全部预设", () => { selected = ""; render(); }), button("未分类", () => { selected = "uncategorized"; render(); }));
        function branch(parent, depth = 0) {
            for (const c of library.categories.filter(x => x.parent === parent)) {
                const row = el("div", "pm-tree-row"); row.style.paddingLeft = `${depth * 14}px`;
                row.append(button(folded.has(c.id) ? "▸" : "▾", () => {
                    folded.has(c.id) ? folded.delete(c.id) : folded.add(c.id);
                    try { localStorage.setItem("prompt-manager.v1.folded", JSON.stringify([...folded])); } catch { /* private mode */ }
                    render();
                }), button(c.name, () => { selected = c.id; render(); }));
                if (selected === c.id) row.classList.add("pm-selected"); tree.append(row);
                if (!folded.has(c.id)) branch(c.id, depth + 1);
            }
        } branch("");
        if (category) tree.append(button("重命名 / 移动", () => editCategory(category)), button("删除分类", async () => {
            const count = descendants(library.categories, category.id).size;
            if (await confirmAction(`删除“${category.name}”及其子分类，共 ${count} 个分类？预设会保留，无分类的预设进入未分类。`, { title: "删除分类", confirmLabel: "确认删除", danger: true })) {
                await client("delete", { kind: "category", id: category.id, revision: category.revision }); selected = ""; await refresh();
            }
        }));
        center.replaceChildren(el("h3", "", "公共预设 · 编辑不改变已有节点快照"));
        const ids = descendants(library.categories, selected);
        const items = library.presets.filter(p => (!selected || selected === "uncategorized" && !p.categories.length || p.categories.some(c => ids.has(c))) &&
            [p.name, p.note, p.positive, p.negative].join("\n").toLocaleLowerCase().includes(query));
        for (const p of items) {
            const card = el("article", "pm-card"); card.append(el("h4", "", p.name), el("p", "pm-muted", p.note));
            card.append(el("pre", "pm-positive", `正面：${p.positive || "（空）"}`), el("pre", "pm-negative", `负面：${p.negative || "（空）"}`));
            const actions = el("div", "pm-toolbar"); actions.append(button("启用", () => setConfig(applyPreset(getConfig(), p))),
                button("编辑", () => editPreset(p)), button("复制预设", () => editPreset(p, true)), button("删除", async () => {
                    if (await confirmAction(`永久删除公共预设“${p.name}”？已保存的节点快照仍保留。`, { title: "删除公共预设", confirmLabel: "确认删除", danger: true })) { await client("delete", { kind: "preset", id: p.id, revision: p.revision }); await refresh(); }
                })); card.append(actions); center.append(card);
        }
        if (!items.length) center.append(el("p", "pm-muted", "没有匹配的预设"));
        right.replaceChildren(el("h3", "", "当前节点组合 · 从上到下优先"));
        const combo = el("div"); right.append(combo); renderCombination(combo, getConfig, setConfig, library);
        right.append(el("p", "pm-muted", "拖动或点击箭头排序。同步才会更新节点快照；关闭开关保留位置。"));
    }
    await refresh();
}
