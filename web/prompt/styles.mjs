import { applyStyle } from "./state.mjs";
import { el, button, dialog, confirmAction } from "./ui.mjs";

const TAB_KEY = "prompt-manager.v2.style-tab";
const PAGE_SIZE = 40;
export function renderStyleSummary(parent, getConfig, setConfig) {
    parent.replaceChildren();
    const c = getConfig();
    const label = el("label", "pm-style-switch", "�������"), toggle = el("input");
    toggle.type = "checkbox"; toggle.checked = c.style_enabled; toggle.ariaLabel = "�������";
    toggle.onchange = () => { const value = getConfig(); value.style_enabled = toggle.checked; setConfig(value); };
    label.prepend(toggle); parent.append(label);
    const details = el("details", "pm-style-details");
    details.open = c.style_enabled;
    const count = c.styles.length;
    const summary = el("summary", "", count ? `������� �� ${count} ��${c.style_enabled ? "" : " �� δ����"}` : "������� �� δѡ��");
    details.append(summary);
    const selected = el("div", "pm-style-selected");
    for (const [index, s] of c.styles.entries()) {
        const chip = el("div", "pm-style-chip"); chip.append(el("span", "", `${index + 1}. ${s.name}`));
        const up = button("��", () => { const v = getConfig(); [v.styles[index - 1], v.styles[index]] = [v.styles[index], v.styles[index - 1]]; setConfig(v); });
        up.disabled = index === 0; up.ariaLabel = `���Ʒ�� ${s.name}`;
        const remove = button("��", () => { const v = getConfig(); v.styles.splice(index, 1); setConfig(v); }); remove.ariaLabel = `�Ƴ���� ${s.name}`;
        chip.append(up, remove); selected.append(chip);
    }
    if (!c.styles.length) selected.append(el("span", "pm-muted", "δѡ���񣬵����ѡ�������"));
    details.append(selected);
    const order = el("select"); order.ariaLabel = "���ƴ�ӷ�ʽ";
    for (const [value, title] of [["user", "�û�����ǰ"], ["style", "�����ǰ"]]) order.append(new Option(title, value));
    order.value = c.style_order;
    order.onchange = () => { const v = getConfig(); v.style_order = order.value; setConfig(v); };
    const field = el("label", "pm-field", "ƴ�ӷ�ʽ"); field.append(order); details.append(field);
    parent.append(details);
}

