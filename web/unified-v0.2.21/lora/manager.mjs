import { clone, parseState, setEnabled, reorder, replacePreset } from "./state.mjs";
import { orderedCategories, readCollapsed, writeCollapsed } from "./tree.mjs";

const BASE = "/cj-unified-loader-test/v1/loras";
let activeManager = null;

function el(tag, props = {}, children = []) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === "text") element.textContent = value;
        else if (key === "class") element.className = value;
        else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
        else if (key in element) element[key] = value;
        else element.setAttribute(key, value);
    }
    element.append(...children);
    return element;
}

function button(text, action, className = "") {
    return el("button", { type: "button", text, class: className, onclick: action });
}

export class Client {
    constructor(fetcher = (path, options) => fetch(path, options), coverURL = (key) => `${BASE}/covers/${key}`) {
        this.fetcher = fetcher;
        this.coverURL = coverURL;
    }
    async request(path, options) {
        const response = await this.fetcher(`${BASE}/${path}`, options);
        let value;
        try { value = await response.json(); } catch { throw new Error(`请求失败（HTTP ${response.status}），请检查 ComfyUI 后端。`); }
        if (!response.ok) throw new Error(value.error || `请求失败（HTTP ${response.status}）`);
        return value;
    }
    post(operation, body) {
        return this.request(operation, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    library(options) { return this.request(`library?${new URLSearchParams(options)}`); }
    previews(files) { return this.post("previews", { files }); }
    async coverBlob(key) {
        const response = await this.fetcher(`${BASE}/covers/${key}`);
        if (!response.ok) throw new Error(`封面读取失败（HTTP ${response.status}）`);
        return response.blob();
    }
    upload(file) {
        if (file.size > 8 * 1024 * 1024) throw new Error("封面不能超过 8 MB。");
        return this.request("covers", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
    }
}

export function openManager(options) {
    activeManager?.close();
    activeManager = new Manager(options);
    return activeManager;
}

export class Manager {
    constructor({ getConfig, setConfig, hasClip = () => true, client = new Client(), onClose = () => {}, mount = null }) {
        this.getConfig = getConfig; this.setConfig = setConfig; this.hasClip = hasClip; this.client = client;
        this.onClose = onClose; this.embedded = Boolean(mount);
        this.scope = "lora"; this.category = ""; this.query = ""; this.offset = 0; this.limit = 36;
        this.collapsed = { lora: readCollapsed("lora"), preset: readCollapsed("preset") };
        this.records = new Map(); this.categories = []; this.requestId = 0; this.closed = false;
        this.snapshot = parseState(getConfig());
        this.root = el(mount ? "section" : "dialog", { class: "lm-root", "aria-label": "LoRA 管理器" });
        const close = button("✕", () => this.close()); close.setAttribute("aria-label", "关闭管理器");
        const head = el("header", { class: "lm-head" }, [
            el("div", { class: "lm-brand" }, [el("span", { class: "lm-mark", text: "L" }), el("span", { text: "LoRA 管理器" })]),
            el("span", { class: "lm-sub", text: "资料库全局共用 · 当前配置独立" }), el("div", { class: "lm-spacer" }), close]);
        this.tabs = el("div", { class: "lm-tabs", role: "tablist", "aria-label": "资源库" });
        for (const [scope, name] of [["lora", "LoRA 库"], ["preset", "预设库"]]) {
            const tab = button(name, () => { this.scope = scope; this.category = ""; this.offset = 0; this.refresh(); });
            tab.setAttribute("role", "tab"); tab.dataset.scope = scope; this.tabs.append(tab);
        }
        this.search = el("input", { type: "search", class: "lm-search", placeholder: "搜索名称、文件名、备注或触发词", "aria-label": "搜索资源", oninput: () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => { this.query = this.search.value; this.offset = 0; this.refresh(); }, 200);
        }});
        const toolbar = el("div", { class: "lm-toolbar" }, [this.tabs, el("div", { class: "lm-spacer" }), this.search,
            button("↻ 刷新资源", () => this.refresh(true))]);
        this.sidebar = el("nav", { class: "lm-sidebar", "aria-label": "分类目录" });
        this.breadcrumb = el("div", { class: "lm-breadcrumb" }); this.heading = el("h2"); this.total = el("span", { class: "lm-muted" });
        this.grid = el("div", { class: "lm-grid" }); this.pager = el("div", { class: "lm-pager" });
        this.scroll = el("div", { class: "lm-scroll" }, [this.grid]);
        const library = el("main", { class: "lm-library" }, [this.breadcrumb,
            el("div", { class: "lm-section-head" }, [this.heading, this.total]), this.scroll, this.pager]);
        this.current = el("aside", { class: "lm-current", "aria-label": "当前启用列表" });
        const body = el("div", { class: "lm-body" }, [this.sidebar, library, this.current]);
        this.status = el("div", { class: "lm-status", role: "status", "aria-live": "polite", text: "正在读取本地资料库…" });
        this.root.append(...(mount ? [toolbar, body, this.status] : [head, toolbar, body, this.status])); (mount || document.body).append(this.root);
        this.root.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
        if (!mount) this.root.showModal(); this.renderCurrent(); this.refresh();
    }

    close() {
        if (this.closed) return;
        this.closed = true; this.requestId++; clearTimeout(this.searchTimer);
        this.editor?.close(); this.editor?.remove(); this.root.close?.(); this.root.remove();
        if (activeManager === this) activeManager = null;
        this.onClose();
    }
    message(text, error = false) { this.status.textContent = text; this.status.classList.toggle("error", error); }
    async run(action) { try { await action(); } catch (error) { if (!this.closed) this.message(error.message, true); } }
    commit() {
        this.setConfig(JSON.stringify(this.snapshot));
        this.renderCurrent();
    }
    async refresh(force = false) {
        const token = ++this.requestId;
        this.message("正在读取资料…");
        try {
            const result = await this.client.library({ scope: this.scope, category: this.category, q: this.query,
                offset: this.offset, limit: this.limit, refresh: force ? 1 : 0 });
            if (this.closed || token !== this.requestId) return;
            if (this.offset && this.offset >= result.total) { this.offset = Math.max(0, Math.floor((result.total - 1) / this.limit) * this.limit); return this.refresh(); }
            this.items = result.items; this.categories = result.categories; this.totalCount = result.total;
            for (const record of result.items) if (this.scope === "lora") this.records.set(record.file, record);
            this.renderTree(); this.renderLibrary(); this.renderCurrent();
            for (const tab of this.tabs.children) tab.setAttribute("aria-selected", String(tab.dataset.scope === this.scope));
            this.message(this.hasClip() ? "开关、强度和顺序暂存在当前窗口；点击底部“应用到节点”后生效。" : "当前 CLIP 功能关闭，仅应用模型强度；已有 CLIP 数值会保留。");
        } catch (error) { if (!this.closed && token === this.requestId) this.message(error.message, true); }
    }
    categoryPath(id) {
        const names = [], seen = new Set();
        while (id && !seen.has(id)) {
            seen.add(id); const record = this.categories.find((c) => c.id === id); if (!record) break;
            names.unshift(record.name); id = record.parent;
        }
        return names.join(" / ");
    }
    categoryOrder(scope = this.scope, excluded = new Set()) {
        return orderedCategories(this.categories, scope, excluded);
    }
    renderTree() {
        this.sidebar.replaceChildren(el("div", { class: "lm-side-title", text: "分类目录" }));
        const add = (id, title, depth = 0) => {
            const item = button(title, () => { this.category = id; this.offset = 0; this.refresh(); }, `lm-tree-item${this.category === id ? " selected" : ""}`);
            item.style.paddingLeft = `${9 + depth * 14}px`; item.title = id ? this.categoryPath(id) : title;
            this.sidebar.append(item);
        };
        add("", this.scope === "lora" ? "▦ 全部 LoRA" : "▦ 全部预设"); add("uncategorized", "▱ 未分类");
        for (const category of orderedCategories(this.categories, this.scope, new Set(), this.collapsed[this.scope])) {
            const row = el("div", { class: `lm-tree-row${this.category === category.id ? " selected" : ""}` });
            row.dataset.categoryId = category.id;
            row.style.paddingLeft = `${category.depth * 14}px`;
            if (category.hasChildren) {
                const isClosed = this.collapsed[this.scope].has(category.id);
                const toggle = button(isClosed ? "▸" : "▾", () => {
                    const closed = this.collapsed[this.scope];
                    if (closed.has(category.id)) closed.delete(category.id); else closed.add(category.id);
                    writeCollapsed(this.scope, closed); this.renderTree();
                }, "lm-tree-toggle");
                toggle.setAttribute("aria-label", `${isClosed ? "展开" : "收起"} ${category.name}`);
                toggle.setAttribute("aria-expanded", String(!isClosed));
                row.append(toggle);
            } else row.append(el("span", { class: "lm-tree-spacer", "aria-hidden": "true" }));
            const select = button(`▱ ${category.name}`, () => { this.category = category.id; this.offset = 0; this.refresh(); }, "lm-tree-name");
            select.setAttribute("aria-label", `浏览分类 ${category.name}`);
            select.title = this.categoryPath(category.id); row.append(select); this.sidebar.append(row);
        }
        const selected = this.categories.find((c) => c.id === this.category);
        const tools = el("div", { class: "lm-tree-tools" }, [button("＋ 新建分类", () => this.editCategory())]);
        if (selected) {
            tools.append(button("编辑 / 移动", () => this.editCategory(selected)), button("删除", () => this.run(async () => {
                if (!confirm(`删除“${selected.name}”及其子分类？其中资料转为未分类，模型文件不会删除。`)) return;
                await this.client.post("delete", { kind: "category", id: selected.id, revision: selected.revision });
                this.category = ""; this.offset = 0; await this.refresh();
            }), "lm-danger"));
        }
        this.sidebar.append(tools, el("div", { class: "lm-side-note", text: "分类和资料跨工作流保存。\n拖动右侧卡片或用箭头调整加载顺序。" }));
    }
    cover(record) {
        const container = el("div", { class: "lm-cover" });
        const fallback = () => container.replaceChildren(el("span", { class: "lm-cover-symbol", text: record.entries ? "组合" : "LoRA", "aria-hidden": "true" }));
        if (record.cover) {
            const img = el("img", { src: this.client.coverURL(record.cover), alt: record.name, loading: "lazy" });
            img.addEventListener("error", fallback, { once: true }); container.append(img);
        } else fallback();
        return container;
    }
    weights(item, changed, disabled = false) {
        const box = el("div", { class: "lm-weights" });
        for (const [field, title] of [["strength_model", "模型"], ["strength_clip", "CLIP"]]) {
            const input = el("input", { type: "number", min: -100, max: 100, step: 0.01, value: item[field],
                disabled: disabled || (field === "strength_clip" && !this.hasClip()), "aria-label": `${item.name} ${title}强度`,
                onchange: () => {
                    const value = input.valueAsNumber;
                    if (!Number.isFinite(value) || Math.abs(value) > 100) {
                        input.value = item[field]; this.message("强度必须在 -100 至 100 之间。", true); return;
                    }
                    changed(field, value);
                }});
            box.append(el("label", { class: "lm-weight" }, [el("span", { text: title }), input]));
        }
        return box;
    }
    renderLibrary() {
        const title = this.category === "uncategorized" ? "未分类" : this.categoryPath(this.category) || (this.scope === "lora" ? "全部 LoRA" : "全部预设");
        this.breadcrumb.textContent = `${this.scope === "lora" ? "LoRA 库" : "预设库"} / ${title}`;
        this.heading.textContent = title.split(" / ").at(-1); this.total.textContent = `${this.totalCount} 个${this.scope === "lora" ? " LoRA" : "预设"}`;
        this.grid.replaceChildren();
        for (const record of this.items || []) this.grid.append(this.scope === "lora" ? this.loraCard(record) : this.presetCard(record));
        if (!this.items?.length) this.grid.append(el("div", { class: "lm-empty" }, [
            el("strong", { text: this.query ? "没有匹配的资源" : this.scope === "lora" ? "这里还没有 LoRA" : "开始保存你的组合" }),
            el("span", { text: this.query ? "试试其他关键词，或切换分类。" : this.scope === "lora" ? "把文件放入 ComfyUI 的 LoRA 目录后，点击刷新资源。" : "在右侧启用 LoRA，然后点击“保存为新预设”。" })]));
        const prev = button("上一页", () => { this.offset = Math.max(0, this.offset - this.limit); this.refresh(); }); prev.disabled = !this.offset;
        const next = button("下一页", () => { this.offset += this.limit; this.refresh(); }); next.disabled = this.offset + this.limit >= this.totalCount;
        this.pager.replaceChildren(prev, el("span", { text: `${Math.floor(this.offset / this.limit) + 1} / ${Math.max(1, Math.ceil(this.totalCount / this.limit))}` }), next);
    }
    loraCard(record) {
        const selected = this.snapshot.entries.find((i) => i.file === record.file);
        const enabled = selected?.enabled || false;
        const card = el("article", { class: `lm-card${enabled ? " is-enabled" : ""}` }, [this.cover(record)]);
        const toggle = el("input", { type: "checkbox", class: "lm-switch", checked: enabled,
            disabled: record.missing && !enabled, "aria-label": `启用 ${record.name}`, onchange: () => this.run(async () => {
                setEnabled(this.snapshot, record, toggle.checked); this.commit(); this.renderLibrary();
            })});
        const content = el("div", { class: "lm-card-content" }, [el("div", { class: "lm-card-title" }, [el("strong", { text: record.name }), toggle]),
            el("div", { class: "lm-card-file", text: record.file, title: record.file }),
            el("div", { class: `lm-notes${record.notes ? "" : " lm-notes-empty"}`, text: record.notes || "" })]);
        if (record.missing) content.append(el("span", { class: "lm-badge", text: "文件缺失" }));
        const weightItem = selected || record;
        content.append(this.weights(weightItem, (field, value) => {
            const item = this.snapshot.entries.find((i) => i.file === record.file) || setEnabled(this.snapshot, record, false);
            item[field] = value; this.commit(); this.renderLibrary();
        }));
        content.append(el("div", { class: "lm-card-actions" }, [button(record.missing ? "重新关联文件" : "✎ 编辑资料", () => record.missing ? this.relink(record) : this.editLora(record))]));
        card.append(content); return card;
    }
    presetCard(record) {
        const content = el("div", { class: "lm-card-content" }, [el("div", { class: "lm-card-title" }, [el("strong", { text: record.name })]),
            el("div", { class: "lm-card-file", text: `${record.entries.length} 个 LoRA · 版本 ${record.revision}` }),
            el("div", { class: "lm-notes", text: record.notes || record.entries.map((i) => i.name).join(" + ") })]);
        if (record.missing.length) content.append(el("span", { class: "lm-badge", text: `缺少 ${record.missing.length} 个文件` }));
        const apply = button("应用预设", () => this.applyPreset(record), "lm-primary");
        content.append(el("div", { class: "lm-card-actions" }, [apply, button("详情 / 编辑", () => this.editPreset(record, false))]));
        return el("article", { class: "lm-card" }, [this.cover(record), content]);
    }
    renderCurrent() {
        const active = this.snapshot.entries.filter((i) => i.enabled);
        this.current.replaceChildren(el("h2", {}, [document.createTextNode("当前启用"), el("span", { class: "lm-count", text: String(active.length) })]),
            el("div", { class: "lm-muted", text: "仅影响当前节点 · 按从上到下顺序加载" }),
            el("div", { class: "lm-current-label", text: this.snapshot.preset ? `来源预设：${this.snapshot.preset.name} · r${this.snapshot.preset.revision}` : "自由组合 · 尚未关联预设" }));
        const list = el("div", { class: "lm-active-list" });
        active.forEach((item, index) => {
            const row = el("div", { class: "lm-active", draggable: true });
            row.addEventListener("dragstart", (event) => { this.dragFile = item.file; event.dataTransfer.setData("text/plain", item.file); event.dataTransfer.effectAllowed = "move"; });
            row.addEventListener("dragend", () => { this.dragFile = null; });
            row.addEventListener("dragover", (event) => { if (this.dragFile) event.preventDefault(); });
            row.addEventListener("drop", (event) => {
                event.preventDefault(); if (!this.dragFile || this.dragFile === item.file) return;
                const from = this.snapshot.entries.findIndex((i) => i.file === this.dragFile);
                const to = this.snapshot.entries.indexOf(item);
                this.snapshot.entries.splice(to, 0, this.snapshot.entries.splice(from, 1)[0]);
                this.commit(); this.renderLibrary();
            });
            const move = (direction) => { reorder(this.snapshot, item.file, direction); this.commit(); this.renderLibrary(); };
            const up = button("↑", () => move(-1)); up.disabled = index === 0; up.setAttribute("aria-label", `上移 ${item.name}`);
            const down = button("↓", () => move(1)); down.disabled = index === active.length - 1; down.setAttribute("aria-label", `下移 ${item.name}`);
            const remove = button("×", () => { item.enabled = false; this.commit(); this.renderLibrary(); }); remove.setAttribute("aria-label", `关闭 ${item.name}`);
            row.append(el("div", { class: "lm-active-top" }, [el("span", { class: "lm-order", text: String(index + 1).padStart(2, "0") }),
                el("strong", { text: item.name, title: item.file }), up, down, remove]),
                this.weights(item, (field, value) => { item[field] = value; this.commit(); this.renderLibrary(); }));
            list.append(row);
        });
        if (!active.length) list.append(el("div", { class: "lm-muted", text: "在左侧资源卡片中启用 LoRA。全部关闭时，模型原样通过。" }));
        const actions = el("div", { class: "lm-action-stack" }, [button("▣ 保存为新预设", () => this.editPreset(null, true), "lm-primary")]);
        if (this.snapshot.preset) actions.append(button("覆盖来源预设", () => this.run(async () => {
            const preset = await this.client.post("preset-read", { id: this.snapshot.preset.id });
            if (preset.revision !== this.snapshot.preset.revision) throw new Error("公共预设已更新。请到预设库查看最新版本，再选择编辑或重新应用。当前组合已保留。");
            this.editPreset(preset, true);
        })));
        actions.append(button("↻ 同步资料", () => this.run(async () => {
            const result = await this.client.post("sync", { config: this.snapshot });
            this.snapshot = parseState(result.config); this.commit(); this.renderLibrary();
            this.message(result.missing.length ? `资料已同步；以下文件缺失：${result.missing.join("、")}` : "已同步名称和触发词；启用状态、顺序和强度已保留。", result.missing.length > 0);
        })), button("关闭全部", () => { for (const i of this.snapshot.entries) i.enabled = false; this.commit(); this.renderLibrary(); }),
        button("清理已关闭项", () => { this.snapshot.entries = this.snapshot.entries.filter((i) => i.enabled); this.commit(); this.renderLibrary(); }));
        this.current.append(list, actions, el("div", { class: "lm-muted", text: "应用预设会完整替换当前组合。临时调整不会自动修改公共预设。" }));
    }
    applyPreset(record) {
        return this.run(async () => {
            const result = await this.client.post("apply", { id: record.id });
            this.snapshot = replacePreset(result); this.commit(); this.renderLibrary();
            this.message(`已应用“${record.name}”，完整替换当前组合。`);
        });
    }

    editorForm(title, build, save, extra = []) {
        if (this.editor) return;
        const dialog = el("dialog", { class: "lm-editor", "aria-label": title }); this.editor = dialog;
        const form = el("form"), error = el("div", { class: "lm-editor-error", role: "alert" });
        const close = () => { dialog.close(); dialog.remove(); if (this.editor === dialog) this.editor = null; };
        const saveButton = el("button", { type: "submit", text: "保存", class: "lm-primary" });
        const data = build(form, (message) => { error.textContent = message; });
        form.prepend(el("h2", { text: title }));
        form.append(error, el("div", { class: "lm-editor-foot" }, [...extra, button("取消", close), saveButton]));
        form.addEventListener("submit", async (event) => {
            event.preventDefault(); saveButton.disabled = true; error.textContent = "";
            try { await save(data); close(); await this.refresh(); }
            catch (err) { error.textContent = err.message; }
            finally { saveButton.disabled = false; }
        });
        dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
        dialog.append(form); document.body.append(dialog); dialog.showModal();
    }
    field(form, title, value = "", type = "text") {
        const input = el(type === "textarea" ? "textarea" : "input", type === "textarea" ? { value } : { type, value });
        form.append(el("label", { class: "lm-field" }, [el("span", { text: title }), input])); return input;
    }
    categoryChecks(form, scope, selected = []) {
        const box = el("div", { class: "lm-editor-cats" }), controls = [];
        for (const cat of this.categoryOrder(scope)) {
            const input = el("input", { type: "checkbox", checked: selected.includes(cat.id), value: cat.id }); controls.push(input);
            box.append(el("label", {}, [input, el("span", { text: this.categoryPath(cat.id) })]));
        }
        if (!controls.length) box.append(el("span", { class: "lm-muted", text: "暂无分类，保存后位于未分类。可在主窗口新建分类。" }));
        form.append(el("label", { class: "lm-field", text: "所属分类（可多选）" }), box);
        return () => controls.filter((i) => i.checked).map((i) => i.value);
    }
    coverEditor(form, record, showError) {
        let cover = record.cover || null;
        const preview = this.cover(record); form.append(preview);
        const upload = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", "aria-label": "上传封面" });
        let uploading = null;
        upload.addEventListener("change", () => {
            if (!upload.files[0]) return;
            const file = upload.files[0]; upload.disabled = true;
            uploading = this.client.upload(file).then((result) => {
                cover = result.cover; preview.replaceChildren(el("img", { src: this.client.coverURL(cover), alt: "封面预览" }));
            }).catch((error) => { showError(error.message); throw error; }).finally(() => { upload.disabled = false; });
            uploading.catch(() => {});
        });
        form.append(el("label", { class: "lm-field" }, [el("span", { text: "上传封面 · PNG / JPEG / WebP，最大 8 MB" }), upload]),
            button("移除封面", () => { cover = null; preview.replaceChildren(el("span", { class: "lm-cover-symbol", text: "LoRA" })); }));
        return async () => { if (uploading) await uploading; return cover; };
    }
    editLora(record) {
        this.editorForm("编辑 LoRA 资料", (form, error) => {
            const data = { cover: this.coverEditor(form, record, error) };
            form.append(el("div", { class: "lm-muted", text: record.file }));
            data.name = this.field(form, "显示名称", record.name); data.name.required = true; data.name.maxLength = 256;
            data.notes = this.field(form, "备注", record.notes, "textarea"); data.notes.maxLength = 32000;
            data.trigger = this.field(form, "触发词（保留权重语法，按整段去重）", record.trigger, "textarea"); data.trigger.maxLength = 8192;
            data.categories = this.categoryChecks(form, "lora", record.categories);
            data.strength_model = this.field(form, "默认模型强度", record.strength_model, "number");
            data.strength_clip = this.field(form, "默认 CLIP 强度", record.strength_clip, "number");
            for (const key of ["strength_model", "strength_clip"]) Object.assign(data[key], { min: -100, max: 100, step: 0.01, required: true });
            return data;
        }, async (data) => {
            const saved = await this.client.post("lora", { file: record.file, revision: record.revision, name: data.name.value,
                notes: data.notes.value, trigger: data.trigger.value, categories: data.categories(), cover: await data.cover(),
                strength_model: data.strength_model.valueAsNumber, strength_clip: data.strength_clip.valueAsNumber });
            this.records.set(saved.file, saved);
            const current = this.snapshot.entries.find((i) => i.file === saved.file);
            if (current) { current.name = saved.name; current.trigger = saved.trigger; this.commit(); }
        });
    }
    editCategory(record = null) {
        this.editorForm(record ? "编辑 / 移动分类" : "新建分类", (form) => {
            const name = this.field(form, "分类名称", record?.name || ""); name.required = true; name.maxLength = 128;
            const excluded = new Set(record ? [record.id] : []);
            if (record) {
                let changed = true;
                while (changed) { changed = false; for (const c of this.categories) if (excluded.has(c.parent) && !excluded.has(c.id)) { excluded.add(c.id); changed = true; } }
            }
            const parent = el("select", { "aria-label": "父分类" }, [el("option", { value: "", text: "顶层目录" })]);
            for (const cat of this.categoryOrder(this.scope, excluded)) parent.append(el("option", { value: cat.id, text: this.categoryPath(cat.id) }));
            parent.value = record?.parent || (this.categories.some((c) => c.id === this.category) ? this.category : "");
            form.append(el("label", { class: "lm-field" }, [el("span", { text: "父分类" }), parent])); return { name, parent };
        }, async (data) => {
            const saved = await this.client.post("category", { ...(record ? { id: record.id } : {}), revision: record?.revision || 0,
                name: data.name.value, scope: this.scope, parent: data.parent.value || null }); this.category = saved.id;
            let parent = saved.parent;
            while (parent) {
                this.collapsed[this.scope].delete(parent);
                parent = this.categories.find((c) => c.id === parent)?.parent;
            }
            writeCollapsed(this.scope, this.collapsed[this.scope]);
        });
    }
    editPreset(record, fromCurrent) {
        const entries = clone(fromCurrent ? this.snapshot.entries.filter((i) => i.enabled) : record.entries);
        const remove = record ? [button("删除预设", () => this.run(async () => {
            if (!confirm(`删除预设“${record.name}”？已保存到节点的组合会保留。`)) return;
            await this.client.post("delete", { kind: "preset", id: record.id, revision: record.revision });
            this.editor?.close(); this.editor?.remove(); this.editor = null; await this.refresh();
        }), "lm-danger")] : [];
        this.editorForm(record ? (fromCurrent ? "覆盖来源预设" : "预设详情 / 编辑") : "保存为新预设", (form, error) => {
            const data = { cover: this.coverEditor(form, record || {}, error) };
            data.name = this.field(form, "预设名称", record?.name || ""); data.name.required = true; data.name.maxLength = 256;
            data.notes = this.field(form, "备注", record?.notes || "", "textarea"); data.notes.maxLength = 32000;
            data.categories = this.categoryChecks(form, "preset", record?.categories || []);
            const list = el("div", { class: "lm-preset-entries" });
            entries.forEach((i, n) => {
                const row = el("div", { class: "lm-preset-entry" }, [el("strong", { text: `${n + 1}. ${i.name}` }),
                    el("div", { class: "lm-muted", text: i.file })]);
                row.append(this.weights(i, (field, value) => { i[field] = value; })); list.append(row);
            });
            if (!entries.length) list.append(el("span", { text: "空组合：应用后关闭全部 LoRA。" }));
            form.append(el("label", { class: "lm-field", text: `组合内容 · ${entries.length} 个 LoRA` }), list,
                el("p", { class: "lm-muted", text: "按显示顺序保存。需要增删或重新排序时，先应用到节点，调整后覆盖保存。" }));
            if (record?.missing?.length) form.append(el("div", { class: "lm-badge", text: `缺失文件：${record.missing.join("、")}` }));
            return data;
        }, async (data) => {
            const saved = await this.client.post("preset", { ...(record ? { id: record.id } : {}), revision: record?.revision || 0,
                name: data.name.value, notes: data.notes.value, categories: data.categories(), cover: await data.cover(), entries });
            if (fromCurrent) { this.snapshot.preset = { id: saved.id, name: saved.name, revision: saved.revision }; this.commit(); }
        }, remove);
    }
    relink(record) {
        this.editorForm("重新关联 LoRA 文件", (form) => {
            form.append(el("p", { class: "lm-muted", text: `原文件：${record.file}。请输入资源库中准确的新文件名（含子目录）。公共资料和引用它的预设会重新关联，不覆盖新文件已有资料。其他节点保留原快照，需手动重新应用预设。` }));
            return this.field(form, "新的 LoRA 相对文件名");
        }, async (input) => {
            const selected = input.value.trim().replaceAll("\\", "/");
            if (this.snapshot.entries.some((i) => i.file === selected)) throw new Error("当前节点已存在新文件，请先关闭并清理旧项后重新选择。");
            const saved = await this.client.post("relink", { old_file: record.file, file: selected, revision: record.revision });
            for (const item of this.snapshot.entries) if (item.file === record.file) {
                item.file = saved.file; item.name = saved.name; item.trigger = saved.trigger;
            }
            this.commit();
        });
    }
}
