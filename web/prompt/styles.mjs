import { applyStyle } from "./state.mjs";
import { el, button, dialog, confirmAction } from "./ui.mjs";

const TAB_KEY = "prompt-manager.v2.style-tab";
export function renderStyleSummary(parent, getConfig, setConfig) {
    parent.replaceChildren();
    const c = getConfig();
    const label = el("label", "pm-style-switch", "风格启用"), toggle = el("input");
    toggle.type = "checkbox"; toggle.checked = c.style_enabled; toggle.ariaLabel = "风格启用";
    toggle.onchange = () => { const value = getConfig(); value.style_enabled = toggle.checked; setConfig(value); };
    label.prepend(toggle); parent.append(label);
    const details = el("details", "pm-style-details");
    details.open = c.style_enabled;
    const count = c.styles.length;
    const summary = el("summary", "", count ? `风格设置 · ${count} 项${c.style_enabled ? "" : " · 未启用"}` : "风格设置 · 未选择");
    details.append(summary);
    const selected = el("div", "pm-style-selected");
    for (const [index, s] of c.styles.entries()) {
        const chip = el("div", "pm-style-chip"); chip.append(el("span", "", `${index + 1}. ${s.name}`));
        const up = button("↑", () => { const v = getConfig(); [v.styles[index - 1], v.styles[index]] = [v.styles[index], v.styles[index - 1]]; setConfig(v); });
        up.disabled = index === 0; up.ariaLabel = `上移风格 ${s.name}`;
        const remove = button("×", () => { const v = getConfig(); v.styles.splice(index, 1); setConfig(v); }); remove.ariaLabel = `移除风格 ${s.name}`;
        chip.append(up, remove); selected.append(chip);
    }
    if (!c.styles.length) selected.append(el("span", "pm-muted", "未选择风格，点击“选择风格”浏览"));
    details.append(selected);
    const order = el("select"); order.ariaLabel = "风格拼接方式";
    for (const [value, title] of [["user", "用户词在前"], ["style", "风格在前"]]) order.append(new Option(title, value));
    order.value = c.style_order;
    order.onchange = () => { const v = getConfig(); v.style_order = order.value; setConfig(v); };
    const field = el("label", "pm-field", "拼接方式"); field.append(order); details.append(field);
    parent.append(details);
}