export async function openStyles(client, getConfig, setConfig) {
    const d = dialog("ѡ����"); d.panel.classList.add("pm-style-manager");
    const tabs = el("div", "pm-toolbar pm-style-tabs"); tabs.role = "tablist"; tabs.ariaLabel = "���Χ";
    let tab = "all", library = { styles: [], favorites: [] }, query = "", category = "";
    let visibleItems = [], renderedCount = 0;
    try { tab = localStorage.getItem(TAB_KEY) === "favorites" ? "favorites" : "all"; } catch { /* optional browser preference */ }
    const all = button("ȫ�����", () => switchTab("all")), favorites = button("�ղط��", () => switchTab("favorites"));
    all.role = favorites.role = "tab";
    tabs.append(all, favorites);
    const tools = el("div", "pm-toolbar"), search = el("input"), categorySelect = el("select");
    search.type = "search"; search.placeholder = "�������ġ�Ӣ�����ƻ���ʾ��"; search.ariaLabel = "�������";
    categorySelect.ariaLabel = "������";
    const multi = button("", () => {
        const c = getConfig();
        if (c.multi_select && c.styles.length > 1) { status.textContent = "���ȱ���һ��������л���ѡ"; return; }
        c.multi_select = !c.multi_select; setConfig(c); render();
    }); multi.ariaLabel = "�л�����ѡ";
    tools.append(search, categorySelect, multi, button("���ѡ��", () => { const c = getConfig(); c.styles = []; setConfig(c); render(); }));
    const maintenance = el("div", "pm-toolbar");
    maintenance.append(button("���뱾�ط���", importLibrary), button("�½����", () => editStyle()), button("ˢ��", refresh));
    const status = el("div", "pm-error"); status.role = "status";
    const grid = el("div", "pm-style-grid"); grid.role = "tabpanel"; grid.ariaLabel = "���Ƭ";
    const loadMoreStatus = el("div", "pm-style-more", "���¹������б��ײ��Զ�������һ�����"); loadMoreStatus.role = "status";
    const selected = el("div", "pm-current-styles");
    d.body.append(tabs, tools, maintenance, status, grid, el("h3", "", "��ǰ�ڵ���ѡ���"), selected);
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && renderedCount < visibleItems.length) appendNextPage();
    }, { root: grid, rootMargin: "120px 0px", threshold: 0 }) : null;
    const onGridScroll = () => {
        if (!observer && grid.scrollHeight - grid.scrollTop - grid.clientHeight < 160 && renderedCount < visibleItems.length) appendNextPage();
    };
    grid.addEventListener("scroll", onGridScroll, { passive: true });
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
        catch (e) { status.textContent = `${e.message}����ǰ�ڵ��ı������ѱ���`; }
    }
    function renderSelected() {
        const c = getConfig();
        selected.replaceChildren(); renderStyleSummary(selected, getConfig, value => { setConfig(value); render(); });
        for (const snapshot of c.styles) {
            const current = library.styles.find(s => s.id === snapshot.id);
            if (!current) selected.append(el("p", "pm-muted", `${snapshot.name}����Դȱʧ�������ı�����`));
            else if (current.revision !== snapshot.revision) selected.append(button(`ͬ������ ${snapshot.name}`, () => { setConfig(applyStyle(getConfig(), current, true)); render(); }));
        }
    }
    function appendNextPage() {
        if (renderedCount >= visibleItems.length) return;
        observer?.unobserve(loadMoreStatus);
        loadMoreStatus.remove();
        const end = Math.min(renderedCount + PAGE_SIZE, visibleItems.length);
        const c = getConfig(), favoriteIds = new Set(library.favorites);
        for (const s of visibleItems.slice(renderedCount, end)) {
            const card = el("article", "pm-style-card"), pick = button("", () => {
                try {
                    setConfig(applyStyle(getConfig(), s)); status.textContent = "";
                    const selectedIds = new Set(getConfig().styles.map(x => x.id));
                    for (const item of grid.querySelectorAll(".pm-style-pick")) item.ariaPressed = String(selectedIds.has(item.dataset.styleId));
                    renderSelected();
                } catch (e) { status.textContent = e.message; }
            });
            pick.classList.add("pm-style-pick"); pick.ariaLabel = `ѡ���� ${s.name}`; pick.ariaPressed = String(c.styles.some(x => x.id === s.id)); pick.dataset.styleId = s.id;
            const preview = el("div", "pm-style-cover");
            if (s.image) { const img = el("img"); img.src = `/prompt-manager/v1/style-image/${encodeURIComponent(s.id)}?r=${s.revision}`; img.alt = s.name; img.loading = "lazy"; img.decoding = "async"; img.onerror = () => { img.remove(); preview.textContent = "����ȱʧ �� �ı�����"; }; preview.append(img); }
            else preview.textContent = "�޷���";
            pick.append(preview, el("span", "pm-style-name", s.name));
            const favorite = button(favoriteIds.has(s.id) ? "��" : "��", async () => {
                favorite.disabled = true;
                try { await client("style-favorite", { id: s.id, favorite: !favoriteIds.has(s.id) }); await refresh(); }
                catch (e) { status.textContent = e.message; favorite.disabled = false; }
            }); favorite.ariaLabel = `${favoriteIds.has(s.id) ? "ȡ���ղ�" : "�ղ�"} ${s.name}`; favorite.ariaPressed = String(favoriteIds.has(s.id)); favorite.classList.add("pm-style-favorite");
            const details = el("details"), summary = el("summary", "", "�鿴���� / �༭"); details.append(summary, el("p", "pm-muted", s.category), el("pre", "", `���棺${s.positive}\n���棺${s.negative || "���գ�"}`));
            details.append(button("�༭���", () => editStyle(s)), button("ɾ�����", async () => {
                if (!await confirmAction(`ɾ���������${s.name}�����ѱ���ڵ���ı������Ա�����`, { title: "ɾ�����", confirmLabel: "ȷ��ɾ��", danger: true })) return;
                try { await client("style-delete", { id: s.id, revision: s.revision }); await refresh(); } catch (e) { status.textContent = e.message; }
            })); card.append(pick, favorite, details); grid.append(card);
        }
        renderedCount = end;
        loadMoreStatus.textContent = renderedCount < visibleItems.length
            ? `����ʾ ${renderedCount} / ${visibleItems.length} �֣��������¹����Զ�����`
            : `����ʾȫ�� ${renderedCount} �ַ��`;
        grid.append(loadMoreStatus);
        if (renderedCount < visibleItems.length) observer?.observe(loadMoreStatus);
    }
    async function importLibrary() {
        const editor = dialog("���뱾�ط���");
        editor.body.append(el("p", "pm-muted", "ѡ����� styles.json �� thumbs �ı���Ŀ¼���ı��ͷ��渴�Ƶ���ǰ�û�����Ŀ¼�����޸���Դ�����"));
        const path = el("input"); path.ariaLabel = "���Ŀ¼"; path.placeholder = "���磺��/ComfyUI_JosiaNodes/Style/krea2";
        const feedback = el("div", "pm-error"); feedback.role = "status";
        const submit = button("����", async () => {
            submit.disabled = true;
            try { const result = await client("style-import", { path: path.value }); editor.close(); await refresh(); status.textContent = `�� ${result.total} ����񣬱��θ��� ${result.imported} ����ȱ�ٷ��� ${result.missing_covers} ��`; }
            catch (e) { feedback.textContent = e.message; }
            finally { submit.disabled = false; }
        }); editor.body.append(path, feedback, submit); path.focus();
    }
    function editStyle(style = null) {
        const editor = dialog(style ? "�༭���" : "�½����");
        const fields = {};
        for (const [key, title, type] of [["name", "����", "input"], ["category", "����", "input"], ["positive", "��������ʾ��", "textarea"], ["negative", "��������ʾ��", "textarea"]]) {
            const label = el("label", "pm-field", title), input = el(type); input.ariaLabel = title;
            input.value = style?.[key] || ({ category: "δ����", theme: "�Զ���" }[key] ?? ""); label.append(input); editor.body.append(label); fields[key] = input;
        }
        const type = el("select"); type.ariaLabel = "�ı�����"; type.append(new Option("�������䣨����ֳ�������", "paragraph"), new Option("���Ŵ������������ȥ�أ�", "tags")); type.value = style?.text_type || "paragraph";
        const cover = el("input"); cover.type = "file"; cover.accept = "image/png,image/jpeg,image/webp"; cover.ariaLabel = "������";
        editor.body.append(el("label", "pm-field", "�ı�����"), type, el("label", "pm-field", "���棨��ѡ�������� 1 MB��"), cover);
        const feedback = el("div", "pm-error"); feedback.role = "status"; editor.body.append(feedback);
        const initial = JSON.stringify(Object.values(fields).map(f => f.value).concat(type.value));
        editor.cancel = async () => {
            if (!cover.files.length && initial === JSON.stringify(Object.values(fields).map(f => f.value).concat(type.value)) || await confirmAction("����δ����ķ��ݸ壿", { title: "�����ݸ�", confirmLabel: "�����ݸ�", danger: true })) editor.close();
        };
        const submit = button("������", async () => {
            submit.disabled = true;
            try {
                const file = cover.files[0]; if (file?.size > 1024 * 1024) throw Error("���治�ܳ��� 1 MB");
                const image = file ? await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(Error("�����ȡʧ��")); r.readAsDataURL(file); }) : undefined;
                await client("style-save", { id: style?.id, revision: style?.revision || 0, english: style?.english || "", theme: style?.theme || "�Զ���", ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])), text_type: type.value, cover: image });
                editor.close(); await refresh();
            } catch (e) { feedback.textContent = e.message; }
            finally { submit.disabled = false; }
        }); editor.body.append(submit);
    }
    function render() {
        all.ariaSelected = String(tab === "all"); favorites.ariaSelected = String(tab === "favorites");
        all.classList.toggle("pm-active", tab === "all"); favorites.classList.toggle("pm-active", tab === "favorites");
        const c = getConfig(); multi.textContent = `${c.multi_select ? "��ѡ" : "��ѡ"} ${c.styles.length}/${c.multi_select ? 3 : 1}`;
        const favoriteIds = new Set(library.favorites);
        const scoped = library.styles.filter(s => tab === "all" || favoriteIds.has(s.id));
        category = options(categorySelect, scoped.map(s => s.category), "ȫ������", category);
        observer?.unobserve(loadMoreStatus);
        grid.replaceChildren();
        visibleItems = scoped.filter(s => (!category || s.category === category) && [s.name, s.english, s.positive, s.negative].join("\n").toLocaleLowerCase().includes(query));
        renderedCount = 0;
        if (!visibleItems.length) grid.append(el("p", "pm-muted", !library.styles.length ? "���޷���뵼�뱾�ط�����½����" : tab === "favorites" && !scoped.length ? "�����ղأ��뵽ȫ������е�� �� �ղء�" : "û��ƥ��ķ��"));
        else appendNextPage();
        renderSelected();
    }
    await refresh();
}
