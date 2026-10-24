import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { calculatePreviewFrameHeight } from "./visual_save/preview-sizing.mjs";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./visual_save/style.css", import.meta.url).href;
document.head.append(stylesheet);

function el(tag, cls, text) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text !== undefined) element.textContent = text;
    return element;
}
function button(text, action, cls = "") {
    const element = el("button", cls, text);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
}
async function folders(path = "", name) {
    const response = await api.fetchApi(`/visual-save-image/v1/folders${name === undefined ? `?path=${encodeURIComponent(path)}` : ""}`, name === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name }),
    });
    let data;
    try { data = await response.json(); } catch { throw Error(`文件夹请求失败 (${response.status})`); }
    if (!response.ok) throw Error(data.error || `文件夹请求失败 (${response.status})`);
    return data;
}
function isolate(element) {
    for (const event of ["pointerdown", "mousedown", "dblclick", "keydown", "keyup", "wheel"])
        element.addEventListener(event, e => e.stopPropagation());
}

class SaveView {
    constructor(node) {
        this.node = node;
        this.index = 0;
        this.imageSize = null;
        this.frameHeight = calculatePreviewFrameHeight(320, 0, 0);
        this.widgetHeight = 540;
        this.layoutFrame = 0;
        this.element = el("div", "vsi-node");
        isolate(this.element);
        this.path = el("div", "vsi-path");
        this.path.ariaLabel = "选定的保存文件夹";
        const choose = button("▣ 选择文件夹", () => this.openPicker(), "vsi-primary");
        this.folderRow = el("div", "vsi-folder-row"); this.folderRow.append(this.path, choose);
        const prefixLabel = el("label", "vsi-label", "文件名前缀");
        this.prefix = el("input", "vsi-input");
        this.prefix.type = "text"; this.prefix.ariaLabel = "文件名前缀"; this.prefix.spellcheck = false;
        this.prefix.addEventListener("input", () => { this.write("filename_prefix", this.prefix.value); this.sync(); });
        prefixLabel.append(this.prefix);
        this.status = el("div", "vsi-status", "尚未保存图片"); this.status.role = "status";
        this.frame = el("div", "vsi-frame");
        this.frame.style.height = `${this.frameHeight}px`;
        this.placeholder = el("span", "vsi-placeholder", "执行节点后，显示已保存的图片");
        this.image = el("img", "vsi-image"); this.image.hidden = true; this.image.alt = "已保存图片预览";
        this.image.addEventListener("load", () => {
            this.imageSize = { width: this.image.naturalWidth, height: this.image.naturalHeight };
            this.image.hidden = false; this.placeholder.hidden = true;
            this.scheduleLayout();
        });
        this.image.addEventListener("error", () => {
            this.imageSize = null;
            this.image.hidden = true; this.placeholder.hidden = false;
            this.placeholder.textContent = "无法加载已保存图片，文件可能已移动或删除";
            this.scheduleLayout();
        });
        this.frame.append(this.placeholder, this.image);
        this.resolution = el("span", "", "分辨率 —");
        this.previous = button("‹", () => this.select(this.index - 1)); this.previous.ariaLabel = "上一张";
        this.next = button("›", () => this.select(this.index + 1)); this.next.ariaLabel = "下一张";
        this.count = el("span", "vsi-count", "0 / 0");
        const pager = el("div", "vsi-pager"); pager.append(this.previous, this.count, this.next);
        const meta = el("div", "vsi-meta"); meta.append(this.resolution, pager);
        this.filename = el("div", "vsi-filename", "文件名：—");
        this.destination = el("div", "vsi-destination");
        this.element.append(el("div", "vsi-label", "保存位置"), this.folderRow, prefixLabel, this.status, this.frame, meta, this.filename, this.destination);
        this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.scheduleLayout());
        this.resizeObserver?.observe(this.element);
        this.widget = node.addDOMWidget("visual_save_ui", "visual-save-image", this.element, {
            serialize: false, hideOnZoom: false,
            getMinHeight: () => this.widgetHeight,
            getHeight: () => this.widgetHeight,
            afterResize: () => this.scheduleLayout(),
            surfaces: { canvas: "shown", vueNode: "shown", panel: "never" },
        });
        this.widget.serialize = false;
        this.timer = setInterval(() => this.sync(), 300);
        const remove = this.widget.onRemove;
        this.widget.onRemove = () => {
            clearInterval(this.timer);
            this.resizeObserver?.disconnect();
            if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
            this.closePicker?.(); remove?.call(this.widget);
        };
        this.sync(); this.select(0);
        folders().then(data => { this.outputRoot = data.output_root; this.sync(); }).catch(error => this.fail(error.message));
    }
    measureWidgetHeight() {
        if (!this.element.isConnected) return 0;
        const style = getComputedStyle(this.element);
        const pixels = value => Number.parseFloat(value) || 0;
        const children = [...this.element.children].filter(child => getComputedStyle(child).display !== "none");
        const rowGap = pixels(style.rowGap || style.gap);
        return Math.ceil(
            pixels(style.paddingTop) + pixels(style.paddingBottom)
            + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth)
            + rowGap * Math.max(0, children.length - 1)
            + children.reduce((height, child) => height + child.offsetHeight, 0),
        );
    }
    scheduleLayout() {
        if (this.layoutFrame || !this.element.isConnected) return;
        this.layoutFrame = requestAnimationFrame(() => {
            this.layoutFrame = 0;
            const frameWidth = this.frame.clientWidth || this.element.clientWidth;
            const { width, height } = this.imageSize || {};
            const nextFrameHeight = calculatePreviewFrameHeight(frameWidth, width, height);
            if (Math.abs(nextFrameHeight - this.frameHeight) >= 1) {
                this.frameHeight = nextFrameHeight;
                this.frame.style.height = `${nextFrameHeight}px`;
            }

            const measuredHeight = this.measureWidgetHeight();
            if (measuredHeight > 0) this.widgetHeight = measuredHeight;

            // Classic draws the DOM widget inside the LiteGraph node and needs its
            // node box resized explicitly. Nodes 2.0 tracks this DOM size itself.
            if (globalThis.LiteGraph?.vueNodesMode !== true) {
                const size = this.node.computeSize?.();
                const nextNodeHeight = Math.max(540, Number(size?.[1]) || this.widgetHeight);
                if (Math.abs((this.node.size?.[1] || 0) - nextNodeHeight) >= 1)
                    this.node.setSize([this.node.size[0], nextNodeHeight]);
            }
            this.node.setDirtyCanvas?.(true, true);
        });
    }
    native(name) { return this.node.widgets?.find(widget => widget.name === name); }
    value(name) { return this.native(name)?.value ?? ""; }
    write(name, value) {
        const widget = this.native(name);
        widget.value = value; widget.callback?.(value);
        this.node.graph?.change(); this.node.setDirtyCanvas?.(true, true);
    }
    sync() {
        const folder = this.value("subfolder"), prefix = this.value("filename_prefix");
        this.path.textContent = `output${folder ? ` / ${folder.replaceAll("/", " / ")}` : ""}`;
        this.path.title = this.path.textContent;
        if (this.prefix.value !== prefix) this.prefix.value = prefix;
        this.prefix.disabled = !!this.node.inputs?.some(input => input.name === "filename_prefix" && input.link != null);
        const root = this.outputRoot || "ComfyUI/output";
        this.destination.textContent = `将保存到：${root}${folder ? `/${folder}` : ""}`;
        this.destination.title = this.destination.textContent;
        if (this.last && !this.error) {
            const stale = this.last.subfolder !== folder || this.last.filename_prefix !== prefix;
            this.status.textContent = stale ? "上次保存 · 设置已更改，执行后更新" : `已保存 ${this.last.images.length} 张图片`;
            this.status.classList.toggle("vsi-stale", stale);
        }
    }
    fail(message) {
        this.error = message;
        this.status.textContent = message;
        this.status.classList.add("vsi-error");
    }
    executed(message) {
        const result = message?.visual_save?.[0];
        if (!result?.images?.length) return;
        this.last = result; this.error = null;
        this.outputRoot = result.output_root;
        this.status.classList.remove("vsi-error");
        this.select(0); this.sync();
    }
    select(index) {
        const images = this.last?.images || [];
        this.index = Math.max(0, Math.min(index, images.length - 1));
        const saved = images[this.index];
        this.previous.disabled = !saved || this.index === 0;
        this.next.disabled = !saved || this.index === images.length - 1;
        this.count.textContent = `${saved ? this.index + 1 : 0} / ${images.length}`;
        if (!saved) {
            this.imageSize = null;
            this.image.removeAttribute("src");
            this.image.hidden = true;
            this.placeholder.hidden = false;
            this.placeholder.textContent = "执行节点后，显示已保存的图片";
            this.resolution.textContent = "分辨率 —";
            this.filename.textContent = "文件名：—";
            this.filename.removeAttribute("title");
            this.frame.removeAttribute("title");
            this.scheduleLayout();
            return;
        }
        this.imageSize = { width: saved.width, height: saved.height };
        this.resolution.textContent = `分辨率 ${saved.width} × ${saved.height}`;
        this.filename.textContent = `文件名：${saved.filename}`;
        this.filename.title = saved.filename;
        const params = new URLSearchParams({ filename: saved.filename, subfolder: saved.subfolder, type: saved.type });
        this.image.hidden = true; this.placeholder.hidden = false; this.placeholder.textContent = "正在加载已保存图片…";
        this.image.src = api.apiURL(`/view?${params}`);
        this.frame.title = `已保存到：${this.last.absolute_path}/${saved.filename}`;
        this.scheduleLayout();
    }
    async openPicker() {
        if (this.closePicker) return;
        const overlay = el("div", "vsi-overlay");
        const dialog = el("section", "vsi-dialog"); dialog.role = "dialog"; dialog.ariaModal = "true"; dialog.ariaLabel = "选择保存文件夹";
        const heading = el("h2", "", "选择保存文件夹");
        const help = el("p", "vsi-help", "浏览运行 ComfyUI 的电脑上的 output 文件夹");
        const crumbs = el("nav", "vsi-breadcrumbs"); crumbs.ariaLabel = "文件夹路径";
        const list = el("div", "vsi-directory-list");
        const error = el("div", "vsi-picker-error"); error.role = "alert";
        const name = el("input", "vsi-input"); name.placeholder = "新文件夹名称"; name.ariaLabel = "新文件夹名称";
        const create = button("新建文件夹", async () => {
            setBusy(true); error.textContent = "";
            try {
                const result = await folders(current, name.value);
                name.value = ""; await browse(result.path);
            } catch (e) { error.textContent = e.message; } finally { setBusy(false); }
        });
        const createRow = el("div", "vsi-create-row"); createRow.append(name, create);
        const previousFocus = document.activeElement;
        const close = () => {
            overlay.remove(); document.removeEventListener("keydown", escape, true);
            this.closePicker = null; previousFocus?.focus();
        };
        const choose = button("选择此文件夹", () => {
            this.write("subfolder", current); this.sync(); close();
        }, "vsi-primary");
        const cancel = button("取消", close);
        const actions = el("div", "vsi-dialog-actions"); actions.append(cancel, choose);
        dialog.append(heading, help, crumbs, list, error, createRow, actions); overlay.append(dialog);
        isolate(dialog); document.body.append(overlay);
        let current = "", busy = false, generation = 0, valid = false;
        crumbs.append(button("output", () => browse("")));
        const setBusy = value => {
            busy = value; choose.disabled = value; create.disabled = value; name.disabled = value;
            list.inert = value; crumbs.inert = value;
        };
        const browse = async path => {
            const serial = ++generation;
            setBusy(true); error.textContent = "";
            try {
                const data = await folders(path);
                if (serial !== generation || !overlay.isConnected) return;
                current = data.path; this.outputRoot = data.output_root;
                valid = true;
                crumbs.replaceChildren(button("output", () => browse("")));
                const parts = current ? current.split("/") : [];
                parts.forEach((part, index) => {
                    crumbs.append(el("span", "", "›"), button(part, () => browse(parts.slice(0, index + 1).join("/"))));
                });
                list.replaceChildren();
                if (current) list.append(button("↰ 返回上一级", () => browse(parts.slice(0, -1).join("/")), "vsi-directory vsi-up"));
                for (const directory of data.directories)
                    list.append(button(`📁 ${directory.name}`, () => browse(directory.path), "vsi-directory"));
                if (!data.directories.length) list.append(el("p", "vsi-empty", "此文件夹没有子文件夹"));
                choose.disabled = false;
            } catch (e) {
                error.textContent = e.message;
                choose.disabled = true;
            } finally {
                if (serial === generation) {
                    busy = false; create.disabled = !valid; name.disabled = !valid; list.inert = false; crumbs.inert = false;
                }
            }
        };
        const escape = e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
            if (e.key === "Tab") {
                const focusable = [...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled)")];
                const first = focusable[0], last = focusable.at(-1);
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
            }
        };
        document.addEventListener("keydown", escape, true);
        overlay.addEventListener("pointerdown", e => { if (e.target === overlay && !busy) close(); });
        this.closePicker = close;
        await browse(this.value("subfolder"));
        cancel.focus();
    }
}

