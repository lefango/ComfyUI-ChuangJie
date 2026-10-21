import { applyStyle } from "./state.mjs";
import { el, button, dialog, confirmAction } from "./ui.mjs";

const TAB_KEY = "prompt-manager.v2.style-tab";
const PAGE_SIZE = 40;
// View groups retain the complete API records; they are never persisted as categories.
export function groupStylesByCategory(styles) {
    const groups = new Map();
    for (const style of styles) {
        const name = style.category?.trim() || "未分类";
        if (!groups.has(name)) groups.set(name, { name, count: 0, styles: [] });
        const group = groups.get(name);
        group.styles.push(style); group.count++;
    }
    return [...groups.values()];
}

export function toggleStyleMultiSelect(config) {
    if (config.multi_select && config.styles.length > 1) throw Error("请先保留一个风格，再切换单选");
    return { ...config, multi_select: !config.multi_select };
}
export function renderStyleSummary(parent, getConfig, setConfig, showToggle = true, initialDetailsOpen) {
    const wasOpen = parent.querySelector("details.pm-style-details")?.open;
    parent.replaceChildren();
    const c = getConfig();
    if (showToggle) {
        const label = el("label", "pm-style-switch", "风格启用"), toggle = el("input");
        toggle.type = "checkbox"; toggle.checked = c.style_enabled; toggle.ariaLabel = "风格启用";
        toggle.onchange = () => { const value = getConfig(); value.style_enabled = toggle.checked; setConfig(value); };
        label.prepend(toggle); parent.append(label);
    }
    const details = el("details", "pm-style-details");
    details.open = wasOpen ?? initialDetailsOpen ?? c.style_enabled;
    const count = c.styles.length;
    const summary = el("summary", "", count ? `已选风格 · ${count} 项${c.style_enabled ? "" : " · 未启用"}` : "已选风格 · 未选择");
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

export async function openStyles(client, getConfig, setConfig, styleReferenceControls = null) {
    const d = dialog("选择风格"); d.panel.classList.add("pm-style-manager");
    const tabs = el("div", "pm-toolbar pm-style-tabs"); tabs.role = "tablist"; tabs.ariaLabel = "风格范围";
    let tab = "all", library = { styles: [], favorites: [] }, query = "", category = "", focusedId = "";
    let visibleItems = [], renderedCount = 0, activeEditor = null;
    try { tab = localStorage.getItem(TAB_KEY) === "favorites" ? "favorites" : "all"; } catch { /* optional browser preference */ }
    const all = button("全部风格", () => switchTab("all")), favorites = button("收藏风格", () => switchTab("favorites"));
    all.role = favorites.role = "tab";
    const referenceStrength = styleReferenceControls ? button("参考强度", () => switchTab("strength")) : null;
    if (referenceStrength) referenceStrength.role = "tab";
    tabs.append(all, favorites);
    if (referenceStrength) tabs.append(referenceStrength);
    const tools = el("div", "pm-toolbar pm-style-toolbar"), search = el("input");
    search.type = "search"; search.placeholder = "搜索中文、英文名称或提示词"; search.ariaLabel = "搜索风格";
    const multi = button("", () => {
        try { setConfig(toggleStyleMultiSelect(getConfig())); status.textContent = ""; render(); }
        catch (e) { status.textContent = e.message; }
    }); multi.ariaLabel = "切换风格多选";
    tools.append(search, multi, button("清空选择", () => { const c = getConfig(); c.styles = []; setConfig(c); render(); }));
    const maintenance = el("div", "pm-toolbar");
    maintenance.append(button("导入本地风格库", importLibrary), button("新建风格", () => editStyle()), button("刷新", refresh));
    const status = el("div", "pm-error"); status.role = "status";
    const grid = el("div", "pm-style-grid"); grid.role = "tabpanel"; grid.ariaLabel = "风格卡片";
    const overview = el("div", "pm-style-category-grid"); overview.ariaLabel = "风格分类总览";
    const breadcrumb = el("div", "pm-style-breadcrumb");
    const detailLayout = el("div", "pm-style-detail-layout"), detail = el("aside", "pm-style-editor"); detail.ariaLabel = "风格详情";
    detailLayout.append(grid, detail);
    const loadMoreStatus = el("div", "pm-style-more", "向下滚动到列表底部自动加载下一批风格"); loadMoreStatus.role = "status";
    const selected = el("div", "pm-current-styles");
    const catalogPanel = el("div", "pm-style-content");
    catalogPanel.append(el("h2", "pm-style-heading", "风格参考"), tools, maintenance, status, breadcrumb, overview, detailLayout, el("h3", "", "当前节点已选风格"), selected);
    const strengthPanel = el("section", "pm-style-strength-panel");
    if (styleReferenceControls) strengthPanel.append(styleReferenceControls);
    d.body.append(tabs, catalogPanel, strengthPanel);
    d.cancel = async () => { if (!activeEditor || await activeEditor.cancel()) { observer?.disconnect(); d.close(); } };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && renderedCount < visibleItems.length) appendNextPage();
    }, { root: grid, rootMargin: "120px 0px", threshold: 0 }) : null;
    const onGridScroll = () => {
        if (!observer && grid.scrollHeight - grid.scrollTop - grid.clientHeight < 160 && renderedCount < visibleItems.length) appendNextPage();
    };
    grid.addEventListener("scroll", onGridScroll, { passive: true });
    search.oninput = () => { query = search.value.trim().toLocaleLowerCase(); render(); };
    function switchTab(value) {
        if (value === "strength" && (!styleReferenceControls || styleReferenceControls.hidden)) return;
        tab = value;
        if (value !== "strength") try { localStorage.setItem(TAB_KEY, value); } catch { /* optional browser preference */ }
        if (value === "strength") {
            const strength = styleReferenceControls.querySelector(".pm-krea-strength");
            if (strength?.tagName === "DETAILS") strength.open = true;
        }
        render();
    }
    async function refresh() {
        try { library = await client("styles"); status.textContent = ""; render(); }
        catch (e) { status.textContent = `${e.message}；当前节点文本快照已保留`; }
    }
    function renderSelected() {
        const c = getConfig();
        renderStyleSummary(selected, getConfig, value => { setConfig(value); render(); }, true, false);
        for (const snapshot of c.styles) {
            const current = library.styles.find(s => s.id === snapshot.id);
            if (!current) selected.append(el("p", "pm-muted", `${snapshot.name}：来源缺失，保留文本快照`));
            else if (current.revision !== snapshot.revision) selected.append(button(`同步更新 ${snapshot.name}`, () => { setConfig(applyStyle(getConfig(), current, true)); render(); }));
        }
    }
    function coverFor(s) {
        const preview = el("div", "pm-style-cover");
        if (s?.image) {
            const img = el("img"); img.src = `/prompt-manager/v1/style-image/${encodeURIComponent(s.id)}?r=${s.revision}`;
            img.alt = s.name; img.loading = "lazy"; img.decoding = "async";
            img.onerror = () => { img.remove(); preview.textContent = "封面缺失 · 文本可用"; }; preview.append(img);
        } else preview.textContent = "无封面";
        return preview;
    }
    function favoriteFor(s) {
        const isFavorite = library.favorites.includes(s.id);
        const favorite = button(isFavorite ? "★" : "☆", async () => {
            try { await client("style-favorite", { id: s.id, favorite: !isFavorite }); await refresh(); }
            catch (e) { status.textContent = e.message; }
        });
        favorite.ariaLabel = `${isFavorite ? "取消收藏" : "收藏"} ${s.name}`;
        favorite.ariaPressed = String(isFavorite); favorite.classList.add("pm-style-favorite");
        return favorite;
    }
    function renderDetail() {
        detail.replaceChildren();
        const s = library.styles.find(item => item.id === focusedId);
        if (!s) { detail.append(el("h3", "pm-style-detail-title", "风格详情"), el("p", "pm-style-empty", "选择风格后查看描述、编辑或应用到当前节点。")); return; }
        const isSelected = getConfig().styles.some(item => item.id === s.id);
        const apply = button(isSelected ? "移除当前选择" : "应用到当前节点", () => {
            try { setConfig(applyStyle(getConfig(), s)); status.textContent = ""; render(); }
            catch (e) { status.textContent = e.message; }
        }); apply.classList.add("pm-style-apply"); apply.ariaPressed = String(isSelected);
        const actions = el("div", "pm-style-detail-actions");
        actions.append(apply, favoriteFor(s), button("编辑风格", () => editStyle(s)), button("删除风格", async () => {
            if (!await confirmAction(`删除公共风格“${s.name}”？已保存节点的文本快照仍保留。`, { title: "删除风格", confirmLabel: "确认删除", danger: true })) return;
            try { await client("style-delete", { id: s.id, revision: s.revision }); await refresh(); }
            catch (e) { status.textContent = e.message; }
        }));
        detail.append(el("h3", "pm-style-detail-title", s.name), coverFor(s), el("p", "pm-style-detail-category", s.category?.trim() || "未分类"),
            el("pre", "pm-style-description", `正面：${s.positive}\n负面：${s.negative || "（空）"}`), actions);
    }
    function appendNextPage() {
        if (renderedCount >= visibleItems.length) return;
        observer?.unobserve(loadMoreStatus);
        loadMoreStatus.remove();
        const end = Math.min(renderedCount + PAGE_SIZE, visibleItems.length);
        const c = getConfig();
        for (const s of visibleItems.slice(renderedCount, end)) {
            const card = el("article", "pm-style-card"), pick = button("", async () => {
                if (activeEditor && !await activeEditor.cancel()) return;
                focusedId = s.id; renderDetail();
                for (const item of grid.querySelectorAll(".pm-style-pick")) item.ariaPressed = String(item.dataset.styleId === focusedId);
            });
            pick.classList.add("pm-style-pick"); pick.ariaLabel = `选择风格 ${s.name}`; pick.ariaPressed = String(focusedId === s.id); pick.dataset.styleId = s.id;
            pick.append(coverFor(s), el("span", "pm-style-name", s.name));
            const index = c.styles.findIndex(item => item.id === s.id);
            card.append(pick, favoriteFor(s), el("span", "pm-style-selection-state", index >= 0 ? `已选 · 第 ${index + 1} 项` : "未应用")); grid.append(card);
        }
        renderedCount = end;
        loadMoreStatus.textContent = renderedCount < visibleItems.length
            ? `已显示 ${renderedCount} / ${visibleItems.length} 种；继续向下滚动自动加载`
            : `已显示全部 ${renderedCount} 种风格`;
        grid.append(loadMoreStatus);
        if (renderedCount < visibleItems.length) loadMoreStatus.append(button("加载更多风格", appendNextPage));
        if (renderedCount < visibleItems.length) observer?.observe(loadMoreStatus);
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
    async function editStyle(style = null) {
        if (activeEditor && !await activeEditor.cancel()) return;
        const editor = dialog(style ? "编辑风格" : "新建风格");
        editor.panel.classList.add("pm-style-editor-dialog");
        editor.body.classList.add("pm-style-editor-form");
        const closeEditor = editor.close;
        editor.close = () => { activeEditor = null; closeEditor(); };
        editor.body.append(el("p", "pm-muted", "填写风格名称和提示词；封面可选。"));
        const fields = {};
        for (const [key, title, type] of [["name", "名称", "input"], ["category", "分类", "input"], ["positive", "正面风格提示词", "textarea"], ["negative", "负面风格提示词", "textarea"]]) {
            const label = el("label", "pm-field", title), input = el(type); input.ariaLabel = title;
            input.value = key === "category" ? String(style?.[key] ?? "").trim() || "未分类" : style?.[key] || ""; label.append(input); editor.body.append(label); fields[key] = input;
        }
        const type = el("select"); type.ariaLabel = "文本类型"; type.append(new Option("完整段落（不拆分长描述）", "paragraph"), new Option("逗号词条（参与词条去重）", "tags")); type.value = style?.text_type || "paragraph";
        const cover = el("input"); cover.type = "file"; cover.accept = "image/png,image/jpeg,image/webp"; cover.ariaLabel = "风格封面";
        const typeField = el("label", "pm-field", "文本类型"); typeField.append(type);
        const coverField = el("label", "pm-field", "封面（可选，不超过 1 MB）"); coverField.append(cover);
        editor.body.append(typeField, coverField);
        const feedback = el("div", "pm-error"); feedback.role = "status";
        const initial = JSON.stringify(Object.values(fields).map(f => f.value).concat(type.value));
        editor.cancel = async () => {
            if (!cover.files.length && initial === JSON.stringify(Object.values(fields).map(f => f.value).concat(type.value)) || await confirmAction("放弃未保存的风格草稿？", { title: "放弃草稿", confirmLabel: "放弃草稿", danger: true })) { editor.close(); return true; }
            return false;
        };
        const submit = button("保存风格", async () => {
            submit.disabled = true;
            try {
                const file = cover.files[0]; if (file?.size > 1024 * 1024) throw Error("封面不能超过 1 MB");
                const image = file ? await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(Error("封面读取失败")); r.readAsDataURL(file); }) : undefined;
                await client("style-save", { id: style?.id, revision: style?.revision || 0, english: style?.english || "", theme: style?.theme || "自定义", ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, key === "category" ? input.value.trim() || "未分类" : input.value])), text_type: type.value, cover: image });
                editor.close(); await refresh();
            } catch (e) { feedback.textContent = e.message; }
            finally { submit.disabled = false; }
        });
        const actions = el("div", "pm-style-editor-actions");
        actions.append(submit, button("取消", editor.cancel));
        editor.body.append(feedback, actions);
        activeEditor = editor; fields.name.focus();
    }
    function render() {
        const referenceStrengthAvailable = Boolean(referenceStrength && styleReferenceControls && !styleReferenceControls.hidden);
        if (!referenceStrengthAvailable && tab === "strength") tab = "all";
        all.ariaSelected = String(tab === "all"); favorites.ariaSelected = String(tab === "favorites");
        all.classList.toggle("pm-active", tab === "all"); favorites.classList.toggle("pm-active", tab === "favorites");
        if (referenceStrength) {
            referenceStrength.hidden = !referenceStrengthAvailable;
            referenceStrength.ariaSelected = String(tab === "strength");
            referenceStrength.classList.toggle("pm-active", tab === "strength");
        }
        catalogPanel.hidden = tab === "strength";
        strengthPanel.hidden = tab !== "strength" || !referenceStrengthAvailable;
        const c = getConfig(); multi.textContent = `${c.multi_select ? "多选" : "单选"} ${c.styles.length}/${c.multi_select ? 3 : 1}`;
        const favoriteIds = new Set(library.favorites);
        const scoped = library.styles.filter(s => tab !== "favorites" || favoriteIds.has(s.id));
        const groups = groupStylesByCategory(scoped);
        // A deleted/recategorized last record returns to the real overview.
        if (category && !groupStylesByCategory(library.styles).some(group => group.name === category)) { category = ""; focusedId = ""; }
        const matches = s => [s.name, s.english, s.positive, s.negative, s.category].join("\n").toLocaleLowerCase().includes(query);
        breadcrumb.replaceChildren(); overview.replaceChildren();
        overview.hidden = Boolean(category); detailLayout.hidden = !category; grid.hidden = !category;
        if (category) {
            breadcrumb.append(button("返回分类总览", async () => { if (activeEditor && !await activeEditor.cancel()) return; category = ""; focusedId = ""; render(); }), el("h3", "pm-style-category-title", category));
        } else {
            breadcrumb.append(el("h3", "pm-style-category-title", "资料库分类总览"));
            for (const group of groups) {
                const matchesCount = group.styles.filter(matches).length;
                if (!matchesCount) continue;
                const card = button("", () => { category = group.name; focusedId = ""; render(); });
                card.classList.add("pm-style-category-card"); card.ariaLabel = `进入分类 ${group.name}，${group.count} 种风格`;
                card.append(coverFor(group.styles.find(s => s.image)), el("strong", "pm-style-category-name", group.name),
                    el("span", "pm-style-category-count", query ? `${matchesCount} / ${group.count} 种风格` : `${group.count} 种风格`)); overview.append(card);
            }
            if (!overview.children.length) overview.append(el("p", "pm-style-empty", !library.styles.length ? "暂无风格，请导入本地风格库或新建风格。" : tab === "favorites" && !scoped.length ? "暂无收藏，请到全部风格中点击 ☆ 收藏。" : "没有匹配的风格。"));
        }
        observer?.unobserve(loadMoreStatus);
        grid.replaceChildren();
        visibleItems = category ? (groups.find(group => group.name === category)?.styles || []).filter(matches) : [];
        renderedCount = 0;
        if (!visibleItems.length) grid.append(el("p", "pm-muted", !library.styles.length ? "暂无风格，请导入本地风格库或新建风格。" : tab === "favorites" && !scoped.length ? "暂无收藏，请到全部风格中点击 ☆ 收藏。" : "没有匹配的风格。"));
        else appendNextPage();
        if (!visibleItems.some(s => s.id === focusedId)) focusedId = "";
        renderDetail();
        renderSelected();
    }
    await refresh();
}