export async function openStyles(client, getConfig, setConfig) {
    const d = dialog("选择风格"); d.panel.classList.add("pm-style-manager");
    const tabs = el("div", "pm-toolbar pm-style-tabs"); tabs.role = "tablist"; tabs.ariaLabel = "风格范围";
    let tab = "all", library = { styles: [], favorites: [] }, query = "", category = "";
    try { tab = localStorage.getItem(TAB_KEY) === "favorites" ? "favorites" : "all"; } catch { /* optional browser preference */ }
    const all = button("全部风格", () => switchTab("all")), favorites = button("收藏风格", () => switchTab("favorites"));
    all.role = favorites.role = "tab";
    tabs.append(all, favorites);
    const tools = el("div", "pm-toolbar"), search = el("input"), categorySelect = el("select");
    search.type = "search"; search.placeholder = "搜索中文、英文名称或提示词"; search.ariaLabel = "搜索风格";
    categorySelect.ariaLabel = "风格分类";
    const multi = button("", () => {
        const c = getConfig();
        if (c.multi_select && c.styles.length > 1) { status.textContent = "请先保留一个风格，再切换单选"; return; }
        c.multi_select = !c.multi_select; setConfig(c); render();
    }); multi.ariaLabel = "切换风格多选";
    tools.append(search, categorySelect, multi, button("清空选择", () => { const c = getConfig(); c.styles = []; setConfig(c); render(); }));
    const maintenance = el("div", "pm-toolbar");
    maintenance.append(button("导入本地风格库", importLibrary), button("新建风格", () => editStyle()), button("刷新", refresh));
    const status = el("div", "pm-error"); status.role = "status";
    const grid = el("div", "pm-style-grid"); grid.role = "tabpanel"; grid.ariaLabel = "风格卡片";
    const selected = el("div", "pm-current-styles");
    d.body.append(tabs, tools, maintenance, status, grid, el("h3", "", "当前节点已选风格"), selected);
    search.oninput = () => { query = search.value.trim().toLocaleLowerCase(); render(); };
    categorySelect.onchange = () => { category = categorySelect.value; render(); };
    function switchTab(value) { tab = value; try { localStorage.setItem(TAB_KEY, value); } catch { /* optional */ } render(); }
    function options(select, values, first, current) {
        select.replaceChildren(new Option(first, ""));
        for (const value of [...new Set(values)].sort()) select.append(new Option(value, value));
        select.value = current; if (select.selectedIndex < 0) select.value = "";
        return select.value;
    }
    async function refresh() {
        try { library = await client("styles"); status.textContent = ""; render(); }
        catch (e) { status.textContent = `${e.message}；当前节点文本快照已保留`; }
    }
    async function importLibrary() {
        const editor = dialog("导入本地风格库");
        editor.body.append(el("p", "pm-muted", "选择包含 styles.json 和 thumbs 的本地目录。文本和封面复制到当前用户数据目录，不修改来源插件。"));
        const path = el("input"); path.ariaLabel = "风格目录"; path.placeholder = "例如：…/ComfyUI_JosiaNodes/Style/krea2";
        const feedback = el("div", "pm-error"); feedback.role = "status";
        const submit = button("导入", async () => {
            submit.disabled = true;
            try { const result = await client("style-import", { path: path.value }); editor.close(); await refresh(); status.textContent = `共 ${result.total} 个风格，本次更新 ${result.imported} 个；缺少封面 ${result.missing_covers} 个`; }
            catch (e) { feedback.textContent = e.message; }
            finally { submit.disabled = false; }
        }); editor.body.append(path, feedback, submit); path.focus();
    }
    function editStyle(style = null) {
        const editor = dialog(style ? "编辑风格" : "新建风格");
        const fields = {};
        for (const [key, title, type] of [["name", "名称", "input"], ["category", "分类", "input"], ["positive", "正面风格提示词", "textarea"], ["negative", "负面风格提示词", "textarea"]]) {
            const label = el("label", "pm-field", title), input = el(type); input.ariaLabel = title;
            input.value = style?.[key] || ({ category: "未分类", theme: "自定义" }[key] ?? ""); label.append(input); editor.body.append(label); fields[key] = input;
        }
        const type = el("select"); type.ariaLabel = "文本类型"; type.append(new Option("完整段落（不拆分长描述）", "paragraph"), new Option("逗号词条（参与词条去重）", "tags")); type.value = style?.text_type || "paragraph";
        const cover = el("input"); cover.type = "file"; cover.accept = "image/png,image/jpeg,image/webp"; cover.ariaLabel = "风格封面";
        editor.body.append(el("label", "pm-field", "文本类型"), type, el("label", "pm-field", "封面（可选，不超过 1 MB）"), cover);
        const feedback = el("div", "pm-error"); feedback.role = "status"; editor.body.append(feedback);
        const initial = JSON.stringify(Object.values(fields).map(f => f.value).concat(type.value));
        editor.cancel = async () => {
            if (!cover.files.length && initial === JSON.stringify(Object.values(fields).map(f => f.value).concat(type.value)) || await confirmAction("放弃未保存的风格草稿？", { title: "放弃草稿", confirmLabel: "放弃草稿", danger: true })) editor.close();
        };
        const submit = button("保存风格", async () => {
            submit.disabled = true;
            try {
                const file = cover.files[0]; if (file?.size > 1024 * 1024) throw Error("封面不能超过 1 MB");
                const image = file ? await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(Error("封面读取失败")); r.readAsDataURL(file); }) : undefined;
                await client("style-save", { id: style?.id, revision: style?.revision || 0, english: style?.english || "", theme: style?.theme || "自定义", ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])), text_type: type.value, cover: image });
                editor.close(); await refresh();
            } catch (e) { feedback.textContent = e.message; }
            finally { submit.disabled = false; }
        }); editor.body.append(submit);
    }
    function render() {
        all.ariaSelected = String(tab === "all"); favorites.ariaSelected = String(tab === "favorites");
        all.classList.toggle("pm-active", tab === "all"); favorites.classList.toggle("pm-active", tab === "favorites");
        const c = getConfig(); multi.textContent = `${c.multi_select ? "多选" : "单选"} ${c.styles.length}/${c.multi_select ? 3 : 1}`;
        const favoriteIds = new Set(library.favorites);
        const scoped = library.styles.filter(s => tab === "all" || favoriteIds.has(s.id));
        category = options(categorySelect, scoped.map(s => s.category), "全部分类", category);
        grid.replaceChildren();
        const items = scoped.filter(s => (!category || s.category === category) && [s.name, s.english, s.positive, s.negative].join("\n").toLocaleLowerCase().includes(query));
        for (const s of items) {
            const card = el("article", "pm-style-card"), pick = button("", () => {
                try { setConfig(applyStyle(getConfig(), s)); status.textContent = ""; render(); }
                catch (e) { status.textContent = e.message; }
            }); pick.classList.add("pm-style-pick"); pick.ariaLabel = `选择风格 ${s.name}`; pick.ariaPressed = String(c.styles.some(x => x.id === s.id));
            const preview = el("div", "pm-style-cover");
            if (s.image) { const img = el("img"); img.src = `/prompt-manager/v1/style-image/${encodeURIComponent(s.id)}?r=${s.revision}`; img.alt = s.name; img.loading = "lazy"; img.onerror = () => { img.remove(); preview.textContent = "封面缺失 · 文本可用"; }; preview.append(img); }
            else preview.textContent = "无封面";
            pick.append(preview, el("span", "pm-style-name", s.name));
            const favorite = button(favoriteIds.has(s.id) ? "★" : "☆", async () => {
                favorite.disabled = true;
                try { await client("style-favorite", { id: s.id, favorite: !favoriteIds.has(s.id) }); await refresh(); }
                catch (e) { status.textContent = e.message; favorite.disabled = false; }
            }); favorite.ariaLabel = `${favoriteIds.has(s.id) ? "取消收藏" : "收藏"} ${s.name}`; favorite.ariaPressed = String(favoriteIds.has(s.id)); favorite.classList.add("pm-style-favorite");
            const details = el("details"), summary = el("summary", "", "查看描述 / 编辑"); details.append(summary, el("p", "pm-muted", s.category), el("pre", "", `正面：${s.positive}\n负面：${s.negative || "（空）"}`));
            details.append(button("编辑风格", () => editStyle(s)), button("删除风格", async () => {
                if (!await confirmAction(`删除公共风格“${s.name}”？已保存节点的文本快照仍保留。`, { title: "删除风格", confirmLabel: "确认删除", danger: true })) return;
                try { await client("style-delete", { id: s.id, revision: s.revision }); await refresh(); } catch (e) { status.textContent = e.message; }
            })); card.append(pick, favorite, details); grid.append(card);
        }
        if (!items.length) grid.append(el("p", "pm-muted", !library.styles.length ? "暂无风格，请导入本地风格库或新建风格。" : tab === "favorites" && !scoped.length ? "暂无收藏，请到全部风格中点击 ☆ 收藏。" : "没有匹配的风格。"));
        selected.replaceChildren(); renderStyleSummary(selected, getConfig, value => { setConfig(value); render(); });
        for (const snapshot of c.styles) {
            const current = library.styles.find(s => s.id === snapshot.id);
            if (!current) selected.append(el("p", "pm-muted", `${snapshot.name}：来源缺失，保留文本快照`));
            else if (current.revision !== snapshot.revision) selected.append(button(`同步更新 ${snapshot.name}`, () => { setConfig(applyStyle(getConfig(), current, true)); render(); }));
        }
    }
    await refresh();
}
