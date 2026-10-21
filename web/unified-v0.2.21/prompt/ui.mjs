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
export async function pasteText(insert, target) {
    const status = text => {
        if (!target) return;
        if (!target.pmClipboardStatus) {
            target.pmClipboardStatus = el("p", "pm-hint");
            target.pmClipboardStatus.role = "status";
            target.after(target.pmClipboardStatus);
        }
        target.pmClipboardStatus.textContent = text;
    };
    let value;
    try {
        value = await navigator.clipboard.readText();
    } catch {
        target?.focus();
        status("浏览器未允许读取剪贴板，请允许此站点的剪贴板权限后重试；也可直接在原输入框按 Ctrl+V。");
        return;
    }
    if (!value) { status("剪贴板中没有文字，原提示词已保留。"); return; }
    status("");
    insert(value);
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

export function promptCategoryOverview(library) {
    const categories = Array.isArray(library?.categories) ? library.categories : [];
    const presets = Array.isArray(library?.presets) ? library.presets : [];
    const depthOf = category => {
        let depth = 0, parent = category.parent, seen = new Set([category.id]);
        while (parent) {
            if (seen.has(parent)) break;
            seen.add(parent);
            const ancestor = categories.find(item => item.id === parent);
            if (!ancestor) break;
            depth++;
            parent = ancestor.parent;
        }
        return depth;
    };
    const result = categories.map(category => {
        const branch = descendants(categories, category.id);
        return { id: category.id, name: category.name, parent: category.parent || "", depth: depthOf(category),
            count: presets.filter(preset => preset.categories.some(id => branch.has(id))).length };
    });
    result.push({ id: "uncategorized", name: "未分类", parent: "", depth: 0,
        count: presets.filter(preset => !preset.categories.length).length });
    return result;
}

export function presetsForCategory(library, categoryId = "", search = "") {
    const categories = Array.isArray(library?.categories) ? library.categories : [];
    const presets = Array.isArray(library?.presets) ? library.presets : [];
    const needle = String(search).trim().toLocaleLowerCase();
    const branch = categoryId && categoryId !== "uncategorized" ? descendants(categories, categoryId) : null;
    return presets.filter(preset => {
        const belongs = !categoryId || (categoryId === "uncategorized" ? !preset.categories.length : preset.categories.some(id => branch.has(id)));
        return belongs && (!needle || [preset.name, preset.note, preset.positive, preset.negative].join("\n").toLocaleLowerCase().includes(needle));
    });
}

export async function openManager(client, getConfig, updateConfig) {
    const d = dialog("提示词预设管理"); d.panel.classList.add("pm-manager", "pm-manager-redesign");
    const toolbar = el("div", "pm-toolbar pm-manager-toolbar"), error = el("div", "pm-error"); error.role = "status";
    const grid = el("div", "pm-manager-grid"), catalog = el("section", "pm-library pm-manager-catalog"), inspector = el("aside", "pm-current pm-manager-inspector");
    const search = el("input"); search.type = "search"; search.placeholder = "搜索分类、备注或提示词"; search.ariaLabel = "搜索分类或预设";
    let library, selected = "", selectedPresetId = "", view = "overview", query = "";
    const back = button("全部分类", () => { view = "overview"; selected = ""; selectedPresetId = ""; query = ""; search.value = ""; render(); });
    const newPreset = button("新建预设", () => editPreset());
    const newRoot = button("新建根分类", () => editCategory());
    const newChild = button("新建子分类", () => editCategory(null, selected));
    const refreshButton = button("刷新公共库", refresh);
    toolbar.append(search, back, newPreset, newRoot, newChild, refreshButton);
    grid.append(catalog, inspector); d.body.append(toolbar, error, grid);
    const setConfig = config => { updateConfig(config); render(); };

    async function refresh() {
        try {
            library = await client("library"); error.textContent = "";
            if (selected && selected !== "uncategorized" && !library.categories.some(category => category.id === selected)) {
                selected = ""; view = "overview"; selectedPresetId = "";
            }
            if (selectedPresetId && !library.presets.some(preset => preset.id === selectedPresetId)) selectedPresetId = "";
            render();
        } catch (e) {
            error.textContent = `${e.message}，当前节点快照已保留`;
            if (!library) { catalog.replaceChildren(el("p", "pm-empty", "公共资料库暂不可用；节点中已保存的预设快照仍可使用。")); renderInspector(); }
        }
    }
    search.oninput = () => { query = search.value; render(); };

    function editCategory(category = null, parent = "") {
        if (!library) throw Error("请先加载资料库");
        const editor = dialog(category ? "编辑分类" : "新建分类"); editor.panel.classList.add("pm-category-editor");
        const name = field(editor.body, "名称", category?.name || "");
        const select = field(editor.body, "父分类 / 移动到", "", "select");
        const excluded = category ? descendants(library.categories, category.id) : new Set();
        select.append(new Option("根目录", ""));
        for (const item of library.categories) if (!excluded.has(item.id)) select.append(new Option(item.name, item.id));
        select.value = category?.parent || parent;
        const before = () => JSON.stringify([name.value, select.value]); const original = before();
        editor.cancel = async () => {
            if (before() === original || await confirmAction("放弃未保存的分类草稿？", { title: "放弃未保存的草稿", confirmLabel: "放弃草稿", danger: true })) editor.close();
        };
        const status = el("p", "pm-error"); editor.body.append(status, button("保存分类", async () => {
            try {
                await client("category", { id: category?.id, revision: category?.revision || 0, name: name.value, parent: select.value });
                editor.close(); await refresh();
            } catch (e) { status.textContent = e.message; }
        }));
        name.focus();
    }

    function editPreset(preset = null, duplicate = false) {
        if (!library) throw Error("请先加载资料库");
        const editor = dialog(duplicate ? "复制预设" : preset ? "编辑公共预设" : "新建预设"); editor.panel.classList.add("pm-preset-editor");
        const name = field(editor.body, "名称", (preset?.name || "") + (duplicate ? " 副本" : ""));
        const note = field(editor.body, "备注", preset?.note || "");
        const pos = field(editor.body, "正面提示词", preset?.positive || "", "textarea");
        const neg = field(editor.body, "负面提示词", preset?.negative || "", "textarea");
        const categories = el("fieldset", "pm-category-checks"); categories.append(el("legend", "", "分类（可多选）"));
        const checks = library.categories.map(category => {
            const label = el("label", "pm-category-check", category.name), check = el("input"); check.type = "checkbox";
            check.checked = preset ? preset.categories.includes(category.id) : selected === category.id;
            label.prepend(check); categories.append(label); return [category.id, check];
        }); editor.body.append(categories);
        const state = () => JSON.stringify([name.value, note.value, pos.value, neg.value, checks.map(([id, check]) => [id, check.checked])]);
        const original = state(); editor.cancel = async () => {
            if (state() === original || await confirmAction("放弃未保存的预设草稿？", { title: "放弃未保存的草稿", confirmLabel: "放弃草稿", danger: true })) editor.close();
        };
        const status = el("p", "pm-error"); editor.body.append(status, button("保存公共预设", async () => {
            try {
                await client("preset", { id: duplicate ? undefined : preset?.id, revision: duplicate ? 0 : preset?.revision || 0,
                    name: name.value, note: note.value, positive: pos.value, negative: neg.value,
                    categories: checks.filter(([, check]) => check.checked).map(([id]) => id) });
                editor.close(); await refresh();
            } catch (e) { status.textContent = e.message + " 可保留此草稿，关闭后在管理窗口刷新资料。"; }
        })); name.focus();
    }

    function categoryPath(category) {
        const path = [category.name], seen = new Set([category.id]);
        let parentId = category.parent;
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = library.categories.find(item => item.id === parentId);
            if (!parent) break;
            path.unshift(parent.name); parentId = parent.parent;
        }
        return path.join(" / ");
    }

    function renderOverview() {
        catalog.replaceChildren();
        const heading = el("header", "pm-manager-view-heading");
        heading.append(el("div", "", ""));
        heading.firstChild.append(el("h3", "", "预设分类"), el("p", "pm-muted", "选择分类浏览其中的真实公共预设；修改资料不会改写已有节点快照。"));
        const total = el("span", "pm-result-count", `${library.presets.length} 组预设`); heading.append(total); catalog.append(heading);
        const cards = el("div", "pm-category-grid");
        const entries = promptCategoryOverview(library).filter(item => {
            if (!query.trim()) return true;
            const needle = query.trim().toLocaleLowerCase();
            const sample = presetsForCategory(library, item.id).some(preset => [preset.name, preset.note, preset.positive, preset.negative].join("\n").toLocaleLowerCase().includes(needle));
            return item.name.toLocaleLowerCase().includes(needle) || sample;
        });
        for (const item of entries) {
            const itemPresets = presetsForCategory(library, item.id);
            const card = el("article", "pm-category-card");
            const open = button("", () => { selected = item.id; view = "category"; selectedPresetId = ""; query = ""; search.value = ""; render(); });
            open.classList.add("pm-category-open"); open.ariaLabel = `打开分类 ${item.name}，${item.count} 组预设`;
            const parent = item.parent ? library.categories.find(category => category.id === item.parent) : null;
            open.append(el("span", "pm-category-meta", item.id === "uncategorized" ? "系统分类" : parent ? `上级 · ${parent.name}` : "根分类"),
                el("strong", "pm-category-name", item.name), el("span", "pm-category-count", `${item.count} 组`));
            const sample = itemPresets[0];
            open.append(el("span", "pm-category-preview", sample ? `${sample.name} · ${sample.positive || sample.note || "暂无正面提示词"}` : "这个分类还没有预设"));
            card.append(open);
            if (item.id !== "uncategorized") {
                const category = library.categories.find(value => value.id === item.id);
                if (category) card.append(button("编辑分类", () => editCategory(category)));
            }
            cards.append(card);
        }
        catalog.append(cards);
        if (!entries.length) catalog.append(el("p", "pm-empty", query ? "没有匹配的分类或预设" : "还没有分类；先建立一个分类，再添加公共预设。"));
        renderInspector();
    }

    function renderPresetCards(category) {
        const items = presetsForCategory(library, selected, query);
        const heading = el("header", "pm-manager-view-heading pm-category-view-heading");
        const title = el("div"); title.append(el("h3", "", selected === "uncategorized" ? "未分类预设" : category.name),
            el("p", "pm-muted", selected === "uncategorized" ? "这些真实预设尚未关联分类。" : `${categoryPath(category)} · 包含子分类中的预设`));
        heading.append(title, el("span", "pm-result-count", `${items.length} 组`));
        const categoryActions = el("div", "pm-category-actions");
        if (category) {
            categoryActions.append(button("新建子分类", () => editCategory(null, category.id)),
                button("重命名 / 移动", () => editCategory(category)),
                button("删除分类", async () => {
                    const count = descendants(library.categories, category.id).size;
                    if (await confirmAction(`删除“${category.name}”及其子分类，共 ${count} 个分类？预设会保留，无分类的预设进入未分类。`, { title: "删除分类", confirmLabel: "确认删除", danger: true })) {
                        try { await client("delete", { kind: "category", id: category.id, revision: category.revision }); selected = ""; view = "overview"; await refresh(); }
                        catch (e) { error.textContent = e.message; }
                    }
                }));
        }
        const cardGrid = el("div", "pm-preset-grid");
        for (const preset of items) {
            const card = el("article", "pm-preset-card");
            const focus = button("", () => { selectedPresetId = preset.id; render(); });
            focus.classList.add("pm-preset-focus"); focus.ariaPressed = String(selectedPresetId === preset.id); focus.ariaLabel = `查看预设 ${preset.name}`;
            const categoryNames = preset.categories.map(id => library.categories.find(item => item.id === id)?.name).filter(Boolean);
            focus.append(el("span", "pm-preset-category", categoryNames.join(" · ") || "未分类"), el("strong", "pm-preset-name", preset.name), el("span", "pm-muted pm-preset-note", preset.note || "无备注"));
            focus.append(el("pre", "pm-preset-excerpt", preset.positive || "暂无正面提示词"));
            card.append(focus, button("应用", () => setConfig(applyPreset(getConfig(), preset))));
            cardGrid.append(card);
        }
        catalog.replaceChildren(heading, categoryActions, cardGrid);
        if (!items.length) catalog.append(el("p", "pm-empty", query ? "没有匹配的预设" : "这个分类还没有预设。"));
        renderInspector(items.find(item => item.id === selectedPresetId) || null);
    }

    function renderInspector(preset = null) {
        inspector.replaceChildren();
        if (preset) {
            inspector.append(el("h3", "", "预设编辑区"), el("h4", "pm-inspector-title", preset.name));
            inspector.append(el("p", "pm-muted", preset.note || "无备注"));
            inspector.append(el("label", "pm-prompt-preview-label", "正面提示词"), el("pre", "pm-prompt-preview", preset.positive || "（空）"),
                el("label", "pm-prompt-preview-label", "负面提示词"), el("pre", "pm-prompt-preview", preset.negative || "（空）"));
            const actions = el("div", "pm-inspector-actions");
            actions.append(button("应用到当前节点", () => setConfig(applyPreset(getConfig(), preset))),
                button("编辑", () => editPreset(preset)), button("复制预设", () => editPreset(preset, true)),
                button("删除", async () => {
                    if (!await confirmAction(`永久删除公共预设“${preset.name}”？已保存的节点快照仍保留。`, { title: "删除公共预设", confirmLabel: "确认删除", danger: true })) return;
                    try { await client("delete", { kind: "preset", id: preset.id, revision: preset.revision }); selectedPresetId = ""; await refresh(); }
                    catch (e) { error.textContent = e.message; }
                }));
            inspector.append(actions);
        } else {
            inspector.append(el("h3", "", "预设编辑区"), el("p", "pm-empty", view === "overview" ? "先选择一个分类。" : "选择一组预设，查看完整提示词并编辑或应用。"));
        }
        inspector.append(el("h3", "pm-combination-heading", "当前节点组合"), el("p", "pm-muted", "从上到下优先；同步才会更新节点快照，关闭开关保留位置。"));
        const combo = el("div", "pm-combination-list"); inspector.append(combo);
        renderCombination(combo, getConfig, setConfig, library);
    }

    function render() {
        if (!library) return;
        const category = selected === "uncategorized" ? null : library.categories.find(item => item.id === selected);
        back.hidden = view === "overview";
        newRoot.hidden = view !== "overview";
        newChild.hidden = view !== "category" || !category;
        newPreset.hidden = false;
        search.placeholder = view === "overview" ? "搜索分类或预设内容" : "搜索名称、备注或提示词";
        search.ariaLabel = view === "overview" ? "搜索分类或预设" : "搜索预设";
        if (view === "overview") renderOverview();
        else if (category || selected === "uncategorized") renderPresetCards(category);
        else { view = "overview"; selected = ""; renderOverview(); }
    }

    await refresh();
}
