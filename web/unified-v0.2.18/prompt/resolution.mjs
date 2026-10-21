import { el, button, dialog } from "./ui.mjs";

export const RATIOS = [
    { id: "1:1", title: "方图", w: 1, h: 1, sizes: [[512, 512], [768, 768], [1024, 1024]] },
    { id: "4:3", title: "横屏", w: 4, h: 3, sizes: [[768, 576], [1024, 768], [1408, 1056]] },
    { id: "3:4", title: "竖屏", w: 3, h: 4, sizes: [[576, 768], [768, 1024], [1056, 1408]] },
    { id: "3:2", title: "横屏", w: 3, h: 2, sizes: [[768, 512], [1152, 768], [1608, 1072]] },
    { id: "2:3", alias: "6:9", title: "竖屏", w: 2, h: 3, sizes: [[512, 768], [768, 1152], [1072, 1608]] },
    { id: "16:9", title: "横屏", w: 16, h: 9, sizes: [[1024, 576], [1280, 720], [1920, 1080]] },
    { id: "9:16", title: "竖屏", w: 9, h: 16, sizes: [[576, 1024], [720, 1280], [1080, 1920]] },
];
const MAX_SIZE = 16384;

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
    return RATIOS.find(item => Math.abs(ratio - item.w / item.h) < 0.012)?.id || "custom";
}

function integer(value, label, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw Error(`${label}须为 ${min} 到 ${max} 之间的整数`);
    return number;
}

export function openResolutionSelector(getSettings, setSettings) {
    const current = getSettings();
    const d = dialog("分辨率选择"); d.panel.classList.add("pm-resolution-dialog");
    d.body.append(el("p", "pm-muted", "先选比例，再选内置尺寸；也可直接修改宽高。内置预设最高到 1080×1920 档，自定义尺寸可更大。"));
    const grid = el("div", "pm-ratio-grid");
    const sizeArea = el("section", "pm-resolution-sizes");
    const custom = el("section", "pm-resolution-custom");
    const width = el("input"), height = el("input"), batch = el("input");
    for (const input of [width, height]) { input.type = "number"; input.min = "16"; input.max = String(MAX_SIZE); input.step = "8"; }
    batch.type = "number"; batch.min = "1"; batch.max = "4096"; batch.step = "1";
    width.value = String(current.width); height.value = String(current.height); batch.value = String(current.batchSize);
    width.ariaLabel = "latent 宽度"; height.ariaLabel = "latent 高度"; batch.ariaLabel = "latent 批量数";
    let selectedRatio = ratioFor(current.width, current.height);
    let ratioW = 6, ratioH = 9;
    const ratioWInput = el("input"), ratioHInput = el("input"), longEdge = el("input");
    for (const input of [ratioWInput, ratioHInput]) { input.type = "number"; input.min = "1"; input.max = "1000"; input.step = "1"; }
    longEdge.type = "number"; longEdge.min = "16"; longEdge.max = String(MAX_SIZE); longEdge.step = "8";
    ratioWInput.value = String(ratioW); ratioHInput.value = String(ratioH); longEdge.value = String(Math.max(current.width, current.height));
    ratioWInput.ariaLabel = "自定义比例宽"; ratioHInput.ariaLabel = "自定义比例高"; longEdge.ariaLabel = "自定义比例长边尺寸";

    const ratioStatus = el("p", "pm-muted");
    const sizeStatus = el("p", "pm-muted");
    function showRatio() {
        ratioStatus.textContent = selectedRatio === "custom" ? "当前为自定义比例" : `当前比例：${selectedRatio}${selectedRatio === "2:3" ? "（也可写作 6:9）" : ""} · ${RATIOS.find(item => item.id === selectedRatio)?.title}`;
        for (const card of grid.querySelectorAll(".pm-ratio-card")) card.setAttribute("aria-pressed", String(card.dataset.ratio === selectedRatio));
    }
    function setSize(w, h) {
        width.value = String(w); height.value = String(h); selectedRatio = ratioFor(w, h); showRatio();
        sizeStatus.textContent = `当前尺寸：${w} × ${h}`;
        renderSizes();
    }
    function renderSizes() {
        sizeArea.replaceChildren(el("h3", "", "选择分辨率"));
        const ratio = RATIOS.find(item => item.id === selectedRatio);
        if (!ratio) {
            sizeArea.append(el("p", "pm-muted", "自定义比例请设置比例数值与长边，或直接输入宽高。"));
            return;
        }
        const choices = el("div", "pm-size-options");
        for (const [index, [w, h]] of ratio.sizes.entries()) {
            const choice = button(`${["低", "中", "高"][index]} · ${w} × ${h}`, () => setSize(w, h));
            choice.classList.add("pm-size-choice");
            choice.setAttribute("aria-pressed", String(Number(width.value) === w && Number(height.value) === h));
            choices.append(choice);
        }
        sizeArea.append(choices);
    }
    function chooseRatio(item) {
        selectedRatio = item.id;
        const [w, h] = item.sizes[1];
        setSize(w, h);
    }
    for (const item of RATIOS) {
        const card = button("", () => chooseRatio(item)); card.classList.add("pm-ratio-card"); card.dataset.ratio = item.id;
        const shape = el("span", "pm-ratio-shape"); shape.style.aspectRatio = `${item.w} / ${item.h}`;
        card.ariaLabel = `比例 ${item.id}，${item.title}${item.alias ? `，别名 ${item.alias}` : ""}`;
        card.append(shape, el("strong", "", item.id), el("span", "pm-ratio-orientation", item.title));
        if (item.alias) card.append(el("small", "", `别名 ${item.alias}`));
        grid.append(card);
    }
    const customCard = button("自定义比例", () => { selectedRatio = "custom"; showRatio(); renderSizes(); });
    customCard.classList.add("pm-ratio-card", "pm-ratio-custom-card"); customCard.dataset.ratio = "custom";
    customCard.append(el("span", "pm-ratio-shape pm-ratio-shape-custom", "自"), el("strong", "", "自定义"), el("span", "pm-ratio-orientation", "任意比例")); grid.append(customCard);

    const customTitle = el("h3", "", "自定义比例 / 宽高");
    const ratioFields = el("div", "pm-resolution-ratio-fields");
    const ratioWLabel = el("label", "pm-field", "比例宽"); ratioWLabel.append(ratioWInput);
    const ratioHLabel = el("label", "pm-field", "比例高"); ratioHLabel.append(ratioHInput);
    const longLabel = el("label", "pm-field", "长边像素"); longLabel.append(longEdge);
    ratioFields.append(ratioWLabel, ratioHLabel, longLabel);
    const applyRatio = button("应用自定义比例", () => {
        const size = dimensionsForRatio(ratioWInput.value, ratioHInput.value, longEdge.value);
        selectedRatio = "custom"; setSize(size.width, size.height);
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
            renderSizes();
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
    d.body.append(ratioStatus, grid, sizeArea, custom, dimensions, sizeStatus, error, actions);
    showRatio(); renderSizes();
}
