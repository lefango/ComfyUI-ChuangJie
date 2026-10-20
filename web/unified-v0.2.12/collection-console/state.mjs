const DEFAULT_STATE = {
  model: { id: "krea2", name: "Krea 2", family: "krea2", cover: "" },
  clip: ["clip-l"],
  vae: "default",
  loras: [],
  positivePrompt: "",
  negativePrompt: "",
  selectedPromptPreset: "",
  promptPresets: [],
  selectedStyleIds: [],
  favoriteStyleIds: [],
  resolution: { width: 1024, height: 1024, ratio: "1:1" },
  sampler: {
    seed: "0",
    steps: 20,
    cfg: 8,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1,
    controlAfterGenerate: "randomize",
  },
  editImage: {
    id: "",
    src: "",
    name: "",
    width: 0,
    height: 0,
    category: "",
    hasMask: false,
    maskDataUrl: "",
    maskStrokes: [],
  },
  imageLibrary: [],
  imageCategories: ["全部", "未分类"],
  imageFolders: [{ id: "folder-1", name: "未分类", notes: "", coverImageId: "" }],
  previews: { sample: "", final: "" },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRecords(base, override) {
  if (!isRecord(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? mergeRecords(result[key], value)
      : structuredClone(value);
  }
  return result;
}

export function createInitialState(overrides = {}) {
  const state = mergeRecords(DEFAULT_STATE, overrides);
  state.clip = Array.isArray(state.clip) ? state.clip : [state.clip].filter(Boolean);
  state.loras = Array.isArray(state.loras) ? state.loras : [];
  state.promptPresets = Array.isArray(state.promptPresets) ? state.promptPresets : [];
  state.selectedStyleIds = Array.isArray(state.selectedStyleIds) ? state.selectedStyleIds : [];
  state.favoriteStyleIds = Array.isArray(state.favoriteStyleIds) ? state.favoriteStyleIds : [];
  state.editImage.maskStrokes = Array.isArray(state.editImage.maskStrokes) ? state.editImage.maskStrokes : [];
  state.imageLibrary = Array.isArray(state.imageLibrary) ? state.imageLibrary : [];
  state.imageCategories = Array.isArray(state.imageCategories) ? state.imageCategories : ["全部", "未分类"];
  const folders = Array.isArray(overrides.imageFolders)
    ? state.imageFolders
    : state.imageCategories
      .filter((name) => name !== "全部")
      .map((name, index) => ({ id: `folder-${index + 1}`, name }));
  state.imageFolders = folders
    .filter((folder) => folder && folder.name !== "全部")
    .map((folder, index) => ({
      id: String(folder.id || `folder-${index + 1}`),
      name: String(folder.name || `相册 ${index + 1}`).trim(),
      notes: String(folder.notes || ""),
      coverImageId: String(folder.coverImageId || ""),
    }));
  if (!state.imageFolders.length) state.imageFolders = structuredClone(DEFAULT_STATE.imageFolders);
  state.imageCategories = ["全部", ...state.imageFolders.map((folder) => folder.name)];
  state.imageLibrary = state.imageLibrary.map((image) => {
    const matchingFolder = image.folderId
      ? state.imageFolders.find((folder) => folder.id === image.folderId)
      : state.imageFolders.find((folder) => folder.name === image.category);
    const fallbackFolder = matchingFolder
      || state.imageFolders.find((folder) => folder.name === "未分类")
      || state.imageFolders[0];
    return { ...image, category: matchingFolder?.name || fallbackFolder?.name || "未分类", folderId: fallbackFolder?.id || "" };
  });
  return state;
}

export function createGalleryFolder(folders, name, id) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("文件夹名称不能为空");
  if (folders.some((folder) => folder.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error("文件夹名称已存在");
  const folderId = id || `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [...folders, { id: folderId, name: normalizedName, notes: "", coverImageId: "" }];
}

export function updateGalleryFolder(folders, folderId, patch) {
  const safePatch = {};
  if (Object.hasOwn(patch, "name")) safePatch.name = String(patch.name ?? "").trim();
  if (Object.hasOwn(patch, "notes")) safePatch.notes = String(patch.notes ?? "");
  if (Object.hasOwn(patch, "coverImageId")) safePatch.coverImageId = String(patch.coverImageId ?? "");
  return folders.map((folder) => folder.id === folderId ? { ...folder, ...safePatch } : folder);
}

export function mergeState(state, patch) {
  return mergeRecords(state, patch);
}

export function resolveModelCapabilities(model = {}) {
  const identity = [model.id, model.name, model.family, model.architecture,
    ...(Array.isArray(model.files) ? model.files : [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const qwenImage21 = /(?:^|_)qwen_?image_?2_?1(?:_|$)/.test(identity);
  const supportsKreaStyleReference = identity.includes("krea2");
  return {
    imageEditing: qwenImage21,
    styleReference: qwenImage21 || supportsKreaStyleReference,
  };
}

export function cloneState(state) {
  return structuredClone(state);
}
