import {
  cloneState,
  createInitialState,
  createGalleryFolder,
  mergeState,
  resolveModelCapabilities,
  updateGalleryFolder,
} from "./state.mjs";

const ASPECT_RATIOS = ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"];
const EDIT_MIN_DIMENSION = 16;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const RESOLUTION_PRESETS = [
  { width: 1024, height: 1024, ratio: "1:1", label: "正方形" },
  { width: 1152, height: 864, ratio: "4:3", label: "横向" },
  { width: 1216, height: 832, ratio: "3:2", label: "横向" },
  { width: 1280, height: 720, ratio: "16:9", label: "宽屏" },
  { width: 864, height: 1152, ratio: "3:4", label: "竖向" },
  { width: 832, height: 1216, ratio: "2:3", label: "竖向" },
  { width: 720, height: 1280, ratio: "9:16", label: "手机" },
  { width: 1080, height: 1920, ratio: "9:16", label: "全高清竖屏" },
];

const DEFAULT_CATALOG = {
  models: [
    { id: "krea2", name: "Krea 2", family: "krea2", category: "图像编辑", cover: "" },
    { id: "flux-dev", name: "FLUX.1 Dev", family: "text", category: "文生图", cover: "" },
    { id: "sdxl-base", name: "SDXL Base", family: "text", category: "文生图", cover: "" },
  ],
  clips: [
    { id: "clip-l", name: "CLIP-L" },
    { id: "clip-g", name: "CLIP-G" },
    { id: "t5-xxl", name: "T5-XXL" },
  ],
  vaes: [
    { id: "default", name: "默认 VAE" },
    { id: "vae-ft-mse", name: "vae-ft-mse-840000" },
  ],
  loras: [
    { id: "detail-xl", name: "细节增强 XL", category: "画质" },
    { id: "soft-light", name: "柔光人像", category: "光影" },
    { id: "ink-line", name: "线稿强化", category: "风格" },
  ],
  styles: [
    { id: "soft-cinema", name: "柔光电影", category: "摄影", image: "", positive: "柔和电影光线", negative: "过度锐化" },
    { id: "editorial", name: "编辑肖像", category: "人像", image: "", positive: "编辑风格肖像", negative: "" },
    { id: "watercolor", name: "水彩插画", category: "插画", image: "", positive: "水彩纸面质感", negative: "照片质感" },
    { id: "night-city", name: "夜色街景", category: "场景", image: "", positive: "城市夜景灯光", negative: "" },
  ],
};

const DEFAULT_PROMPTS = [
  { id: "portrait-basic", name: "人物肖像", category: "人像", positive: "人物肖像，柔和自然光，清晰五官", negative: "模糊，低清晰度，畸形手部", enabled: true },
  { id: "product-clean", name: "简洁产品图", category: "产品", positive: "干净背景，产品摄影，柔和阴影", negative: "杂乱背景，强烈反光", enabled: true },
  { id: "landscape-film", name: "电影风景", category: "风景", positive: "电影感风景，层次光线，真实材质", negative: "过曝，色彩溢出", enabled: true },
];

const PANEL_TITLES = {
  resolution: ["分辨率", "选择常用尺寸，或输入自定义宽高。"],
  model: ["模型管理", "选择模型及其 CLIP、VAE 与 LoRA。"],
  styles: ["选择风格", "可同时选择多种风格；第一种作为封面参考。"],
  prompts: ["提示词预设", "查找、应用或整理常用提示词。"],
  sampler: ["K 采样器设置", "采样参数在节点内部使用。"],
  gallery: ["图片相册", "整理文件夹、图片封面和备注，并选择待编辑图片。"],
  images: ["图片相册", "整理文件夹、图片封面和备注，并选择待编辑图片。"],
  categories: ["图片相册", "整理文件夹、图片封面和备注，并选择待编辑图片。"],
};

let managedStylesheet = null;
let managedStylesheetUsers = 0;
let componentInstanceSequence = 0;

function createElement(tagName, className = "", text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function createButton(text, action, className = "cc-button", detail = {}) {
  const button = createElement("button", className, text);
  button.type = "button";
  button.dataset.action = action;
  for (const [key, value] of Object.entries(detail)) button.dataset[key] = value;
  return button;
}

function createField(labelText, control, className = "") {
  const field = createElement("label", `cc-field ${className}`.trim());
  const label = createElement("span", "cc-field-label", labelText);
  field.append(label, control);
  return field;
}

function createTextInput(value, attributes = {}) {
  const input = createElement("input", "cc-input");
  input.type = attributes.type || "text";
  input.value = value ?? "";
  for (const [key, attributeValue] of Object.entries(attributes)) {
    if (key !== "type") input.setAttribute(key, attributeValue);
  }
  return input;
}

function createSelect(options, selectedValue, className = "cc-select") {
  const select = createElement("select", className);
  for (const option of options) {
    const value = typeof option === "string" ? option : option.id;
    const label = typeof option === "string" ? option : option.name;
    const element = createElement("option", "", label);
    element.value = value;
    select.append(element);
  }
  select.value = selectedValue;
  return select;
}

function createPhotoIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 48 40");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("cc-photo-icon");
  const frame = document.createElementNS(icon.namespaceURI, "rect");
  frame.setAttribute("x", "2"); frame.setAttribute("y", "2");
  frame.setAttribute("width", "44"); frame.setAttribute("height", "36");
  frame.setAttribute("rx", "4");
  const sun = document.createElementNS(icon.namespaceURI, "circle");
  sun.setAttribute("cx", "34"); sun.setAttribute("cy", "12"); sun.setAttribute("r", "3.5");
  const landscape = document.createElementNS(icon.namespaceURI, "path");
  landscape.setAttribute("d", "M7 32 19 19l8 9 5-5 9 9");
  icon.append(frame, sun, landscape);
  return icon;
}

function ensureStylesheet(stylesheetUrl) {
  const existing = managedStylesheet || document.querySelector("link[data-cc-styles]");
  if (existing === managedStylesheet && managedStylesheet) {
    managedStylesheetUsers += 1;
    return () => {
      managedStylesheetUsers -= 1;
      if (managedStylesheetUsers === 0) {
        managedStylesheet.remove();
        managedStylesheet = null;
      }
    };
  }
  if (existing || stylesheetUrl === false) return () => {};
  const stylesheet = createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.dataset.ccStyles = "true";
  stylesheet.href = stylesheetUrl || new URL("./collection-console.css", import.meta.url).href;
  document.head.append(stylesheet);
  managedStylesheet = stylesheet;
  managedStylesheetUsers = 1;
  return () => {
    managedStylesheetUsers -= 1;
    if (managedStylesheetUsers === 0) {
      stylesheet.remove();
      managedStylesheet = null;
    }
  };
}

function getPath(record, path) {
  return path.split(".").reduce((value, key) => value?.[key], record);
}

function setPath(record, path, value) {
  const parts = path.split(".");
  let target = record;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = value;
}

function formatResolution(resolution) {
  return `${resolution.width} × ${resolution.height}`;
}

function fittedEditResolution(image) {
  const width = Number(image?.width), height = Number(image?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const scale = Math.min(1, 1080 / width, 1920 / height);
  const align = scale === 1 ? Math.floor : Math.round;
  return { width: Math.min(1080, Math.max(EDIT_MIN_DIMENSION, align(width * scale / 8) * 8)),
    height: Math.min(1920, Math.max(EDIT_MIN_DIMENSION, align(height * scale / 8) * 8)) };
}

function previewTargetResolution(currentState) {
  const capabilities = resolveModelCapabilities(currentState.model);
  return capabilities.imageEditing && currentState.editImage.src
    ? fittedEditResolution(currentState.editImage) || currentState.resolution
    : currentState.resolution;
}

function findModel(catalog, model) {
  return catalog.models.find((item) => item.id === model?.id) || model;
}

function chooseRatio(width, height) {
  const ratio = Number(width) / Number(height);
  const ratios = [
    ["1:1", 1], ["4:3", 4 / 3], ["3:2", 3 / 2], ["16:9", 16 / 9],
    ["3:4", 3 / 4], ["2:3", 2 / 3], ["9:16", 9 / 16],
  ];
  const closest = ratios.toSorted((left, right) => Math.abs(left[1] - ratio) - Math.abs(right[1] - ratio))[0];
  return closest && Math.abs(closest[1] - ratio) < 0.025 ? closest[0] : "自定义";
}

function safeCall(callback, payload, reportError) {
  try {
    return callback?.(payload);
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
  }
}

function isSupportedImageFile(file) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(String(file?.type || "").toLowerCase());
}

function uploadErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return `图片上传失败：${message || "请重试"}`;
}