const views = new Set();
const cachedRuns = new Map();
api.addEventListener("execution_start", () => {
    for (const ref of views) {
        const view = ref.deref();
        if (view) view.executionSerial = (view.executionSerial || 0) + 1;
        else views.delete(ref);
    }
});
api.addEventListener("execution_cached", event => {
    const { prompt_id, nodes } = event.detail || {};
    if (prompt_id && Array.isArray(nodes)) cachedRuns.set(prompt_id, nodes.map(String));
    if (cachedRuns.size > 32) cachedRuns.delete(cachedRuns.keys().next().value);
});
api.addEventListener("execution_success", async event => {
    const id = event.detail?.prompt_id, ids = cachedRuns.get(id);
    cachedRuns.delete(id);
    if (!ids?.length) return;
    const targets = [...views].map(ref => ref.deref())
        .filter(view => view && ids.includes(String(view.node.id)) && app.graph?.getNodeById(view.node.id) === view.node)
        .map(view => ({ view, serial: view.executionSerial }));
    if (!targets.length) return;
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await api.fetchApi(`/history/${encodeURIComponent(id)}`);
            if (!response.ok) return;
            const history = (await response.json())[id];
            if (history) {
                for (const { view, serial } of targets) {
                    if (view.executionSerial === serial && app.graph?.getNodeById(view.node.id) === view.node)
                        view.executed(history.outputs?.[String(view.node.id)]);
                }
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } catch { /* Existing preview remains valid if history is temporarily unavailable. */ }
});
api.addEventListener("execution_error", event => {
    const detail = event.detail || {};
    for (const ref of views) {
        const view = ref.deref();
        if (!view) { views.delete(ref); continue; }
        if (String(view.node.id) === String(detail.node_id)) {
            const message = detail.exception_message || "请查看执行错误";
            view.fail(message.startsWith("保存失败") ? message : `保存失败：${message}`);
        }
    }
});

