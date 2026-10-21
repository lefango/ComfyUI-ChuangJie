export const emptyState = () => ({ version: 1, entries: [], preset: null });
export const clone = (value) => JSON.parse(JSON.stringify(value));

export function parseState(value) {
    const data = typeof value === "string" ? JSON.parse(value) : clone(value);
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) throw new Error("节点配置无效，请恢复有效的工作流配置。");
    const seen = new Set();
    if (data.entries.length > 512) throw new Error("配置超过 512 项。");
    data.entries = data.entries.map((item) => {
        if (!item || typeof item.file !== "string" || !item.file || seen.has(item.file)) throw new Error("LoRA 文件名无效或重复。");
        const file = item.file.replaceAll("\\", "/");
        if (file.split("/").some((p) => !p || p === "." || p === "..") || /[:\x00-\x1f]/.test(file) || seen.has(file)) throw new Error("LoRA 文件路径无效或重复。");
        seen.add(file);
        const result = { file, name: item.name ?? file, trigger: item.trigger ?? "", enabled: item.enabled ?? true,
            strength_model: item.strength_model ?? 1, strength_clip: item.strength_clip ?? 1 };
        if (typeof result.enabled !== "boolean" || typeof result.name !== "string" || typeof result.trigger !== "string") throw new Error("LoRA 配置字段无效。");
        for (const field of ["strength_model", "strength_clip"]) {
            if (typeof result[field] !== "number" || !Number.isFinite(result[field]) || Math.abs(result[field]) > 100) throw new Error("强度必须在 -100 至 100 之间。");
        }
        return result;
    });
    return data;
}

export function triggerText(entries) {
    return [...new Set(entries.filter((i) => i.enabled).map((i) => i.trigger.trim()).filter(Boolean))].join(", ");
}

export function setEnabled(snapshot, info, enabled) {
    let item = snapshot.entries.find((i) => i.file === info.file);
    if (!item) {
        if (snapshot.entries.length >= 512) throw new Error("当前节点最多保存 512 项，请先清理关闭的项。");
        item = { file: info.file, name: info.name, trigger: info.trigger, enabled: false,
            strength_model: info.strength_model, strength_clip: info.strength_clip };
        snapshot.entries.push(item);
    }
    item.enabled = enabled;
    return item;
}

export function replacePreset(snapshot) {
    return parseState(snapshot); // New snapshot, never retain references into the public library.
}

export function reorder(snapshot, file, direction) {
    const enabled = snapshot.entries.filter((i) => i.enabled);
    const from = enabled.findIndex((i) => i.file === file), to = from + direction;
    if (from < 0 || to < 0 || to >= enabled.length) return;
    const a = snapshot.entries.indexOf(enabled[from]), b = snapshot.entries.indexOf(enabled[to]);
    [snapshot.entries[a], snapshot.entries[b]] = [snapshot.entries[b], snapshot.entries[a]];
}