export function mountCollectionConsole(container, options = {}) {
  if (!container?.append) throw new TypeError("mountCollectionConsole 需要一个 DOM 容器。");

  const instanceId = ++componentInstanceSequence;
  const stylesheetCleanup = ensureStylesheet(options.stylesheetUrl);
  const abortController = new AbortController();
  const objectUrls = new Set();
  const catalog = {
    ...DEFAULT_CATALOG,
    ...(options.catalog || {}),
  };
  for (const key of Object.keys(DEFAULT_CATALOG)) catalog[key] = options.catalog?.[key] || DEFAULT_CATALOG[key];
  const samplerOptions = options.samplers || ["euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde"];
  const schedulerOptions = options.schedulers || ["normal", "karras", "exponential", "simple", "sgm_uniform"];
  const startingState = options.initialState || {};
  let state = createInitialState({
    promptPresets: startingState.promptPresets || DEFAULT_PROMPTS,
    ...startingState,
  });
  let draft = null;
  let activePanel = "";
  let modelTab = "models";
  let styleFilter = "全部";
  let styleSearch = "";
  let styleFavoritesOnly = false;
  let modelSearch = "";
  let promptSearch = "";
  let promptFilter = "全部";
  let gallerySearch = "";
  let selectedFolderId = "";
  let imageImportSequence = 0;
  let pendingImageSelection = 0;
  let gallerySelectionMade = false;
  let selectedPresetId = state.selectedPromptPreset || state.promptPresets[0]?.id || "";
  let destroyed = false;
  const favoriteStyles = new Set([...state.favoriteStyleIds, ...(options.favoriteStyleIds || [])]);
  state.favoriteStyleIds = [...favoriteStyles];

  const root = createElement("section", "cc-root");
  root.setAttribute("aria-label", "集合控制台");
  root.innerHTML = `
    <header class="cc-toolbar">
      <div class="cc-brand"><span class="cc-brand-mark" aria-hidden="true"><svg viewBox="0 0 28 28"><path d="M4 22 11 12l4 5 3-4 6 9H4Z"></path><path d="M6 8h16M8 5h12"></path></svg></span><strong>集合控制台</strong></div>
      <nav class="cc-toolbar-actions" aria-label="节点设置">
        <button class="cc-tool-button" type="button" data-action="open-panel" data-panel="resolution"><span>分辨率</span><strong data-summary="resolution">1024 × 1024</strong></button>
        <button class="cc-tool-button cc-tool-primary" type="button" data-action="open-panel" data-panel="model"><span>管理模型</span><strong data-summary="model">Krea 2</strong></button>
        <button class="cc-tool-button" type="button" data-action="open-panel" data-panel="styles"><span>选择风格</span><strong data-summary="styles">未选择</strong></button>
        <button class="cc-tool-button" type="button" data-action="open-panel" data-panel="prompts"><span>提示词预设</span><strong data-summary="prompts">未选择</strong></button>
        <button class="cc-tool-button" type="button" data-action="open-panel" data-panel="sampler"><span>K 采样器</span><strong data-summary="sampler">20 步 · CFG 8</strong></button>
      </nav>
    </header>

    <div class="cc-workspace">
      <section class="cc-controls" aria-label="生成控制">
        <div class="cc-prompt-pair">
          <section class="cc-prompt-editor">
            <div class="cc-prompt-header"><label for="cc-positive-prompt-${instanceId}">正面提示词</label><div class="cc-prompt-actions"><button type="button" data-action="prompt-copy" data-prompt="positive">复制</button><button type="button" data-action="prompt-paste" data-prompt="positive">粘贴</button><button type="button" data-action="prompt-clear" data-prompt="positive">清空</button></div></div>
            <textarea id="cc-positive-prompt-${instanceId}" data-prompt-field="positive" placeholder="描述你想生成的画面"></textarea>
          </section>
          <section class="cc-prompt-editor">
            <div class="cc-prompt-header"><label for="cc-negative-prompt-${instanceId}">负面提示词</label><div class="cc-prompt-actions"><button type="button" data-action="prompt-copy" data-prompt="negative">复制</button><button type="button" data-action="prompt-paste" data-prompt="negative">粘贴</button><button type="button" data-action="prompt-clear" data-prompt="negative">清空</button></div></div>
            <textarea id="cc-negative-prompt-${instanceId}" data-prompt-field="negative" placeholder="填写希望避免的内容"></textarea>
          </section>
        </div>

        <section class="cc-image-editor" aria-label="图像编辑">
          <div class="cc-editor-header">
            <button class="cc-editor-title" type="button" data-action="open-gallery" aria-haspopup="dialog">
              <span class="cc-editor-title-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 18 9.5 9l3.3 5 2.2-3 5 7H4Z"></path><path d="M5 5h14"></path></svg></span>
              <span class="cc-editor-title-copy"><strong>图像编辑</strong><small>进入相册 · 管理与选择图片</small></span>
              <span class="cc-editor-title-open">打开相册</span>
            </button>
            <div class="cc-editor-actions">
              <button class="cc-small-button" type="button" data-action="choose-image">导入图片</button>
              <button class="cc-small-button" type="button" data-action="image-clear" disabled>移除图片</button>
              <button class="cc-small-button cc-brush-button" type="button" data-action="mask-toggle" aria-haspopup="dialog" disabled>遮罩</button>
              <button class="cc-small-button" type="button" data-action="mask-clear" disabled>清除遮罩</button>
            </div>
          </div>
          <div class="cc-image-stage" data-image-stage tabindex="0" aria-label="待编辑图片，可拖入图片">
            <div class="cc-image-empty" data-image-empty><span class="cc-image-icon"></span><strong>拖入图片，或打开相册选择</strong><span>可在相册中创建文件夹并整理图片</span></div>
          </div>
          <p class="cc-image-status" data-image-status aria-live="polite">选择图片或拖入图片；没有遮罩时按整张图片编辑。</p>
          <input class="cc-file-input" data-image-file type="file" accept="image/png,image/jpeg,image/webp" hidden>
          <p class="cc-model-note" data-model-note hidden></p>
        </section>

        <div class="cc-cover-pair">
          <div class="cc-cover-card">
            <span class="cc-cover-heading">模型预设封面</span>
            <span class="cc-cover-image" data-cover="model"><span class="cc-cover-placeholder">模型封面</span></span>
            <strong data-cover-name="model">Krea 2</strong>
          </div>
          <div class="cc-cover-card">
            <span class="cc-cover-heading">风格参考封面</span>
            <span class="cc-cover-image" data-cover="style"><span class="cc-cover-placeholder">风格封面</span></span>
            <strong data-cover-name="style">尚未选择</strong>
          </div>
        </div>

      </section>

      <section class="cc-preview-panel" aria-label="采样结果预览">
        <div class="cc-preview-heading"><h2>采样结果预览</h2><span>节点内部预览</span></div>
        <div class="cc-preview-stage" data-preview-stage="sample"><div class="cc-preview-empty" data-preview-empty="sample"><span class="cc-image-icon"></span><strong>等待采样结果</strong><span>运行工作流后显示</span></div></div>
        <p class="cc-preview-resolution" data-preview-resolution="sample">分辨率：1024 × 1024</p>
      </section>

      <section class="cc-preview-panel" aria-label="最终图像预览">
        <div class="cc-preview-heading"><h2>最终图像预览</h2><span>图像输出</span></div>
        <div class="cc-preview-stage" data-preview-stage="final"><div class="cc-preview-empty" data-preview-empty="final"><span class="cc-image-icon"></span><strong>等待最终图像</strong><span>图像由节点输出</span></div></div>
        <p class="cc-preview-resolution" data-preview-resolution="final">分辨率：1024 × 1024</p>
      </section>
    </div>
    <div class="cc-status" data-status role="status" aria-live="polite"></div>
  `;

  const dialog = createElement("dialog", "cc-dialog");
  dialog.setAttribute("aria-labelledby", `cc-dialog-title-${instanceId}`);
  dialog.innerHTML = `
    <div class="cc-dialog-shell">
      <header class="cc-dialog-header"><div><h2 id="cc-dialog-title-${instanceId}" data-panel-title></h2><p data-panel-description></p></div><button type="button" class="cc-dialog-close" data-action="close-dialog" aria-label="关闭"></button></header>
      <div class="cc-dialog-body" data-panel-body></div>
      <footer class="cc-dialog-footer"><span data-panel-status role="status" aria-live="polite"></span><div><button type="button" class="cc-button" data-action="close-dialog">取消</button><button type="button" class="cc-button cc-button-primary" data-action="apply-panel">应用</button></div></footer>
    </div>
  `;
  container.append(root);
  document.body.append(dialog);

  const statusNode = root.querySelector("[data-status]");
  const dialogBody = dialog.querySelector("[data-panel-body]");
  const dialogStatus = dialog.querySelector("[data-panel-status]");
  const imageStage = root.querySelector("[data-image-stage]");
  let editImage = null;
  const previewImages = new Map();
  const imageEmpty = root.querySelector("[data-image-empty]");
  const brushRange = root.querySelector("[data-brush-size]");
  const managedStylesCleanup = [];
  const focusedQueries = new Set(["style", "prompts", "model", "gallery"]);
  const signal = abortController.signal;

  function displayStatus(message, isError = false) {
    statusNode.textContent = message;
    statusNode.classList.toggle("cc-status-error", isError);
  }

  function emitAction(type, detail = {}) {
    return safeCall(options.onAction, { type, detail, state: cloneState(state) }, (message) => displayStatus(`回调出错：${message}`, true));
  }

  function publishState(type, detail = {}) {
    try {
      options.onStateChange?.(cloneState(state), { type, detail });
    } catch (error) {
      displayStatus(`状态回调出错：${error instanceof Error ? error.message : String(error)}`, true);
    }
    return emitAction(type, detail);
  }

  function setPrompt(fieldName, value, actionType = "prompt.change") {
    const key = fieldName === "negative" ? "negativePrompt" : "positivePrompt";
    state[key] = value;
    publishState(actionType, { field: fieldName, value });
  }

  function updateCover(coverNode, source, label) {
    const currentImage = coverNode.querySelector("img");
    if (source && currentImage?.dataset.source === source) return;
    if (!source && coverNode.firstElementChild?.textContent === label) return;
    coverNode.replaceChildren();
    if (source) {
      const image = createElement("img", "cc-cover-photo");
      image.alt = label;
      image.dataset.source = source;
      image.src = source;
      coverNode.append(image);
      return;
    }
    const placeholder = createElement("span", "cc-cover-placeholder", label);
    coverNode.append(placeholder);
  }

  function renderMain() {
    const selectedModel = findModel(catalog, state.model);
    const chosenStyles = catalog.styles.filter((style) => state.selectedStyleIds.includes(style.id));
    const firstStyle = chosenStyles[0];
    root.querySelector('[data-summary="resolution"]').textContent = formatResolution(state.resolution);
    root.querySelector('[data-summary="model"]').textContent = selectedModel?.name || "未选择";
    root.querySelector('[data-summary="styles"]').textContent = chosenStyles.length ? `${chosenStyles.length} 项已选` : "未选择";
    root.querySelector('[data-summary="prompts"]').textContent = state.selectedPromptPreset
      ? state.promptPresets.find((preset) => preset.id === state.selectedPromptPreset)?.name || "已选择"
      : "未选择";
    root.querySelector('[data-summary="sampler"]').textContent = `${state.sampler.steps} 步 · CFG ${state.sampler.cfg}`;
    root.querySelector('[data-cover-name="model"]').textContent = selectedModel?.name || "尚未选择";
    root.querySelector('[data-cover-name="style"]').textContent = firstStyle?.name || "尚未选择";
    updateCover(root.querySelector('[data-cover="model"]'), selectedModel?.cover, selectedModel?.name || "模型封面");
    updateCover(root.querySelector('[data-cover="style"]'), firstStyle?.image, firstStyle?.name || "风格封面");
    const positivePrompt = root.querySelector('[data-prompt-field="positive"]');
    const negativePrompt = root.querySelector('[data-prompt-field="negative"]');
    if (document.activeElement !== positivePrompt) positivePrompt.value = state.positivePrompt;
    if (document.activeElement !== negativePrompt) negativePrompt.value = state.negativePrompt;

    const hasImage = Boolean(state.editImage.src);
    const hasMask = Boolean(state.editImage.hasMask || state.editImage.maskStrokes.length);
    const capabilities = resolveModelCapabilities(selectedModel || state.model);
    const maskButton = root.querySelector('[data-action="mask-toggle"]');
    const clearMaskButton = root.querySelector('[data-action="mask-clear"]');
    const clearImageButton = root.querySelector('[data-action="image-clear"]');
    if (hasImage && !editImage) {
      editImage = createElement("img", "cc-edit-image");
      editImage.alt = "待编辑图片";
      editImage.dataset.editImage = "true";
      editImage.addEventListener("load", handleImageLoad, { signal });
      imageStage.insertBefore(editImage, imageEmpty);
    } else if (!hasImage && editImage) {
      editImage.remove();
      editImage = null;
    }
    imageEmpty.hidden = hasImage;
    if (hasImage && editImage.dataset.source !== state.editImage.src) {
      editImage.dataset.source = state.editImage.src;
      editImage.src = state.editImage.src;
    }
    maskButton.disabled = !hasImage;
    clearMaskButton.disabled = !hasImage || !hasMask;
    clearImageButton.disabled = !hasImage;
    maskButton.textContent = hasMask ? "遮罩 · 已设置" : "遮罩";
    const imageName = state.editImage.name || "待编辑图片";
    root.querySelector("[data-image-status]").textContent = hasImage
      ? `${imageName} · ${hasMask ? "已设置遮罩" : "整图编辑"}`
      : "选择图片或拖入图片；没有遮罩时按整张图片编辑。";
    imageStage.classList.toggle("cc-stage-dragging", imageStage.dataset.dragging === "true");
    const modelNote = root.querySelector("[data-model-note]");
    const hasIgnoredInputs = hasImage;
    modelNote.hidden = capabilities.imageEditing || !hasIgnoredInputs;
    modelNote.textContent = capabilities.imageEditing
      ? ""
      : "当前模型不支持图像编辑；待编辑图片与遮罩不会参与生成。";

    for (const kind of ["sample", "final"]) {
      const previewStage = root.querySelector(`[data-preview-stage="${kind}"]`);
      const emptyNode = root.querySelector(`[data-preview-empty="${kind}"]`);
      const resolutionLabel = root.querySelector(`[data-preview-resolution="${kind}"]`);
      const source = state.previews[kind];
      let previewImage = previewImages.get(kind);
      if (source && !previewImage) {
        previewImage = createElement("img", "cc-preview-image");
        previewImage.alt = kind === "sample" ? "采样结果" : "最终图像";
        previewImage.addEventListener("load", () => updatePreviewResolution(kind), { signal });
        previewImages.set(kind, previewImage);
        previewStage.insertBefore(previewImage, emptyNode);
      } else if (!source && previewImage) {
        previewImage.remove();
        previewImages.delete(kind);
        previewImage = null;
      }
      emptyNode.hidden = Boolean(source);
      if (source && previewImage.dataset.source !== source) {
        previewImage.dataset.source = source;
        previewImage.src = source;
      }
      const target = previewTargetResolution(state);
      const width = previewImage?.naturalWidth || Number(target.width);
      const height = previewImage?.naturalHeight || Number(target.height);
      resolutionLabel.textContent = `分辨率：${width} × ${height}`;
    }
    syncStageSizing();
  }

  function updatePreviewResolution(kind) {
    const image = previewImages.get(kind);
    const label = root.querySelector(`[data-preview-resolution="${kind}"]`);
    if (!image || !label) return;
    const target = previewTargetResolution(state);
    const width = image.naturalWidth || Number(target.width);
    const height = image.naturalHeight || Number(target.height);
    label.textContent = `分辨率：${width} × ${height}`;
  }

  function reportError(message) {
    displayStatus(message, true);
    if (activePanel) dialogStatus.textContent = message;
  }

  function updateImageFromItem(image, sourceAction, file = null, { publish = true, replaceId = "" } = {}) {
    const editingGallery = activePanel === "gallery" && draft;
    const target = editingGallery ? draft : state;
    const uncategorized = target.imageFolders.find((folder) => folder.name === "未分类") || target.imageFolders[0];
    const folderId = editingGallery
      ? (selectedFolderId === "all" ? uncategorized?.id : selectedFolderId) || uncategorized?.id || ""
      : state.editImage.folderId || uncategorized?.id || "";
    const folder = target.imageFolders.find((item) => item.id === folderId) || uncategorized;
    const newImage = {
      id: String(image.id || `image-${Date.now()}-${++imageImportSequence}`),
      src: String(image.src || image.url || ""),
      name: String(image.name || "待编辑图片"),
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      category: folder?.name || "未分类",
      folderId: folder?.id || "",
      hasMask: Boolean(image.has_mask),
      maskDataUrl: "",
      maskStrokes: [],
    };
    if (!newImage.src) return reportError("图片地址为空，请重新选择图片。");
    const library = target.imageLibrary.filter((entry) => entry.id !== newImage.id && entry.id !== replaceId);
    const detail = { image: cloneState(newImage), source: sourceAction };
    if (file) detail.file = file;
    if (editingGallery) {
      draft.imageLibrary = [newImage, ...library];
      if (folder && !folder.coverImageId) {
        draft.imageFolders = updateGalleryFolder(draft.imageFolders, folder.id, { coverImageId: newImage.id });
      }
      renderDialogFromChange();
      dialogStatus.textContent = `已加入「${folder?.name || "未分类"}」相册：${newImage.name}`;
      if (publish && sourceAction) emitAction(sourceAction, detail);
      return newImage;
    }
    state = mergeState(state, {
      editImage: newImage,
      imageLibrary: [newImage, ...library],
    });
    renderMain();
    if (publish && sourceAction) {
      const result = publishState(sourceAction, detail);
      displayStatus(`正在选择图片：${newImage.name}`);
      return result;
    }
    displayStatus(`已选择图片：${newImage.name}`);
    return newImage;
  }

  function isLocalImage(image) {
    return String(image?.id || "").startsWith("local-")
      || String(image?.src || "").startsWith("blob:");
  }

  function sourceIsReferenced(source) {
    return [state, draft].some((candidate) => candidate && (
      candidate.editImage?.src === source
      || candidate.imageLibrary?.some((image) => image.src === source)
    ));
  }

  function serverImageFallback(previousImageState) {
    if (previousImageState.editImage.src && !isLocalImage(previousImageState.editImage)) {
      return cloneState(previousImageState.editImage);
    }
    const image = previousImageState.imageLibrary.find((entry) => entry.src && !isLocalImage(entry));
    return image ? cloneState(image) : cloneState(createInitialState().editImage);
  }

  function rollbackImageUpload(localId, source, previousImageState) {
    const withoutFailedImage = (images) => images.filter((image) => image.id !== localId && image.src !== source);
    const fallback = serverImageFallback(previousImageState);
    const selectedFailedImage = state.editImage.id === localId || state.editImage.src === source;
    const library = withoutFailedImage(state.imageLibrary);
    if (selectedFailedImage && fallback.src && !library.some((image) => image.id === fallback.id)) {
      library.unshift(cloneState(fallback));
    }
    state = mergeState(state, {
      ...(selectedFailedImage ? { editImage: fallback } : {}),
      imageLibrary: library,
    });
    if (draft) {
      const draftLibrary = withoutFailedImage(draft.imageLibrary);
      draft.imageLibrary = draftLibrary;
      if (draft.editImage.id === localId || draft.editImage.src === source) {
        draft.editImage = cloneState(fallback);
        if (fallback.src && !draftLibrary.some((image) => image.id === fallback.id)) {
          draftLibrary.unshift(cloneState(fallback));
        }
      }
    }
    renderMain();
  }

  function acceptImageFile(file, actionType, { galleryBatch = false } = {}) {
    if (!isSupportedImageFile(file)) return reportError("仅支持 PNG、JPEG、WebP 图片。");
    const galleryDraft = galleryBatch ? draft : null;
    const selection = galleryBatch ? 0 : ++pendingImageSelection;
    const stillRelevant = () => !destroyed && (galleryBatch
      ? activePanel === "gallery" && draft === galleryDraft
      : selection === pendingImageSelection);
    const source = URL.createObjectURL(file);
    objectUrls.add(source);
    const probe = new Image();
    probe.onload = async () => {
      if (!stillRelevant()) {
        objectUrls.delete(source);
        URL.revokeObjectURL(source);
        return;
      }
      const previousImageState = {
        editImage: cloneState(state.editImage),
        imageLibrary: cloneState(state.imageLibrary),
      };
      const localId = `local-${Date.now()}-${++imageImportSequence}`;
      try {
        const uploadResult = updateImageFromItem({
          id: localId,
          src: source,
          name: file.name,
          width: probe.naturalWidth,
          height: probe.naturalHeight,
          category: "未分类",
        }, actionType, file);
        const serverImage = await uploadResult;
        if (!stillRelevant()) return;
        if (serverImage && typeof serverImage === "object" && serverImage.id) {
          const currentImage = state.editImage;
          const serverSrc = String(serverImage.src || serverImage.url || "");
          if (serverSrc || String(currentImage.id) === String(serverImage.id)) {
            updateImageFromItem(
              { ...serverImage, src: serverSrc || currentImage.src },
              "",
              null,
              { publish: false, replaceId: localId },
            );
          }
        }
      } catch (error) {
        rollbackImageUpload(localId, source, previousImageState);
        if (stillRelevant()) reportError(uploadErrorMessage(error));
      } finally {
        if (!sourceIsReferenced(source)) {
          objectUrls.delete(source);
          URL.revokeObjectURL(source);
        }
      }
    };
    probe.onerror = () => {
      URL.revokeObjectURL(source);
      objectUrls.delete(source);
      if (stillRelevant()) reportError("图片无法读取，请换一张 PNG、JPEG 或 WebP 图片。");
    };
    probe.src = source;
  }

  function clearSelectedImage() {
    pendingImageSelection += 1;
    state = mergeState(state, {
      editImage: { id: "", src: "", name: "", width: 0, height: 0, category: "", hasMask: false, maskDataUrl: "", maskStrokes: [] },
    });
    renderMain();
    publishState("editImage.clear", {});
    displayStatus("待编辑图片已移除。");
  }

  function syncStageSizing() {
    const imageWidth = Number(state.editImage.width);
    const imageHeight = Number(state.editImage.height);
    if (!imageWidth || !imageHeight) {
      imageStage.style.removeProperty("--cc-stage-max-width");
      imageStage.style.removeProperty("--cc-image-ratio");
      return;
    }
    const ratio = imageWidth / imageHeight;
    const parentWidth = imageStage.parentElement.getBoundingClientRect().width;
    const maxWidth = Math.min(parentWidth, 280 * ratio);
    imageStage.style.setProperty("--cc-image-ratio", String(ratio));
    imageStage.style.setProperty("--cc-stage-max-width", `${maxWidth}px`);
  }

  function requestPanel(panelName) {
    const normalizedPanel = panelName === "images" || panelName === "categories" ? "gallery" : panelName;
    try {
      if (options.onPanelRequest?.(normalizedPanel, cloneState(state)) === true) {
        emitAction("panel.open", { panel: normalizedPanel, delegated: true });
        return;
      }
    } catch (error) {
      displayStatus(`无法打开设置：${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    openPanel(normalizedPanel);
  }

  function openPanel(panelName) {
    const normalizedPanel = panelName === "images" || panelName === "categories" ? "gallery" : panelName;
    if (!PANEL_TITLES[normalizedPanel]) return;
    if (activePanel) emitAction("panel.close", { panel: activePanel, replacedBy: panelName });
    activePanel = normalizedPanel;
    dialog.classList.toggle("cc-dialog-gallery", normalizedPanel === "gallery");
    draft = cloneState(state);
    modelTab = "models";
    styleFilter = "全部";
    styleSearch = "";
    styleFavoritesOnly = false;
    modelSearch = "";
    promptSearch = "";
    promptFilter = "全部";
    gallerySearch = "";
    gallerySelectionMade = false;
    selectedFolderId = draft.editImage.folderId && draft.imageFolders.some((folder) => folder.id === draft.editImage.folderId)
      ? draft.editImage.folderId
      : (draft.imageFolders.find((folder) => folder.name === "未分类") || draft.imageFolders[0])?.id || "all";
    selectedPresetId = draft.selectedPromptPreset || draft.promptPresets[0]?.id || "";
    dialog.querySelector("[data-panel-title]").textContent = PANEL_TITLES[normalizedPanel][0];
    dialog.querySelector("[data-panel-description]").textContent = PANEL_TITLES[normalizedPanel][1];
    dialogStatus.textContent = "";
    dialog.querySelector('[data-action="apply-panel"]').textContent = normalizedPanel === "prompts" ? "保存并关闭" : "应用";
    renderPanelBody();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("[data-action='close-dialog']")?.focus();
    emitAction("panel.open", { panel: normalizedPanel });
  }

  function closePanel() {
    if (dialog.open) dialog.close();
  }

  function createPanelSection(title, description = "") {
    const section = createElement("section", "cc-panel-section");
    const header = createElement("div", "cc-panel-section-heading");
    header.append(createElement("h3", "", title));
    if (description) header.append(createElement("p", "", description));
    section.append(header);
    return section;
  }

  function createFilterButtons(items, active, action, key = "filter") {
    const group = createElement("div", "cc-filter-list");
    for (const item of items) {
      const button = createButton(item, action, `cc-filter-button${item === active ? " cc-selected" : ""}`, { [key]: item });
      button.setAttribute("aria-pressed", String(item === active));
      group.append(button);
    }
    return group;
  }

  function renderResolutionPanel() {
    const layout = createElement("div", "cc-resolution-layout");
    const ratios = createPanelSection("画面比例", "选择比例后，可继续微调宽高。");
    const ratioGrid = createElement("div", "cc-ratio-grid");
    for (const ratio of ASPECT_RATIOS) {
      const button = createButton(ratio, "select-ratio", `cc-ratio-button${draft.resolution.ratio === ratio ? " cc-selected" : ""}`, { ratio });
      button.setAttribute("aria-pressed", String(draft.resolution.ratio === ratio));
      button.append(createElement("span", "cc-ratio-shape", ""));
      ratioGrid.append(button);
    }
    ratios.append(ratioGrid);
    const common = createPanelSection("常用尺寸", "按常见画幅比例准备的起始分辨率。");
    const presetGrid = createElement("div", "cc-resolution-presets");
    for (const preset of RESOLUTION_PRESETS) {
      const isSelected = preset.width === draft.resolution.width && preset.height === draft.resolution.height;
      const button = createButton("", "select-resolution", `cc-resolution-preset${isSelected ? " cc-selected" : ""}`, {
        width: String(preset.width), height: String(preset.height), ratio: preset.ratio,
      });
      button.append(createElement("strong", "", `${preset.width} × ${preset.height}`));
      button.append(createElement("span", "", `${preset.ratio} · ${preset.label}`));
      presetGrid.append(button);
    }
    common.append(presetGrid);
    const custom = createPanelSection("自定义尺寸");
    const fields = createElement("div", "cc-dimension-fields");
    const widthInput = createTextInput(draft.resolution.width, { type: "number", min: "64", max: "8192", step: "8", inputmode: "numeric", "data-draft": "resolution.width", "aria-label": "图像宽度" });
    const heightInput = createTextInput(draft.resolution.height, { type: "number", min: "64", max: "8192", step: "8", inputmode: "numeric", "data-draft": "resolution.height", "aria-label": "图像高度" });
    fields.append(createField("宽度（px）", widthInput), createElement("span", "cc-dimension-times", "×"), createField("高度（px）", heightInput));
    custom.append(fields, createElement("p", "cc-help-text", "应用时按 8 像素取整，适配常见潜空间尺寸。"));
    layout.append(ratios, common, custom);
    return layout;
  }

  function renderModelPanel() {
    const layout = createElement("div", "cc-model-layout");
    const navigation = createElement("nav", "cc-panel-tabs");
    navigation.setAttribute("aria-label", "模型组件类型");
    const tabs = [
      ["models", "模型"], ["clips", "CLIP"], ["vaes", "VAE"], ["loras", "LoRA"],
    ];
    for (const [tab, label] of tabs) {
      const button = createButton(label, "model-tab", `cc-panel-tab${modelTab === tab ? " cc-selected" : ""}`, { tab });
      button.setAttribute("aria-current", String(modelTab === tab));
      navigation.append(button);
    }
    const content = createElement("div", "cc-model-content");
    const heading = createElement("div", "cc-panel-toolbar");
    const titles = { models: "基础模型", clips: "CLIP 编码器", vaes: "VAE 解码器", loras: "LoRA" };
    heading.append(createElement("h3", "", titles[modelTab]));
    const search = createTextInput(modelSearch, { type: "search", placeholder: "搜索名称", "data-search": "model", "aria-label": "搜索模型资源" });
    search.classList.add("cc-search-input");
    heading.append(search);
    content.append(heading);
    const selected = createElement("div", "cc-selection-summary");
    if (modelTab === "models") selected.textContent = `当前模型：${findModel(catalog, draft.model)?.name || "未选择"}`;
    if (modelTab === "clips") selected.textContent = `已选 ${draft.clip.length} / 4 个 CLIP`;
    if (modelTab === "vaes") selected.textContent = `当前 VAE：${catalog.vaes.find((item) => item.id === draft.vae)?.name || draft.vae}`;
    if (modelTab === "loras") selected.textContent = `已选 ${draft.loras.length} 个 LoRA`;
    content.append(selected);
    const items = catalog[modelTab].filter((item) => `${item.name} ${item.category || ""}`.toLowerCase().includes(modelSearch.toLowerCase()));
    const list = createElement("div", "cc-resource-list");
    if (!items.length) list.append(createElement("div", "cc-empty-state", "没有找到匹配资源。"));
    for (const item of items) {
      const isSelected = modelTab === "models" ? draft.model.id === item.id
        : modelTab === "clips" ? draft.clip.includes(item.id)
          : modelTab === "vaes" ? draft.vae === item.id
            : draft.loras.some((lora) => (typeof lora === "string" ? lora : lora.id) === item.id);
      const row = createButton("", "select-model-resource", `cc-resource-row${isSelected ? " cc-selected" : ""}`, { id: item.id, tab: modelTab });
      const marker = createElement("span", `cc-resource-marker${isSelected ? " cc-resource-is-selected" : ""}`);
      const nameBlock = createElement("span", "cc-resource-name");
      nameBlock.append(createElement("strong", "", item.name));
      if (item.category) nameBlock.append(createElement("small", "", item.category));
      row.append(nameBlock, marker);
      list.append(row);
    }
    content.append(list);
    const footerNote = createElement("p", "cc-help-text", modelTab === "models"
      ? "选择模型会自动识别图像编辑能力；不支持时，编辑图和遮罩不会参与生成。"
      : modelTab === "clips" ? "可按顺序选择最多四个 CLIP 编码器。" : "选择仅保存在当前节点状态中。跳过后端加载。 ");
    content.append(footerNote);
    layout.append(navigation, content);
    return layout;
  }

  function renderStylesPanel() {
    const panel = createElement("div", "cc-styles-panel");
    const toolbar = createElement("div", "cc-panel-toolbar");
    const search = createTextInput(styleSearch, { type: "search", placeholder: "搜索风格", "data-search": "style", "aria-label": "搜索风格" });
    search.classList.add("cc-search-input");
    const selectedCount = createElement("span", "cc-selection-summary", `${draft.selectedStyleIds.length} / 3 已选`);
    toolbar.append(search, selectedCount, createButton(styleFavoritesOnly ? "显示全部" : "只看收藏", "style-favorites"));
    panel.append(toolbar);
    const categories = ["全部", ...new Set(catalog.styles.map((style) => style.category).filter(Boolean))];
    if (!categories.includes(styleFilter)) styleFilter = "全部";
    panel.append(createFilterButtons(categories, styleFilter, "style-category", "category"));
    const grid = createElement("div", "cc-style-grid");
    const styles = catalog.styles.filter((style) => {
      const matchesSearch = `${style.name} ${style.category || ""}`.toLowerCase().includes(styleSearch.toLowerCase());
      const matchesCategory = styleFilter === "全部" || style.category === styleFilter;
      const matchesFavorite = !styleFavoritesOnly || favoriteStyles.has(style.id);
      return matchesSearch && matchesCategory && matchesFavorite;
    });
    for (const style of styles) {
      const selected = draft.selectedStyleIds.includes(style.id);
      const card = createElement("article", `cc-style-card${selected ? " cc-selected" : ""}`);
      const selectButton = createButton("", "toggle-style", "cc-style-select", { id: style.id });
      selectButton.setAttribute("aria-pressed", String(selected));
      const cover = createElement("span", "cc-style-cover");
      if (style.image) {
        const image = createElement("img", "cc-style-photo");
        image.src = style.image;
        image.alt = "";
        cover.append(image);
      } else {
        cover.append(createPhotoIcon(), createElement("span", "", "封面待接入"));
      }
      const info = createElement("span", "cc-style-info");
      info.append(createElement("strong", "", style.name), createElement("small", "", style.category || "未分类"));
      const favorite = createButton(favoriteStyles.has(style.id) ? "已收藏" : "收藏", "style-favorite-one", "cc-favorite-button", { id: style.id });
      favorite.setAttribute("aria-label", favoriteStyles.has(style.id) ? `取消收藏 ${style.name}` : `收藏 ${style.name}`);
      favorite.setAttribute("aria-pressed", String(favoriteStyles.has(style.id)));
      selectButton.append(cover, info);
      card.append(selectButton, favorite);
      grid.append(card);
    }
    if (!styles.length) grid.append(createElement("div", "cc-empty-state", "没有找到风格。"));
    panel.append(grid);
    panel.append(createElement("p", "cc-help-text", "选择的第一种风格作为封面参考；其余风格作为提示词预设。"));
    return panel;
  }

  function renderPromptPanel() {
    const panel = createElement("div", "cc-prompt-manager");
    const aside = createElement("aside", "cc-preset-sidebar");
    const sidebarHeader = createElement("div", "cc-preset-sidebar-header");
    sidebarHeader.append(createElement("h3", "", "预设列表"), createButton("新建", "preset-new", "cc-button cc-button-primary"));
    const search = createTextInput(promptSearch, { type: "search", placeholder: "搜索预设", "data-search": "prompt", "aria-label": "搜索提示词预设" });
    search.classList.add("cc-search-input");
    aside.append(sidebarHeader, search);
    const categories = ["全部", ...new Set(draft.promptPresets.map((preset) => preset.category).filter(Boolean))];
    aside.append(createFilterButtons(categories, promptFilter, "prompt-category", "category"));
    const list = createElement("div", "cc-preset-list");
    const presets = draft.promptPresets.filter((preset) => {
      const matchesSearch = `${preset.name} ${preset.category || ""}`.toLowerCase().includes(promptSearch.toLowerCase());
      const matchesCategory = promptFilter === "全部" || preset.category === promptFilter;
      return matchesSearch && matchesCategory;
    });
    for (const preset of presets) {
      const button = createButton("", "select-preset", `cc-preset-list-item${selectedPresetId === preset.id ? " cc-selected" : ""}`, { id: preset.id });
      button.append(createElement("strong", "", preset.name), createElement("small", "", preset.category || "未分类"));
      if (!preset.enabled) button.append(createElement("small", "cc-preset-disabled", "未启用"));
      list.append(button);
    }
    if (!presets.length) list.append(createElement("div", "cc-empty-state", "没有找到提示词预设。"));
    aside.append(list);
    const detail = createElement("section", "cc-preset-detail");
    const activePreset = draft.promptPresets.find((preset) => preset.id === selectedPresetId);
    if (!activePreset) {
      detail.append(createElement("div", "cc-empty-state", "选择一个预设，或新建预设。"));
    } else {
      const titleRow = createElement("div", "cc-panel-toolbar");
      titleRow.append(createElement("h3", "", "预设内容"));
      const enabledLabel = createElement("label", "cc-toggle-label");
      const enabled = createElement("input", "");
      enabled.type = "checkbox";
      enabled.checked = activePreset.enabled !== false;
      enabled.dataset.presetField = "enabled";
      enabled.setAttribute("aria-label", "启用该预设");
      enabledLabel.append(enabled, createElement("span", "", "启用"));
      titleRow.append(enabledLabel);
      detail.append(titleRow);
      const name = createTextInput(activePreset.name, { "data-preset-field": "name", "aria-label": "预设名称" });
      const category = createTextInput(activePreset.category || "自定义", { "data-preset-field": "category", "aria-label": "预设分类" });
      detail.append(createField("名称", name), createField("分类", category));
      const positive = createElement("textarea", "cc-textarea");
      positive.value = activePreset.positive || "";
      positive.dataset.presetField = "positive";
      positive.setAttribute("aria-label", "预设正面提示词");
      const negative = createElement("textarea", "cc-textarea");
      negative.value = activePreset.negative || "";
      negative.dataset.presetField = "negative";
      negative.setAttribute("aria-label", "预设负面提示词");
      detail.append(createField("正面提示词", positive, "cc-field-stacked"), createField("负面提示词", negative, "cc-field-stacked"));
      const actions = createElement("div", "cc-preset-actions");
      const applyPreset = createButton("应用到提示词", "apply-preset-to-prompts", "cc-button cc-button-primary", { id: activePreset.id });
      applyPreset.disabled = activePreset.enabled === false;
      actions.append(
        applyPreset,
        createButton("复制", "preset-copy", "cc-button", { id: activePreset.id }),
        createButton("删除", "preset-delete", "cc-button cc-button-danger", { id: activePreset.id }),
      );
      detail.append(actions);
    }
    panel.append(aside, detail);
    return panel;
  }

  function renderSamplerPanel() {
    const panel = createElement("div", "cc-sampler-panel");
    const seed = createTextInput(draft.sampler.seed, { type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "16", "data-draft": "sampler.seed", "aria-label": "种子" });
    const steps = createTextInput(draft.sampler.steps, { type: "number", min: "1", max: "10000", step: "1", "data-draft": "sampler.steps", "aria-label": "采样步数" });
    const cfg = createTextInput(draft.sampler.cfg, { type: "number", min: "0", max: "100", step: "0.1", "data-draft": "sampler.cfg", "aria-label": "CFG 引导" });
    const denoise = createTextInput(draft.sampler.denoise, { type: "number", min: "0", max: "1", step: "0.01", "data-draft": "sampler.denoise", "aria-label": "去噪强度" });
    const sampler = createSelect(samplerOptions, draft.sampler.sampler);
    sampler.dataset.draft = "sampler.sampler";
    sampler.setAttribute("aria-label", "采样器");
    const scheduler = createSelect(schedulerOptions, draft.sampler.scheduler);
    scheduler.dataset.draft = "sampler.scheduler";
    scheduler.setAttribute("aria-label", "调度器");
    const controlAfterGenerate = createSelect([{id:"fixed",name:"固定"},{id:"randomize",name:"随机"}], draft.sampler.controlAfterGenerate);
    controlAfterGenerate.dataset.draft = "sampler.controlAfterGenerate";
    controlAfterGenerate.setAttribute("aria-label", "生成后控制");
    const fields = createElement("div", "cc-sampler-grid");
    fields.append(
      createField("随机种子", seed), createField("采样步数", steps),
      createField("CFG 引导", cfg), createField("去噪强度", denoise),
      createField("采样器", sampler), createField("调度器", scheduler),
      createField("生成后控制", controlAfterGenerate),
    );
    panel.append(fields, createElement("p", "cc-help-text", "随机模式在任务入队后更新下一次种子；固定模式保持种子不变。"));
    return panel;
  }

  function renderGalleryPanel() {
    const panel = createElement("div", "cc-gallery-panel");
    const folders = draft.imageFolders;
    const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
    const allImagesButton = createButton("", "gallery-folder-select", `cc-gallery-folder-row${selectedFolderId === "all" ? " cc-selected" : ""}`, { folderId: "all" });
    allImagesButton.append(createElement("span", "cc-gallery-folder-icon", "全"));
    const allImagesCopy = createElement("span", "cc-gallery-folder-copy");
    allImagesCopy.append(createElement("strong", "", "全部图片"), createElement("small", "", `${draft.imageLibrary.length} 张`));
    allImagesButton.append(allImagesCopy);
    const sidebar = createElement("aside", "cc-gallery-sidebar");
    const sidebarHeader = createElement("div", "cc-gallery-sidebar-header");
    sidebarHeader.append(createElement("h3", "", "我的相册"), createButton("新建", "gallery-folder-new", "cc-gallery-new-folder"));
    const folderList = createElement("nav", "cc-gallery-folder-list");
    folderList.append(allImagesButton);
    for (const folder of folders) {
      const count = draft.imageLibrary.filter((image) => image.folderId === folder.id).length;
      const button = createButton("", "gallery-folder-select", `cc-gallery-folder-row${selectedFolderId === folder.id ? " cc-selected" : ""}`, { folderId: folder.id });
      const cover = createElement("span", "cc-gallery-folder-cover");
      const coverImage = draft.imageLibrary.find((image) => image.id === folder.coverImageId && image.folderId === folder.id);
      if (coverImage?.src) {
        const imageNode = createElement("img", "");
        imageNode.src = coverImage.src;
        imageNode.alt = "";
        cover.append(imageNode);
      } else {
        cover.append(createPhotoIcon());
      }
      const copy = createElement("span", "cc-gallery-folder-copy");
      const name = createElement("strong", "", folder.name);
      name.dataset.folderName = folder.id;
      copy.append(name, createElement("small", "", `${count} 张`));
      button.append(cover, copy);
      folderList.append(button);
    }
    sidebar.append(sidebarHeader, folderList, createElement("p", "cc-gallery-sidebar-note", "导入时会放入当前选中的文件夹。"));

    const main = createElement("section", "cc-gallery-main");
    main.dataset.galleryDrop = "true";
    const toolbar = createElement("div", "cc-gallery-toolbar");
    const titleGroup = createElement("div", "cc-gallery-heading");
    const currentFolderName = createElement("h3", "", selectedFolder?.name || "全部图片");
    currentFolderName.dataset.galleryHeading = "true";
    titleGroup.append(
      currentFolderName,
      createElement("span", "", `${selectedFolder ? draft.imageLibrary.filter((image) => image.folderId === selectedFolder.id).length : draft.imageLibrary.length} 张图片`),
    );
    const actions = createElement("div", "cc-gallery-actions");
    actions.append(createButton("导入图片", "gallery-import", "cc-button cc-button-primary"));
    const galleryFiles = createElement("input", "cc-file-input");
    galleryFiles.type = "file";
    galleryFiles.accept = "image/png,image/jpeg,image/webp";
    galleryFiles.multiple = true;
    galleryFiles.dataset.galleryFiles = "true";
    galleryFiles.hidden = true;
    const search = createTextInput(gallerySearch, { type: "search", placeholder: "搜索图片名称", "data-search": "gallery", "aria-label": "搜索相册图片" });
    search.classList.add("cc-gallery-search");
    toolbar.append(titleGroup, search, actions, galleryFiles);
    main.append(toolbar);

    if (selectedFolder) {
      const folderImages = draft.imageLibrary.filter((image) => image.folderId === selectedFolder.id);
      const details = createElement("section", "cc-gallery-folder-details");
      const detailsHeader = createElement("div", "cc-gallery-details-heading");
      detailsHeader.append(createElement("strong", "", "文件夹资料"), createElement("span", "", "名称、备注和封面会随“应用”保存"));
      const fields = createElement("div", "cc-gallery-folder-fields");
      const nameInput = createTextInput(selectedFolder.name, { "data-folder-field": "name", "aria-label": "文件夹名称", maxlength: "48" });
      const notesInput = createElement("textarea", "cc-textarea");
      notesInput.value = selectedFolder.notes;
      notesInput.dataset.folderField = "notes";
      notesInput.setAttribute("aria-label", "文件夹备注");
      notesInput.placeholder = "写下这本相册的备注";
      notesInput.rows = 2;
      const coverSelect = createSelect(
        [{ id: "", name: "暂无封面" }, ...folderImages.map((image) => ({ id: image.id, name: image.name || "待编辑图片" }))],
        selectedFolder.coverImageId,
        "cc-select",
      );
      coverSelect.dataset.folderField = "coverImageId";
      coverSelect.setAttribute("aria-label", "文件夹封面图片");
      fields.append(createField("文件夹名称", nameInput), createField("备注", notesInput), createField("封面图片", coverSelect));
      details.append(detailsHeader, fields);
      main.append(details);
    } else {
      main.append(createElement("p", "cc-gallery-all-note", "全部图片视图可调整图片所属文件夹；选中一个文件夹即可编辑名称、备注和封面。"));
    }

    const imageList = createElement("div", "cc-gallery-grid");
    const query = gallerySearch.trim().toLocaleLowerCase();
    const visibleImages = draft.imageLibrary.filter((image) => {
      const inFolder = selectedFolderId === "all" || image.folderId === selectedFolderId;
      return inFolder && (!query || image.name.toLocaleLowerCase().includes(query));
    });
    for (const image of visibleImages) {
      const folder = folders.find((item) => item.id === image.folderId);
      const card = createElement("article", `cc-gallery-photo-card${draft.editImage.id === image.id ? " cc-is-active" : ""}`);
      const selectButton = createButton("", "gallery-select-image", "cc-gallery-photo-select", { id: image.id });
      const imageFrame = createElement("span", "cc-gallery-photo-frame");
      if (image.src) {
        const imageNode = createElement("img", "");
        imageNode.src = image.src;
        imageNode.alt = "";
        imageFrame.append(imageNode);
      } else {
        imageFrame.append(createPhotoIcon());
      }
      if (draft.editImage.id === image.id) imageFrame.append(createElement("span", "cc-gallery-active-tag", "当前编辑"));
      const caption = createElement("span", "cc-gallery-photo-caption");
      caption.append(createElement("strong", "", image.name || "待编辑图片"), createElement("small", "", `${image.width || "—"} × ${image.height || "—"}`));
      selectButton.append(imageFrame, caption);
      const folderSelect = createSelect(folders.map((item) => ({ id: item.id, name: item.name })), image.folderId, "cc-select cc-gallery-image-folder");
      folderSelect.dataset.galleryImageFolder = image.id;
      folderSelect.setAttribute("aria-label", `移动${image.name || "图片"}到文件夹`);
      const coverButton = createButton(
        folder?.coverImageId === image.id ? "已设为封面" : "设为封面",
        "gallery-set-cover",
        "cc-gallery-cover-button",
        { id: image.id },
      );
      coverButton.disabled = folder?.coverImageId === image.id;
      card.append(selectButton, folderSelect, coverButton);
      imageList.append(card);
    }
    if (!visibleImages.length) {
      const empty = createElement("div", "cc-gallery-empty");
      empty.append(createPhotoIcon(), createElement("strong", "", query ? "没有找到匹配图片" : "这个文件夹还没有图片"));
      empty.append(createElement("span", "", query ? "换个名称试试。" : "拖入图片，或点击“导入图片”放入当前文件夹。"));
      if (!query) empty.append(createButton("导入图片", "gallery-import", "cc-button cc-button-primary"));
      imageList.append(empty);
    }
    const dropHint = createElement("div", "cc-gallery-drop-hint", "将图片拖到此处，加入当前相册");
    main.append(imageList, dropHint);
    panel.append(sidebar, main);
    return panel;
  }

  function renderPanelBody(searchFocus = false) {
    const focusState = searchFocus ? {
      search: dialogBody.querySelector("[data-search]")?.dataset.search,
      selectionStart: dialogBody.querySelector("[data-search]")?.selectionStart,
      selectionEnd: dialogBody.querySelector("[data-search]")?.selectionEnd,
    } : null;
    const renderers = {
      resolution: renderResolutionPanel,
      model: renderModelPanel,
      styles: renderStylesPanel,
      prompts: renderPromptPanel,
      sampler: renderSamplerPanel,
      gallery: renderGalleryPanel,
      images: renderGalleryPanel,
      categories: renderGalleryPanel,
    };
    dialogBody.replaceChildren(renderers[activePanel]());
    if (focusState?.search) {
      const search = dialogBody.querySelector(`[data-search="${focusState.search}"]`);
      search?.focus();
      if (Number.isInteger(focusState.selectionStart)) search?.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    }
  }

  function normalizeDraft() {
    const normalized = cloneState(draft);
    const rawWidth = Number(normalized.resolution.width);
    const rawHeight = Number(normalized.resolution.height);
    normalized.resolution.width = Math.max(64, Math.min(8192, Math.round((Number.isFinite(rawWidth) ? rawWidth : 1024) / 8) * 8));
    normalized.resolution.height = Math.max(64, Math.min(8192, Math.round((Number.isFinite(rawHeight) ? rawHeight : 1024) / 8) * 8));
    normalized.resolution.ratio = chooseRatio(normalized.resolution.width, normalized.resolution.height);
    const maxSeed = 9007199254740991n;
    let seed = String(normalized.sampler.seed).replace(/\D/g, "").replace(/^0+(?=\d)/, "") || "0";
    try {
      if (BigInt(seed) > maxSeed) seed = maxSeed.toString();
    } catch {
      seed = "0";
    }
    normalized.sampler.seed = seed;
    normalized.sampler.controlAfterGenerate = normalized.sampler.controlAfterGenerate === "fixed" ? "fixed" : "randomize";
    normalized.sampler.steps = Math.max(1, Math.min(10000, Math.round(Number(normalized.sampler.steps) || 20)));
    normalized.sampler.cfg = Math.max(0, Math.min(100, Number(normalized.sampler.cfg) || 0));
    normalized.sampler.denoise = Math.max(0, Math.min(1, Number(normalized.sampler.denoise) || 0));
    normalized.clip = normalized.clip.slice(0, 4);
    normalized.selectedStyleIds = normalized.selectedStyleIds.slice(0, 3);
    return normalized;
  }

  function validateGalleryDraft() {
    const names = new Set();
    for (const folder of draft.imageFolders) {
      const name = folder.name.trim();
      if (!name) {
        dialogStatus.textContent = "文件夹名称不能为空。";
        dialog.querySelector('[data-folder-field="name"]')?.focus();
        return false;
      }
      const key = name.toLocaleLowerCase();
      if (names.has(key)) {
        dialogStatus.textContent = `文件夹名称重复：${name}`;
        dialog.querySelector('[data-folder-field="name"]')?.focus();
        return false;
      }
      names.add(key);
    }
    draft.imageFolders = draft.imageFolders.map((folder) => {
      const photos = draft.imageLibrary.filter((image) => image.folderId === folder.id);
      return photos.some((image) => image.id === folder.coverImageId)
        ? folder
        : { ...folder, coverImageId: "" };
    });
    const folderById = new Map(draft.imageFolders.map((folder) => [folder.id, folder]));
    draft.imageLibrary = draft.imageLibrary.map((image) => ({
      ...image,
      category: folderById.get(image.folderId)?.name || "未分类",
    }));
    const selectedImage = draft.imageLibrary.find((image) => image.id === draft.editImage.id);
    if (selectedImage) {
      draft.editImage = { ...selectedImage, maskStrokes: draft.editImage.maskStrokes || [] };
    }
    draft.imageCategories = ["全部", ...draft.imageFolders.map((folder) => folder.name)];
    return true;
  }

  function applyPanel() {
    if (!draft || !activePanel) return;
    const panel = activePanel;
    draft = normalizeDraft();
    if (panel === "gallery" && !validateGalleryDraft()) return;
    const gallerySelectionMadeBeforeApply = panel === "gallery" && gallerySelectionMade;
    state = createInitialState(draft);
    renderMain();
    const eventTypes = {
      resolution: "resolution.change",
      model: "model.apply",
      styles: "style.change",
      prompts: "promptPreset.change",
      sampler: "sampler.change",
      gallery: gallerySelectionMadeBeforeApply ? "editImage.select" : "editImage.galleryManage",
    };
    publishState(eventTypes[panel], { panel, imageId: state.editImage.id });
    closePanel();
    displayStatus(`${PANEL_TITLES[panel][0]}已应用`);
  }

  function renderDialogFromChange() {
    renderPanelBody(focusedQueries.has(activePanel));
  }

  function handleRootClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || !root.contains(button)) return;
    const action = button.dataset.action;
    if (action === "open-panel") requestPanel(button.dataset.panel);
    if (action === "choose-image") {
      emitAction("editImage.choose", { source: "file-picker" });
      root.querySelector("[data-image-file]").click();
    }
    if (action === "open-gallery" || action === "open-categories" || action === "open-images") {
      emitAction("editImage.libraryOpen", { source: "node-editor" });
      requestPanel("gallery");
    }
    if (action === "mask-toggle") {
      emitAction("mask.open", { imageId: state.editImage.id });
    }
    if (action === "mask-clear") {
      emitAction("mask.clear", { imageId: state.editImage.id });
      displayStatus("正在清除遮罩…");
    }
    if (action === "image-clear") clearSelectedImage();
    if (action === "prompt-clear") {
      setPrompt(button.dataset.prompt, "", "prompt.clear");
      displayStatus(`${button.dataset.prompt === "negative" ? "负面" : "正面"}提示词已清空`);
    }
    if (action === "prompt-copy") copyPrompt(button.dataset.prompt);
    if (action === "prompt-paste") pastePrompt(button.dataset.prompt);
  }

  async function copyPrompt(fieldName) {
    const value = fieldName === "negative" ? state.negativePrompt : state.positivePrompt;
    emitAction("prompt.copy", { field: fieldName, value });
    try {
      await navigator.clipboard.writeText(value);
      displayStatus("提示词已复制");
    } catch {
      displayStatus("浏览器未开放剪贴板权限；提示词内容已通过回调提供。");
    }
  }

  async function pastePrompt(fieldName) {
    const field = root.querySelector(`[data-prompt-field="${fieldName}"]`);
    if (!field || field.disabled || field.pmClipboardPending) return;
    const start = field.selectionStart, end = field.selectionEnd;
    field.pmClipboardPending = true;
    emitAction("prompt.paste.request", { field: fieldName });
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      field.focus();
      displayStatus("浏览器未允许读取剪贴板，请允许此站点的剪贴板权限后重试；也可直接在原输入框按 Ctrl+V。");
      return;
    } finally {
      field.pmClipboardPending = false;
    }
    if (!text) { displayStatus("剪贴板中没有文字，原提示词已保留。"); return; }
    field.setRangeText(text, start, end, "end");
    setPrompt(fieldName, field.value, "prompt.paste");
    field.focus();
    field.setSelectionRange(start + text.length, start + text.length);
    displayStatus("提示词已粘贴");
  }

  function handleDialogClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || !dialog.contains(button)) return;
    const action = button.dataset.action;
    if (action === "close-dialog") closePanel();
    if (action === "apply-panel") applyPanel();
    if (action === "select-ratio") {
      const preset = RESOLUTION_PRESETS.find((item) => item.ratio === button.dataset.ratio);
      if (preset) {
        draft.resolution = { ...draft.resolution, width: preset.width, height: preset.height, ratio: preset.ratio };
        renderDialogFromChange();
      }
    }
    if (action === "select-resolution") {
      draft.resolution = { width: Number(button.dataset.width), height: Number(button.dataset.height), ratio: button.dataset.ratio };
      renderDialogFromChange();
    }
    if (action === "model-tab") {
      modelTab = button.dataset.tab;
      modelSearch = "";
      renderDialogFromChange();
    }
    if (action === "select-model-resource") selectModelResource(button.dataset.tab, button.dataset.id);
    if (action === "style-category") {
      styleFilter = button.dataset.category;
      renderDialogFromChange();
    }
    if (action === "style-favorites") {
      styleFavoritesOnly = !styleFavoritesOnly;
      renderDialogFromChange();
    }
    if (action === "style-favorite-one") {
      const styleId = button.dataset.id;
      if (favoriteStyles.has(styleId)) favoriteStyles.delete(styleId);
      else favoriteStyles.add(styleId);
      state.favoriteStyleIds = [...favoriteStyles];
      if (draft) draft.favoriteStyleIds = [...favoriteStyles];
      publishState("style.favorite", { id: styleId, favorite: favoriteStyles.has(styleId) });
      renderDialogFromChange();
    }
    if (action === "toggle-style") toggleStyle(button.dataset.id);
    if (action === "prompt-category") {
      promptFilter = button.dataset.category;
      renderDialogFromChange();
    }
    if (action === "select-preset") {
      selectedPresetId = button.dataset.id;
      renderDialogFromChange();
    }
    if (action === "preset-new") createPreset();
    if (action === "preset-copy") copyPreset(button.dataset.id);
    if (action === "preset-delete") deletePreset(button.dataset.id);
    if (action === "apply-preset-to-prompts") applyPresetToPrompts(button.dataset.id);
    if (action === "gallery-import") dialog.querySelector("[data-gallery-files]")?.click();
    if (action === "gallery-folder-new") addGalleryFolder();
    if (action === "gallery-folder-select") {
      selectedFolderId = button.dataset.folderId;
      renderDialogFromChange();
    }
    if (action === "gallery-select-image") selectGalleryImage(button.dataset.id);
    if (action === "gallery-set-cover") setGalleryCover(button.dataset.id);
  }

  function selectModelResource(tab, resourceId) {
    const item = catalog[tab].find((entry) => entry.id === resourceId);
    if (!item) return;
    if (tab === "models") draft.model = cloneState(item);
    if (tab === "clips") {
      const clips = draft.clip.filter((clip) => clip !== resourceId);
      if (clips.length === draft.clip.length && clips.length >= 4) {
        dialogStatus.textContent = "最多选择四个 CLIP。";
        return;
      }
      draft.clip = clips.length === draft.clip.length ? [...clips, resourceId] : clips;
    }
    if (tab === "vaes") draft.vae = resourceId;
    if (tab === "loras") {
      const loras = draft.loras.filter((lora) => (typeof lora === "string" ? lora : lora.id) !== resourceId);
      draft.loras = loras.length === draft.loras.length ? [...loras, cloneState(item)] : loras;
    }
    renderDialogFromChange();
  }

  function toggleStyle(styleId) {
    const selected = draft.selectedStyleIds.includes(styleId);
    if (!selected && draft.selectedStyleIds.length >= 3) {
      dialogStatus.textContent = "最多同时选择三种风格。";
      return;
    }
    draft.selectedStyleIds = selected
      ? draft.selectedStyleIds.filter((id) => id !== styleId)
      : [...draft.selectedStyleIds, styleId];
    dialogStatus.textContent = "";
    renderDialogFromChange();
  }

  function createPreset() {
    const preset = {
      id: `custom-${Date.now()}`,
      name: "新提示词预设",
      category: "自定义",
      positive: "",
      negative: "",
      enabled: true,
    };
    draft.promptPresets = [...draft.promptPresets, preset];
    selectedPresetId = preset.id;
    promptFilter = "全部";
    renderDialogFromChange();
    dialog.querySelector('[data-preset-field="name"]')?.focus();
    dialog.querySelector('[data-preset-field="name"]')?.select();
  }

  function copyPreset(presetId) {
    const preset = draft.promptPresets.find((item) => item.id === presetId);
    if (!preset) return;
    const copy = { ...preset, id: `custom-${Date.now()}`, name: `${preset.name} 副本` };
    draft.promptPresets = [...draft.promptPresets, copy];
    selectedPresetId = copy.id;
    promptFilter = "全部";
    renderDialogFromChange();
  }

  function deletePreset(presetId) {
    draft.promptPresets = draft.promptPresets.filter((preset) => preset.id !== presetId);
    selectedPresetId = draft.promptPresets[0]?.id || "";
    renderDialogFromChange();
  }

  function applyPresetToPrompts(presetId) {
    const preset = draft.promptPresets.find((item) => item.id === presetId);
    if (!preset || preset.enabled === false) return;
    draft.selectedPromptPreset = preset.id;
    draft.positivePrompt = preset.positive || "";
    draft.negativePrompt = preset.negative || "";
    dialogStatus.textContent = "已将提示词填入编辑区，点击“保存并关闭”保留更改。";
    emitAction("promptPreset.apply", { id: preset.id });
  }

  function addGalleryFolder() {
    let suffix = 1;
    let name = "新建相册";
    while (draft.imageFolders.some((folder) => folder.name === name)) name = `新建相册 ${++suffix}`;
    draft.imageFolders = createGalleryFolder(draft.imageFolders, name);
    selectedFolderId = draft.imageFolders.at(-1).id;
    dialogStatus.textContent = "相册已创建；可以修改名称、备注和封面。";
    renderDialogFromChange();
    dialog.querySelector('[data-folder-field="name"]')?.focus();
    dialog.querySelector('[data-folder-field="name"]')?.select();
  }

  function selectGalleryImage(imageId) {
    const image = draft.imageLibrary.find((entry) => entry.id === imageId);
    if (!image) return;
    draft.editImage = { ...cloneState(image), maskStrokes: [] };
    gallerySelectionMade = true;
    dialogStatus.textContent = `已选择「${image.name}」作为待编辑图片；点击“应用”确认。`;
    renderDialogFromChange();
  }

  function setGalleryCover(imageId) {
    const image = draft.imageLibrary.find((entry) => entry.id === imageId);
    if (!image) return;
    draft.imageFolders = updateGalleryFolder(draft.imageFolders, image.folderId, { coverImageId: image.id });
    dialogStatus.textContent = `已将「${image.name}」设为相册封面。`;
    renderDialogFromChange();
  }

  function moveGalleryImage(imageId, folderId) {
    const image = draft.imageLibrary.find((entry) => entry.id === imageId);
    const folder = draft.imageFolders.find((entry) => entry.id === folderId);
    if (!image || !folder || image.folderId === folderId) return;
    const previousFolderId = image.folderId;
    draft.imageLibrary = draft.imageLibrary.map((entry) => entry.id === imageId
      ? { ...entry, folderId, category: folder.name }
      : entry);
    draft.imageFolders = draft.imageFolders.map((entry) => entry.id === previousFolderId && entry.coverImageId === imageId
      ? { ...entry, coverImageId: "" }
      : entry);
    if (!folder.coverImageId) draft.imageFolders = updateGalleryFolder(draft.imageFolders, folderId, { coverImageId: imageId });
    if (draft.editImage.id === imageId) draft.editImage = { ...draft.editImage, folderId, category: folder.name };
    dialogStatus.textContent = `已将「${image.name}」移动到「${folder.name}」。`;
    renderDialogFromChange();
  }

  function updateGalleryFolderField(target) {
    const folder = draft.imageFolders.find((item) => item.id === selectedFolderId);
    const field = target.dataset.folderField;
    if (!folder || !field) return;
    draft.imageFolders = updateGalleryFolder(draft.imageFolders, folder.id, { [field]: target.value });
    if (field === "name") {
      dialogBody.querySelectorAll("[data-folder-name]").forEach((node) => {
        if (node.dataset.folderName === folder.id) node.textContent = target.value || "未命名文件夹";
      });
      const heading = dialogBody.querySelector("[data-gallery-heading]");
      if (heading) heading.textContent = target.value || "未命名文件夹";
    }
    if (field === "coverImageId") renderDialogFromChange();
  }

  function importGalleryFiles(files) {
    const imageFiles = Array.from(files || []).filter(isSupportedImageFile);
    if (!imageFiles.length) {
      dialogStatus.textContent = "仅支持 PNG、JPEG、WebP 图片。";
      return;
    }
    if (selectedFolderId === "all") {
      selectedFolderId = (draft.imageFolders.find((folder) => folder.name === "未分类") || draft.imageFolders[0])?.id || "all";
    }
    dialogStatus.textContent = `正在加入 ${imageFiles.length} 张图片…`;
    for (const file of imageFiles) acceptImageFile(file, "editImage.galleryImport", { galleryBatch: true });
  }

  function handleRootInput(event) {
    const promptField = event.target.dataset.promptField;
    if (promptField) setPrompt(promptField, event.target.value);
  }

  function handleDialogInput(event) {
    const search = event.target.dataset.search;
    if (search) {
      if (search === "model") modelSearch = event.target.value;
      if (search === "style") styleSearch = event.target.value;
      if (search === "prompt") promptSearch = event.target.value;
      if (search === "gallery") gallerySearch = event.target.value;
      renderPanelBody(true);
      return;
    }
    if (event.target.dataset.folderField && event.target.dataset.folderField !== "coverImageId") {
      updateGalleryFolderField(event.target);
      return;
    }
    const draftPath = event.target.dataset.draft;
    if (draftPath) {
      const value = event.target.type === "number" && draftPath !== "sampler.seed" ? Number(event.target.value) : event.target.value;
      setPath(draft, draftPath, value);
      if (draftPath.startsWith("resolution.")) {
        draft.resolution.ratio = chooseRatio(draft.resolution.width, draft.resolution.height);
        dialogBody.querySelectorAll('[data-action="select-ratio"]').forEach((button) => {
          const selected = button.dataset.ratio === draft.resolution.ratio;
          button.classList.toggle("cc-selected", selected);
          button.setAttribute("aria-pressed", String(selected));
        });
      }
      return;
    }
    const presetField = event.target.dataset.presetField;
    if (presetField) {
      const preset = draft.promptPresets.find((item) => item.id === selectedPresetId);
      if (preset) preset[presetField] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    }
  }

  function handleDialogChange(event) {
    const galleryFiles = event.target.matches("[data-gallery-files]");
    if (galleryFiles) {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      importGalleryFiles(files);
      return;
    }
    if (event.target.dataset.galleryImageFolder) {
      moveGalleryImage(event.target.dataset.galleryImageFolder, event.target.value);
      return;
    }
    if (event.target.dataset.folderField === "coverImageId") updateGalleryFolderField(event.target);
  }

  function handleGalleryDragOver(event) {
    const target = event.target.closest?.("[data-gallery-drop]");
    if (!target || !dialog.contains(target)) return;
    event.preventDefault();
    target.classList.add("cc-gallery-drop-active");
  }

  function handleGalleryDragLeave(event) {
    const target = event.target.closest?.("[data-gallery-drop]");
    if (!target || target.contains(event.relatedTarget)) return;
    target.classList.remove("cc-gallery-drop-active");
  }

  function handleGalleryDrop(event) {
    const target = event.target.closest?.("[data-gallery-drop]");
    if (!target || !dialog.contains(target)) return;
    event.preventDefault();
    target.classList.remove("cc-gallery-drop-active");
    importGalleryFiles(event.dataTransfer?.files);
  }

  function handleStageDragOver(event) {
    event.preventDefault();
    imageStage.dataset.dragging = "true";
    imageStage.classList.add("cc-stage-dragging");
  }

  function handleStageDrop(event) {
    event.preventDefault();
    imageStage.dataset.dragging = "false";
    const file = event.dataTransfer?.files?.[0];
    if (file) acceptImageFile(file, "editImage.drop");
    else displayStatus("把图片文件拖到图片编辑区域。", true);
    renderMain();
  }

  function handleImageLoad() {
    if (!editImage || !state.editImage.src) return;
    if (!state.editImage.width || !state.editImage.height) {
      const imagePatch = { width: editImage.naturalWidth, height: editImage.naturalHeight };
      state = mergeState(state, { editImage: imagePatch });
      try {
        options.onStateChange?.(cloneState(state), { type: "editImage.dimensions", detail: imagePatch });
      } catch (error) {
        displayStatus(`状态回调出错：${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
    syncStageSizing();
  }

  function handleDialogClose() {
    if (destroyed) return;
    if (activePanel) emitAction("panel.close", { panel: activePanel });
    activePanel = "";
    draft = null;
    dialog.classList.remove("cc-dialog-gallery");
    dialogBody.replaceChildren();
  }

  root.addEventListener("click", handleRootClick, { signal });
  dialog.addEventListener("click", handleDialogClick, { signal });
  root.addEventListener("input", handleRootInput, { signal });
  dialog.addEventListener("input", handleDialogInput, { signal });
  dialog.addEventListener("change", handleDialogChange, { signal });
  dialog.addEventListener("dragover", handleGalleryDragOver, { signal });
  dialog.addEventListener("dragleave", handleGalleryDragLeave, { signal });
  dialog.addEventListener("drop", handleGalleryDrop, { signal });
  imageStage.addEventListener("dragover", handleStageDragOver, { signal });
  imageStage.addEventListener("dragleave", () => {
    imageStage.dataset.dragging = "false";
    renderMain();
  }, { signal });
  imageStage.addEventListener("drop", handleStageDrop, { signal });
  imageStage.addEventListener("click", () => {
    if (!state.editImage.src) return;
    root.querySelector("[data-image-file]").click();
  }, { signal });
  root.querySelector("[data-image-file]").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) acceptImageFile(file, "editImage.choose");
    event.target.value = "";
  }, { signal });
  dialog.addEventListener("close", handleDialogClose, { signal });
  dialog.addEventListener("cancel", () => {
    if (activePanel) emitAction("panel.cancel", { panel: activePanel });
  }, { signal });
  window.addEventListener("resize", () => {
    syncStageSizing();
  }, { signal });

  renderMain();

  return {
    getState() {
      return cloneState(state);
    },
    setState(patch) {
      if (destroyed) return cloneState(state);
      state = createInitialState(mergeState(state, patch));
      favoriteStyles.clear();
      for (const styleId of state.favoriteStyleIds) favoriteStyles.add(styleId);
      renderMain();
      publishState("state.set", { keys: Object.keys(patch || {}) });
      return cloneState(state);
    },
    setCatalog(patch) {
      if (destroyed) return;
      for (const [key, value] of Object.entries(patch || {})) {
        if (Object.hasOwn(DEFAULT_CATALOG, key) && Array.isArray(value)) catalog[key] = value;
      }
      renderMain();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abortController.abort();
      if (dialog.open) dialog.close();
      dialog.remove();
      root.remove();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      stylesheetCleanup();
    },
    element: root,
  };
}

export { createInitialState, resolveModelCapabilities } from "./state.mjs";
export { fittedEditResolution };
