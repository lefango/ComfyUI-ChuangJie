const esc = (value) => String(value ?? "");

function node(tag, className = "", text = "") {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== "") result.textContent = text;
    return result;
}

function button(label, action, className = "") {
    const result = node("button", className, label);
    result.type = "button";
    result.addEventListener("click", action);
    return result;
}

function field(label, control) {
    const result = node("label", "ie-field");
    result.append(node("span", "", label), control);
    return result;
}

function errorText(error) {
    return error?.message || "操作失败，请重试。";
}

function dialogShell(title, className) {
    const dialog = node("dialog", `ie-dialog ${className}`);
    dialog.setAttribute("aria-label", title);
    return dialog;
}

function closeDialog(dialog) {
    if (dialog.open) dialog.close();
    dialog.remove();
}

/** Folder-based image library with legacy category migration support. */
export function openImageEditLibrary({ request, selectedId = null, onSelect = () => {} }) {
    if (typeof request !== "function") throw new TypeError("图片库需要 request 函数。");
    const dialog = dialogShell("图片素材库", "ie-dialog ie-library-dialog");
    const imageURLs = new Map();
    let images = [], folders = [], activeId = selectedId, currentFolderId = null, query = "", closed = false, busy = false;
    const header = node("header", "ie-header");
    header.append(node("div", "", "选择用于图像编辑的来源图片"), button("关闭", close, "ie-quiet"));
    const layout = node("div", "ie-library-layout");
    const content = node("section", "ie-library-content");
    const breadcrumbs = node("nav", "ie-breadcrumbs"); breadcrumbs.setAttribute("aria-label", "当前位置");
    const heading = node("div", "ie-library-heading"), title = node("h2", "", "全部图片"), count = node("span", "ie-muted"); heading.append(title, count);
    const toolbar = node("div", "ie-toolbar ie-library-toolbar");
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索文件夹或图片名称"; search.setAttribute("aria-label", "搜索文件夹或图片名称");
    const create = button("新建文件夹", openCreateFolder, "ie-primary");
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.setAttribute("aria-label", "导入图片");
    const importButton = button("导入图片", () => file.click(), "ie-primary");
    toolbar.append(search, create, importButton, file);
    const folderEditor = node("section", "ie-folder-editor");
    const folderGrid = node("div", "ie-folder-grid");
    const grid = node("div", "ie-image-grid");
    const statusBox = node("div", "ie-status", "正在读取图片…"); statusBox.setAttribute("role", "status"); statusBox.setAttribute("aria-live", "polite");
    const footer = node("footer", "ie-footer");
    footer.append(statusBox, button("取消", close, "ie-quiet"), button("使用所选图片", () => {
        const image = images.find((entry) => String(entry.id) === String(activeId));
        if (!image) { setStatus("请先选择一张图片。", true); return; }
        try { onSelect(image); close(); } catch (error) { setStatus(errorText(error), true); }
    }, "ie-primary"));
    content.append(breadcrumbs, heading, toolbar, folderEditor, folderGrid, grid); layout.append(content);
    dialog.append(header, layout, footer); document.body.append(dialog); dialog.showModal();

    function json(value) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }
    function setStatus(text, error = false) { statusBox.textContent = text; statusBox.classList.toggle("ie-error", error); }
    function openCreateFolder() {
        const createDialog = dialogShell("创建图片文件夹", "ie-folder-create-dialog");
        const form = node("form", "ie-folder-create-form");
        const name = document.createElement("input"); name.type = "text"; name.maxLength = 80; name.required = true; name.placeholder = "例如：人物草图"; name.setAttribute("aria-label", "文件夹名称");
        const notes = document.createElement("textarea"); notes.maxLength = 2000; notes.rows = 3; notes.placeholder = "备注（可选）"; notes.setAttribute("aria-label", "文件夹备注");
        const cover = document.createElement("select"); cover.setAttribute("aria-label", "文件夹封面图片"); cover.append(new Option("暂不设置封面", ""));
        for (const image of images) cover.append(new Option(image.name || `图片 ${image.id}`, String(image.id)));
        const actions = node("div", "ie-folder-create-actions");
        const cancel = button("取消", () => closeDialog(createDialog), "ie-quiet");
        const submit = button("创建文件夹", () => {}, "ie-primary"); submit.type = "submit";
        actions.append(cancel, submit);
        form.append(node("h2", "", currentFolderId ? "在当前文件夹中新建子文件夹" : "创建文件夹"),
            field("名称", name), field("备注", notes), field("封面", cover), actions);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (busy) return;
            const folderName = name.value.trim();
            if (!folderName) { name.focus(); return; }
            busy = true; submit.disabled = true;
            try {
                const created = await request("/image-edit/folder", json({ name: folderName,
                    parent_id: currentFolderId || null, notes: notes.value, cover_image_id: cover.value || null }));
                currentFolderId = created.id; query = ""; search.value = ""; closeDialog(createDialog);
                await refresh(); setStatus(`已创建文件夹“${created.name || folderName}”。`);
            } catch (error) { setStatus(errorText(error), true); }
            finally { busy = false; submit.disabled = false; }
        });
        createDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(createDialog); });
        createDialog.append(form); document.body.append(createDialog); createDialog.showModal(); name.focus();
    }
    function close() {
        if (closed) return; closed = true;
        for (const url of imageURLs.values()) URL.revokeObjectURL(url);
        imageURLs.clear(); closeDialog(dialog);
    }
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    async function refresh() {
        setStatus("正在读取图片…");
        const result = await request("/image-edit/library"); if (closed) return;
        images = Array.isArray(result?.images) ? result.images : (Array.isArray(result?.items) ? result.items : []);
        const rawFolders = Array.isArray(result?.folders) ? result.folders : (Array.isArray(result?.categories) ? result.categories : []);
        folders = rawFolders.map((entry) => typeof entry === "string"
            ? { id: entry, name: entry, parent_id: null, notes: "", cover_image_id: null }
            : { ...entry, parent_id: entry.parent_id || null, notes: entry.notes || "", cover_image_id: entry.cover_image_id || entry.coverImageId || null });
        if (currentFolderId && !folders.some((folder) => String(folder.id) === String(currentFolderId))) currentFolderId = null;
        const ids = new Set(images.map((entry) => String(entry.id)));
        for (const [id, url] of imageURLs) if (!ids.has(id)) { URL.revokeObjectURL(url); imageURLs.delete(id); }
        render(); setStatus(`${images.length} 张图片`);
    }
    function render() {
        const byId = new Map(folders.map((folder) => [String(folder.id), folder]));
        const children = (parent) => folders.filter((folder) => String(folder.parent_id || "") === String(parent || ""));
        const pathOf = (folder) => { const path = [], seen = new Set(); while (folder && !seen.has(String(folder.id))) { seen.add(String(folder.id)); path.unshift(folder); folder = folder.parent_id ? byId.get(String(folder.parent_id)) : null; } return path; };
        const current = byId.get(String(currentFolderId));
        const term = query.trim().toLocaleLowerCase();
        breadcrumbs.replaceChildren(button("全部图片", () => { currentFolderId = null; render(); }, "ie-crumb"));
        const path = pathOf(current);
        for (const [index, folder] of path.entries()) {
            breadcrumbs.append(node("span", "ie-crumb-separator", "/"), button(folder.name, () => { currentFolderId = folder.id; render(); }, `ie-crumb${index === path.length - 1 ? " is-current" : ""}`));
        }
        title.textContent = term ? `搜索：${query.trim()}` : (current?.name || "全部图片");
        const shown = images.filter((image) => {
            const nameMatches = !term || String(image.name || image.filename || "").toLocaleLowerCase().includes(term);
            const folderMatchesCurrent = term || !current || String(image.folder_id ?? image.category_id ?? image.category ?? "") === String(current.id);
            return nameMatches && folderMatchesCurrent;
        });
        count.textContent = `${shown.length} 张图片`;
        folderEditor.replaceChildren(); if (current) renderFolderEditor(current);
        const visibleFolders = folders.filter((folder) => term
            ? folder.name.toLocaleLowerCase().includes(term)
            : String(folder.parent_id || "") === String(currentFolderId || ""));
        folderGrid.replaceChildren();
        for (const folder of visibleFolders) {
            const card = node("article", "ie-folder-card");
            const open = button("", () => { currentFolderId = folder.id; query = ""; search.value = ""; render(); }, "ie-folder-card-open");
            open.setAttribute("aria-label", `打开文件夹 ${folder.name}`);
            open.title = pathOf(folder).map((entry) => entry.name).join(" / ");
            const cover = node("span", "ie-folder-card-cover");
            if (folder.cover_image_id && images.some((image) => String(image.id) === String(folder.cover_image_id))) {
                const coverImage = node("img"); coverImage.alt = ""; loadImage(folder.cover_image_id, coverImage); cover.append(coverImage);
            } else cover.append(node("span", "", "▧"));
            const details = node("span", "ie-folder-card-details");
            details.append(node("strong", "", folder.name), node("small", "", folder.notes || "文件夹"));
            open.append(cover, details);
            const imageCount = images.filter((image) => String(image.folder_id ?? image.category_id ?? image.category ?? "") === String(folder.id)).length;
            card.append(open, node("small", "ie-folder-card-count", `${imageCount} 张图片`)); folderGrid.append(card);
        }
        folderGrid.hidden = visibleFolders.length === 0;
        grid.replaceChildren();
        for (const image of shown) {
            const card = node("article", `ie-image-card${String(activeId) === String(image.id) ? " is-selected" : ""}`);
            const pick = button("", () => { activeId = image.id; render(); }, "ie-image-select"); pick.setAttribute("aria-label", `选择 ${image.name || "图片"}`);
            const thumb = node("img", "ie-thumbnail"); thumb.alt = image.name || "图片缩略图"; thumb.loading = "lazy";
            loadImage(image.id, thumb);
            pick.append(thumb);
            const imageFolder = byId.get(String(image.folder_id ?? image.category_id ?? image.category ?? ""));
            const caption = node("div", "ie-image-meta"); caption.append(node("strong", "", image.name || `图片 ${image.id}`), node("small", "", pathOf(imageFolder).map((entry) => entry.name).join(" / ") || "未分类"));
            const remove = button("删除", async () => {
                if (busy || !window.confirm(`删除“${image.name || "这张图片"}”？`)) return;
                busy = true;
                try { await request("/image-edit/delete", json({ id: image.id })); if (String(activeId) === String(image.id)) activeId = null; await refresh(); setStatus("图片已删除。"); }
                catch (error) { setStatus(errorText(error), true); }
                finally { busy = false; }
            }, "ie-danger");
            card.append(pick, caption, remove); grid.append(card);
        }
        if (!shown.length && !visibleFolders.length) grid.append(node("p", "ie-empty", term ? "没有找到匹配的文件夹或图片。" : (images.length ? "此文件夹还没有图片。" : "图片库为空，请导入图片。")));
    }
    function loadImage(id, image) {
        const key = String(id), cached = imageURLs.get(key);
        if (cached) { image.src = cached; return; }
        request(`/image-edit/image/${encodeURIComponent(id)}`, { responseType: "blob" }).then((blob) => {
            if (!(blob instanceof Blob)) throw new Error("图片接口没有返回图片数据。");
            const url = URL.createObjectURL(blob);
            const existing = imageURLs.get(key);
            if (existing) { URL.revokeObjectURL(url); if (image.isConnected) image.src = existing; return; }
            if (closed || !image.isConnected) { URL.revokeObjectURL(url); return; }
            imageURLs.set(key, url); image.src = url;
        }).catch(() => { if (image.isConnected) { image.alt = "图片预览读取失败"; image.classList.add("is-broken"); } });
    }
    function renderFolderEditor(folder) {
        const name = document.createElement("input"); name.value = folder.name; name.maxLength = 80; name.setAttribute("aria-label", "文件夹名称");
        const notes = document.createElement("textarea"); notes.value = folder.notes || ""; notes.maxLength = 2000; notes.rows = 2; notes.placeholder = "文件夹备注"; notes.setAttribute("aria-label", "文件夹备注");
        const cover = document.createElement("select"); cover.setAttribute("aria-label", "文件夹封面图片"); cover.append(new Option("无封面", ""));
        for (const image of images) cover.append(new Option(image.name || `图片 ${image.id}`, String(image.id)));
        cover.value = folder.cover_image_id || "";
        const save = button("保存文件夹资料", async () => {
            save.disabled = true;
            try { await request(`/image-edit/folder/${encodeURIComponent(folder.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.value.trim(), parent_id: folder.parent_id || null, notes: notes.value, cover_image_id: cover.value || null }) }); await refresh(); setStatus("文件夹资料已保存。"); }
            catch (error) { setStatus(errorText(error), true); }
            finally { save.disabled = false; }
        }, "ie-primary");
        folderEditor.append(field("文件夹名称", name), field("备注", notes), field("封面图片", cover), save);
    }
    search.addEventListener("input", () => { query = search.value; render(); });
    file.addEventListener("change", async () => {
        const selected = file.files?.[0]; if (!selected) return;
        importButton.disabled = true; const form = new FormData(); form.append("file", selected); form.append("folder_id", currentFolderId || "");
        try { await request("/image-edit/upload", { method: "POST", body: form }); await refresh(); setStatus(`已导入“${selected.name}”。`); }
        catch (error) { setStatus(errorText(error), true); }
        finally { importButton.disabled = false; file.value = ""; }
    });
    refresh().catch((error) => setStatus(errorText(error), true));
    return { close, dialog };
}

function isNotFound(error) {
    return error?.status === 404 || error?.response?.status === 404 || error?.code === 404 || /\b404\b/.test(error?.message || "");
}

async function readBlob(request, path, id) {
    const blob = await request(`${path}/${encodeURIComponent(id)}`, { responseType: "blob" });
    if (!(blob instanceof Blob)) throw new Error("图片接口没有返回图片数据。");
    return blob;
}

/** Open a grayscale mask editor; white areas are editable and black are protected. */
export function openMaskEditor({ request, image, maskBlob = null, onSave = () => {} }) {
    if (typeof request !== "function") {
        throw new TypeError("遮罩编辑器需要 request 函数。");
    }
    const imageId = image?.id ?? image?.image_id;
    if (imageId == null) throw new TypeError("遮罩编辑器需要带有 id 的图片记录。");
    const dialog = dialogShell("编辑保护遮罩", "ie-mask-dialog");
    const heading = node("h2", "", "编辑保护遮罩");
    const help = node("p", "ie-mask-help", "新遮罩默认保护整张图片。白色区域允许编辑，黑色区域受保护；拖动画笔涂白，按住 Shift 或勾选橡皮擦涂黑。");
    const brush = document.createElement("input");
    brush.type = "range"; brush.min = "4"; brush.max = "256"; brush.step = "1"; brush.value = "48";
    brush.setAttribute("aria-label", "画笔大小");
    const sizeLabel = node("output", "", `${brush.value}px`);
    brush.addEventListener("input", () => { sizeLabel.value = `${brush.value}px`; sizeLabel.textContent = sizeLabel.value; });
    const erase = document.createElement("input"); erase.type = "checkbox"; erase.setAttribute("aria-label", "擦除为受保护区域");
    const tools = node("div", "ie-mask-tools");
    tools.append(field("画笔大小", brush), field("擦除（黑色）", erase), sizeLabel,
        button("清空（全部保护）", () => { if (canvas.width) { context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height); } }, "ie-quiet"));
    const viewport = node("div", "ie-canvas-viewport");
    const backdrop = node("img", "ie-image-backdrop");
    backdrop.alt = image?.name || "正在编辑的源图片";
    const canvas = document.createElement("canvas");
    canvas.className = "ie-mask-canvas";
    canvas.setAttribute("aria-label", "遮罩画布");
    viewport.append(backdrop, canvas);
    const statusBox = node("div", "ie-status", "正在读取图片和遮罩…"); statusBox.setAttribute("role", "status"); statusBox.setAttribute("aria-live", "polite");
    const cancel = button("取消", closeMaskEditor, "ie-quiet");
    const save = button("保存遮罩", async () => {
        if (!canvas.width || saving) return;
        save.disabled = true; saving = true;
        try {
            const data = canvas.toDataURL("image/png");
            const result = await request("/image-edit/mask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: imageId, data }) });
            await onSave(result, data);
            closeMaskEditor();
        } catch (error) { statusBox.textContent = errorText(error); statusBox.classList.add("ie-error"); }
        finally { saving = false; save.disabled = false; }
    }, "ie-primary");
    const removeMask = button("移除遮罩（编辑整图）", async () => {
        if (saving) return;
        removeMask.disabled = true; saving = true;
        try {
            await request("/image-edit/mask/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: imageId }) });
            await onSave({ id: imageId, has_mask: false }, null);
            closeMaskEditor();
        } catch (error) { statusBox.textContent = errorText(error); statusBox.classList.add("ie-error"); }
        finally { saving = false; removeMask.disabled = false; }
    }, "ie-quiet");
    const footer = node("footer", "ie-footer"); footer.append(statusBox, removeMask, cancel, save);
    let closed = false;
    let sourceURL = null;
    function closeMaskEditor() {
        if (closed) return;
        closed = true;
        if (sourceURL) URL.revokeObjectURL(sourceURL);
        sourceURL = null;
        closeDialog(dialog);
    }
    dialog.append(heading, help, tools, viewport, footer);
    document.body.append(dialog);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeMaskEditor(); });
    dialog.showModal();

    const context = canvas.getContext("2d", { willReadFrequently: false });
    backdrop.decoding = "async";
    let drawing = false;
    let lastPoint = null;
    let activePointer = null;
    let previousErase = null;
    let saving = false;

    function pointFromEvent(event) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
            y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) };
    }
    function dab(point, pressure = 1) {
        const radius = Number(brush.value) * (pressure > 0 ? pressure : 1) / 2;
        const soft = context.createRadialGradient(point.x, point.y, Math.max(0, radius * 0.45), point.x, point.y, radius);
        const color = erase.checked ? "0,0,0" : "255,255,255";
        soft.addColorStop(0, `rgba(${color},1)`);
        soft.addColorStop(0.72, `rgba(${color},0.7)`);
        soft.addColorStop(1, `rgba(${color},0)`);
        context.globalCompositeOperation = "source-over";
        context.fillStyle = soft;
        context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
    }
    function stroke(from, to, event) {
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        const spacing = Math.max(1, Number(brush.value) * 0.12);
        const steps = Math.max(1, Math.ceil(distance / spacing));
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            dab({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, event.pressure);
        }
    }
    canvas.addEventListener("pointerdown", (event) => {
        if (canvas.width === 0 || (event.button !== 0 && event.pointerType === "mouse")) return;
        event.preventDefault(); drawing = true; activePointer = event.pointerId; lastPoint = pointFromEvent(event);
        canvas.setPointerCapture(event.pointerId);
        if (event.shiftKey) { previousErase = erase.checked; erase.checked = true; }
        dab(lastPoint, event.pressure);
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!drawing || event.pointerId !== activePointer) return;
        const point = pointFromEvent(event);
        if (point && lastPoint) stroke(lastPoint, point, event);
        lastPoint = point;
    });
    const stop = (event) => {
        if (activePointer === event.pointerId) {
            drawing = false; lastPoint = null; activePointer = null;
            if (previousErase !== null) { erase.checked = previousErase; previousErase = null; }
        }
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("lostpointercapture", stop);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    async function restoreMask() {
        let blob = maskBlob;
        if (!blob) {
            try { blob = await readBlob(request, "/image-edit/mask", imageId); }
            catch (error) { if (isNotFound(error)) return; throw error; }
        }
        if (!blob) return;
        if (typeof blob === "string") {
            if (!blob.startsWith("data:")) throw new Error("已有遮罩需要以 Blob 或 data URL 形式提供。");
            const [metadata, payload] = blob.split(",", 2);
            const mime = metadata.match(/^data:([^;,]+)/)?.[1] || "image/png";
            const bytes = metadata.includes(";base64") ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(payload));
            blob = new Blob([bytes], { type: mime });
        }
        const mask = new Image();
        mask.src = URL.createObjectURL(blob);
        try {
            await mask.decode();
            const buffer = document.createElement("canvas"); buffer.width = canvas.width; buffer.height = canvas.height;
            const bufferContext = buffer.getContext("2d", { willReadFrequently: true });
            bufferContext.drawImage(mask, 0, 0, buffer.width, buffer.height);
            const pixels = bufferContext.getImageData(0, 0, buffer.width, buffer.height);
            for (let index = 0; index < pixels.data.length; index += 4) {
                const luminance = Math.round(pixels.data[index] * 0.2126 + pixels.data[index + 1] * 0.7152 + pixels.data[index + 2] * 0.0722);
                pixels.data[index] = luminance; pixels.data[index + 1] = luminance; pixels.data[index + 2] = luminance; pixels.data[index + 3] = 255;
            }
            bufferContext.putImageData(pixels, 0, 0);
            context.drawImage(buffer, 0, 0);
        } finally { URL.revokeObjectURL(mask.src); }
    }
    backdrop.addEventListener("load", async () => {
        if (dialog.isConnected === false) return;
        canvas.width = backdrop.naturalWidth; canvas.height = backdrop.naturalHeight;
        viewport.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
        const targetWidth = Math.min(dialog.clientWidth - 42, window.innerHeight * 0.64 * canvas.width / canvas.height);
        if (targetWidth > 0) viewport.style.maxWidth = `${targetWidth}px`;
        context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height);
        try {
            await restoreMask();
            statusBox.textContent = `${canvas.width} × ${canvas.height} px · 白色可编辑，黑色受保护`;
            statusBox.classList.remove("ie-error");
        } catch (error) { statusBox.textContent = `${errorText(error)} 已显示空白遮罩。`; statusBox.classList.add("ie-error"); }
    }, { once: true });
    backdrop.addEventListener("error", () => { statusBox.textContent = "源图片加载失败，请检查图片库连接后重试。"; statusBox.classList.add("ie-error"); }, { once: true });
    readBlob(request, "/image-edit/image", imageId).then((blob) => {
        if (closed) return;
        sourceURL = URL.createObjectURL(blob);
        backdrop.src = sourceURL;
    }).catch((error) => {
        if (closed) return;
        statusBox.textContent = errorText(error);
        statusBox.classList.add("ie-error");
    });
    return { close: closeMaskEditor, dialog, canvas };
}
