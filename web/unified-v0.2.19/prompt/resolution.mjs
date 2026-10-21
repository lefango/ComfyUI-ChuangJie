import { el, button, dialog } from "./ui.mjs";

export const RATIOS = [
    { id: "1:1", title: "方形", w: 1, h: 1 },
    { id: "4:5", title: "人像竖幅", w: 4, h: 5 },
    { id: "3:4", title: "竖幅", w: 3, h: 4 },
    { id: "2:3", title: "长竖幅", w: 2, h: 3 },
    { id: "9:16", title: "手机全屏", w: 9, h: 16 },
    { id: "4:3", title: "横向标准", w: 4, h: 3 },
    { id: "3:2", title: "横向摄影", w: 3, h: 2 },
    { id: "16:9", title: "横向宽屏", w: 16, h: 9 },
    { id: "21:9", title: "电影宽幅", w: 21, h: 9 },
    { id: "9:21", title: "电影竖幅", w: 9, h: 21 },
];
const MAX_SIZE = 16384;

export function largestSizeForRatio(widthRatio, heightRatio) {
    const w = Number(widthRatio), h = Number(heightRatio);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1000 || h > 1000)
        throw new RangeError("自定义比例须为 1 到 1000 之间的整数");
    const square = w === h;
    const maxWidth = square || w < h ? 1080 : 1920;
    const maxHeight = square || w > h ? 1080 : 1920;
    const scale = Math.min(maxWidth / w, maxHeight / h);
    return { width: Math.floor(w * scale / 8) * 8, height: Math.floor(h * scale / 8) * 8 };
}

export function ratioShapeDimensions(widthRatio, heightRatio, maxWidth = 42, maxHeight = 54) {
    const scale = Math.min(maxWidth / widthRatio, maxHeight / heightRatio);
    return { width: Math.min(maxWidth, widthRatio * scale), height: Math.min(maxHeight, heightRatio * scale) };
}

export function dimensionsForRatio(widthRatio, heightRatio, longEdge) {
    const w = Number(widthRatio), h = Number(heightRatio), edge = Number(longEdge);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1000 || h > 1000 ||
        !Number.isInteger(edge) || edge < 16 || edge > MAX_SIZE) throw Error("自定义比例或长边尺寸无效");
    const scale = edge / Math.max(w, h);
    return { width: Math.max(16, Math.floor(w * scale / 8) * 8),
        height: Math.max(16, Math.floor(h * scale / 8) * 8) };
}

function ratioFor(width, height) {
    const ratio = width / height;
    return RATIOS.find(item => Math.abs(ratio - item.w / item.h) / (item.w / item.h) < 0.015)?.id || "custom";
}

function integer(value, label, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw Error(`${label}须为 ${min} 到 ${max} 之间的整数`);
    return number;
}