// Translate presentation only: names remain stable for workflow/API compatibility.
function localizeInputLabels(node) {
    const labels = {"images": "图像", "filename_prefix": "文件名前缀", "subfolder": "保存子目录"};
    for (const input of node.inputs || []) {
        if (Object.hasOwn(labels, input.name)) input.label = labels[input.name];
    }
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "comfyui.visual-save-image",
    nodeCreated(node) {
        if (node.comfyClass !== "VisualSaveImage") return;
        localizeInputLabels(node);
        // The custom pager owns the preview; keep ui.images for native history.
        // This is also how ComfyUI's own custom image widgets suppress duplicates.
        node.hideOutputImages = true;
        // Classic's background handler creates a separate canvas preview widget
        // and does not consult hideOutputImages in frontend 1.55.
        node.onDrawBackground = function() {};
        for (const name of ["filename_prefix", "subfolder"]) {
            const widget = node.widgets?.find(w => w.name === name);
            if (!widget) continue;
            widget.hidden = true; widget.options ||= {}; widget.options.hidden = true;
            if (widget.inputEl) widget.inputEl.style.display = "none";
        }
        const view = new SaveView(node); views.add(new WeakRef(view));
        node.onExecuted = function(message) { view.executed(message); };
        const configure = node.onConfigure;
        node.onConfigure = function(...args) { configure?.apply(this, args); localizeInputLabels(this); view.sync(); };
        node.setSize([Math.max(node.size[0], 490), Math.max(node.size[1], 540)]);
    },
    loadedGraphNode(node) {
        if (node.comfyClass === "VisualSaveImage") localizeInputLabels(node);
    },
});
