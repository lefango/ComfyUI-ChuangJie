import { emptyState, parseState } from "./state.mjs";

const previews = new Set();
let watcher;

// A single watcher catches native undo/redo and node-copy restoration without
// retaining deleted nodes or patching ComfyUI's node prototypes.
function watch(preview) {
    previews.add(new WeakRef(preview));
    if (watcher) return;
    watcher = setInterval(() => {
        for (const ref of previews) {
            const current = ref.deref();
            if (!current) previews.delete(ref);
            else if (current.element.isConnected) current.update();
        }
        if (!previews.size) { clearInterval(watcher); watcher = null; }
    }, 400);
}

function element(tag, className, text) {
    const result = document.createElement(tag); result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
}

export class NodePreview {
    constructor(node, client, open) {
        this.node = node; this.client = client; this.height = 150;
        this.covers = new Map(); this.images = new Map(); this.requestId = 0;
        this.element = element("div", "lm-node-preview");
        this.element.setAttribute("aria-label", "LoRA 节点预览");
        this.preset = element("div", "lm-node-preset");
        this.heading = element("div", "lm-node-heading");
        this.scroll = element("div", "lm-node-scroll");
        this.scroll.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
        this.grid = element("div", "lm-node-grid"); this.scroll.append(this.grid);
        this.button = element("button", "lm-node-manage", "管理 LoRA");
        this.button.type = "button"; this.button.addEventListener("click", open);
        this.footer = element("div", "lm-node-footer");
        this.element.append(this.preset, this.heading, this.scroll, this.button, this.footer);
        this.observer = new IntersectionObserver((entries) => {
            for (const entry of entries) if (entry.isIntersecting) {
                this.observer.unobserve(entry.target); this.loadImage(entry.target);
            }
        }, { root: this.scroll, rootMargin: "150px" });
        this.widget = node.addDOMWidget("lora_preview", "lora-manager-preview", this.element, {
            serialize: false, hideOnZoom: false,
            surfaces: { canvas: "shown", vueNode: "shown", panel: "never" },
            getMinHeight: () => this.height, getHeight: () => this.height,
            onDraw: () => this.update(),
        });
        this.widget.serialize = false;
        const remove = this.widget.onRemove;
        const preview = this;
        this.widget.onRemove = function () { preview.releaseImages(); remove?.call(this); };
        watch(this); this.update();
    }

    update(force = false) {
        const raw = this.node.widgets?.find((widget) => widget.name === "config")?.value;
        const width = Math.round(this.node.size[0]);
        this.element.dataset.nodeId = String(this.node.id);
        if (!force && raw === this.lastValue && width === this.lastWidth) return;
        this.lastValue = raw; this.lastWidth = width;
        try {
            this.snapshot = parseState(raw || JSON.stringify(emptyState()));
            this.element.classList.remove("lm-node-error"); this.render();
            const files = this.snapshot.entries.filter((item) => item.enabled).map((item) => item.file);
            const key = JSON.stringify(files);
            if (force || key !== this.fileKey) { this.fileKey = key; this.fetchCovers(files); }
        } catch (error) {
            this.snapshot = null; this.observer.disconnect(); this.preset.hidden = true;
            this.element.classList.add("lm-node-error"); this.heading.textContent = "节点配置需要修复";
            this.grid.replaceChildren(element("div", "lm-node-empty", error.message));
            this.footer.textContent = "原配置已保留"; this.resize(180);
        }
    }

    resize(height) {
        const oldMinimum = this.height + 94;
        this.height = height; this.element.style.height = `${height}px`;
        const minimum = height + 94;
        const keepManualHeight = this.node.size[1] > oldMinimum + 2;
        const width = Math.max(400, this.node.size[0]);
        const required = Math.max(minimum, keepManualHeight ? this.node.size[1] : 0);
        if (width !== this.node.size[0] || required !== this.node.size[1]) this.node.setSize([width, required]);
        this.node.setDirtyCanvas?.(true, true);
    }