export function openResolutionSelector(getSettings, setSettings) {
    const current = getSettings();
    const d = dialog("分辨率选择"); d.panel.classList.add("pm-resolution-dialog");
    d.body.append(el("p", "pm-muted", "选择画幅比例后自动匹配最大尺寸；也可自定义比例、宽高和批次数。"));
    const grid = el("div", "pm-ratio-grid");
    const custom = el("section", "pm-resolution-custom");
    const width = el("input"), height = el("input"), batch = el("input");
    for (const input of [width, height]) { input.type = "number"; input.min = "16"; input.max = String(MAX_SIZE); input.step = "8"; }
    batch.type = "number"; batch.min = "1"; batch.max = "4096"; batch.step = "1";
    width.value = String(current.width); height.value = String(current.height); batch.value = String(current.batchSize);
    width.ariaLabel = "latent 宽度"; height.ariaLabel = "latent 高度"; batch.ariaLabel = "latent 批量数";
    let selectedRatio = ratioFor(current.width, current.height);
    let ratioW = 6, ratioH = 9;
    const ratioWInput = el("input"), ratioHInput = el("input");
    for (const input of [ratioWInput, ratioHInput]) { input.type = "number"; input.min = "1"; input.max = "1000"; input.step = "1"; }
    ratioWInput.value = String(ratioW); ratioHInput.value = String(ratioH);
    ratioWInput.ariaLabel = "自定义比例宽"; ratioHInput.ariaLabel = "自定义比例高";

    const ratioStatus = el("p", "pm-muted");
    const sizeStatus = el("p", "pm-muted");
    function showRatio() {
        ratioStatus.textContent = selectedRatio === "custom" ? "当前为自定义比例" : `当前比例：${selectedRatio}${selectedRatio === "2:3" ? "（也可写作 6:9）" : ""} · ${RATIOS.find(item => item.id === selectedRatio)?.title}`;
        for (const card of grid.querySelectorAll(".pm-ratio-card")) card.setAttribute("aria-pressed", String(card.dataset.ratio === selectedRatio));
    }
    function setSize(w, h, ratio = ratioFor(w, h)) {
        width.value = String(w); height.value = String(h); selectedRatio = ratio; showRatio();
        sizeStatus.textContent = `当前尺寸：${w} × ${h}`;
        for (const card of grid.querySelectorAll(".pm-ratio-card")) card.setAttribute("aria-pressed", String(card.dataset.ratio === selectedRatio));
    }
    function chooseRatio(item) {
        const size = largestSizeForRatio(item.w, item.h);
        setSize(size.width, size.height, item.id);
    }
    for (const item of RATIOS) {
        const card = button("", () => chooseRatio(item)); card.classList.add("pm-ratio-card"); card.dataset.ratio = item.id;
        const shape = el("span", "pm-ratio-shape"), shapeSize = ratioShapeDimensions(item.w, item.h);
        shape.style.width = `${shapeSize.width}px`; shape.style.height = `${shapeSize.height}px`;
        shape.style.aspectRatio = `${item.w} / ${item.h}`;
        card.ariaLabel = `比例 ${item.id}，${item.title}`;
        const size = largestSizeForRatio(item.w, item.h);
        card.append(shape, el("strong", "", item.id), el("span", "pm-ratio-orientation", item.title),
            el("small", "", `${size.width} × ${size.height}`));
        grid.append(card);
    }
    const customCard = button("自定义比例", () => { selectedRatio = "custom"; showRatio(); });
    customCard.classList.add("pm-ratio-card", "pm-ratio-custom-card"); customCard.dataset.ratio = "custom";
    customCard.append(el("span", "pm-ratio-shape pm-ratio-shape-custom", "自"), el("strong", "", "自定义"), el("span", "pm-ratio-orientation", "任意比例")); grid.append(customCard);

    const customTitle = el("h3", "", "自定义比例 / 宽高");
    const ratioFields = el("div", "pm-resolution-ratio-fields");
    const ratioWLabel = el("label", "pm-field", "比例宽"); ratioWLabel.append(ratioWInput);
    const ratioHLabel = el("label", "pm-field", "比例高"); ratioHLabel.append(ratioHInput);
    ratioFields.append(ratioWLabel, ratioHLabel);
    const applyRatio = button("应用自定义比例", () => {
        const size = largestSizeForRatio(ratioWInput.value, ratioHInput.value);
        setSize(size.width, size.height, "custom");
    });
    custom.append(customTitle, ratioFields, applyRatio);

    const dimensions = el("div", "pm-resolution-dimensions");
    const widthLabel = el("label", "pm-field", "宽度（像素）"); widthLabel.append(width);
    const heightLabel = el("label", "pm-field", "高度（像素）"); heightLabel.append(height);
    const batchLabel = el("label", "pm-field", "批量数"); batchLabel.append(batch);
    dimensions.append(widthLabel, heightLabel, batchLabel);
    const inputsChanged = () => {
        const w = Number(width.value), h = Number(height.value);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            selectedRatio = ratioFor(w, h); showRatio(); sizeStatus.textContent = `当前尺寸：${w} × ${h}`;
        }
    };
    width.addEventListener("input", inputsChanged); height.addEventListener("input", inputsChanged);
    const actions = el("div", "pm-toolbar pm-resolution-actions"), error = el("p", "pm-error"); error.role = "alert";
    actions.append(button("取消", d.close), button("应用分辨率", () => {
        try {
            const w = integer(width.value, "宽度", 16, MAX_SIZE), h = integer(height.value, "高度", 16, MAX_SIZE);
            const count = integer(batch.value, "批量数", 1, 4096);
            if (w % 8 || h % 8) throw Error("宽度和高度需为 8 的倍数；请调整自定义数值。");
            setSettings({ width: w, height: h, batchSize: count }); d.close();
        } catch (e) { error.textContent = e.message; }
    }));
    d.body.append(ratioStatus, grid, custom, dimensions, sizeStatus, error, actions);
    showRatio();
}