    render() {
        if (!this.snapshot) return;
        const active = this.snapshot.entries.filter((item) => item.enabled);
        const columns = this.node.size[0] < 470 ? 2 : 3;
        this.preset.hidden = !this.snapshot.preset;
        this.preset.textContent = this.snapshot.preset ? `预设：${this.snapshot.preset.name}` : "";
        this.preset.title = this.preset.textContent;
        this.heading.textContent = `当前启用 ${active.length} 个 LoRA`;
        this.grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
        this.observer.disconnect(); this.grid.replaceChildren();
        active.forEach((item, index) => {
            const card = element("article", "lm-node-card"); card.dataset.file = item.file;
            const cover = element("div", "lm-node-cover");
            const placeholder = element("span", "lm-node-placeholder", "LoRA"); cover.append(placeholder);
            const key = this.covers.get(item.file);
            if (key) {
                const img = element("img", "lm-node-image"); img.alt = `${item.name} 封面`; img.hidden = true;
                img.dataset.cover = key;
                img.addEventListener("load", () => { img.hidden = false; placeholder.hidden = true; });
                img.addEventListener("error", () => { img.hidden = true; placeholder.hidden = false; });
                cover.append(img); this.observer.observe(cover);
            }
            cover.append(element("span", "lm-node-order", String(index + 1).padStart(2, "0")));
            const name = element("div", "lm-node-name", item.name || item.file); name.title = `${item.name}\n${item.file}`;
            const weights = element("div", "lm-node-weights", `模型 ${item.strength_model.toFixed(2)} · CLIP ${item.strength_clip.toFixed(2)}`);
            card.append(cover, name, weights); this.grid.append(card);
        });
        if (!active.length) this.grid.append(element("div", "lm-node-empty", "尚未启用 LoRA，点击下方按钮选择。"));
        this.footer.textContent = `已启用 ${active.length} 项`;
        const rows = Math.min(3, Math.ceil(active.length / columns));
        this.resize((this.snapshot.preset ? 40 : 0) + 28 + (rows ? rows * 190 + (rows - 1) * 10 : 64) + 122);
    }

    async fetchCovers(files) {
        const id = ++this.requestId;
        if (!files.length) { this.element.dataset.coverStatus = "ready"; this.pruneImages(new Set()); return; }
        this.element.dataset.coverStatus = "loading";
        try {
            const result = await this.client.previews(files);
            if (id !== this.requestId) return;
            this.covers = new Map(result.items.map((item) => [item.file, item.cover]));
            this.pruneImages(new Set(result.items.map((item) => item.cover).filter(Boolean)));
            this.element.dataset.coverStatus = "ready"; this.element.title = ""; this.render();
        } catch (error) {
            if (id !== this.requestId) return;
            this.element.dataset.coverStatus = "error";
            this.element.title = `${error.message}。名称和配置已保留，可打开管理窗口后重试。`;
        }
    }

    async loadImage(target) {
        const img = target.querySelector("img");
        if (!img || img.getAttribute("src")) return;
        const key = img.dataset.cover;
        let cached = this.images.get(key);
        if (!cached) {
            cached = {}; this.images.set(key, cached);
            cached.promise = this.client.coverBlob(key).then((blob) => {
                if (this.images.get(key) !== cached) return null;
                cached.url = URL.createObjectURL(blob); return cached.url;
            }).catch(() => null);
        }
        const url = cached.url || await cached.promise;
        if (url && this.element.contains(img)) img.src = url;
    }

    pruneImages(keep) {
        for (const [key, cached] of this.images) if (!keep.has(key)) {
            if (cached.url) URL.revokeObjectURL(cached.url);
            this.images.delete(key);
        }
    }

    releaseImages() {
        this.requestId++; this.observer.disconnect(); this.pruneImages(new Set());
        this.lastValue = undefined; this.fileKey = undefined;
    }
}
