export const emptyConfig = () => ({ schema: 1, presets: [] });
export function parseConfig(raw) {
    const value = JSON.parse(raw);
    if (!value || value.schema !== 1 || !Array.isArray(value.presets) || value.presets.length > 256) throw Error("无效配置，原文已保留");
    const ids = new Set();
    for (const p of value.presets) {
        if (!p || typeof p.id !== "string" || !p.id || ids.has(p.id) || !Number.isInteger(p.revision) || p.revision < 1 ||
            typeof p.name !== "string" || !p.name.trim() || typeof p.enabled !== "boolean" ||
            typeof p.positive !== "string" || typeof p.negative !== "string") throw Error("无效预设快照，原配置已保留");
        ids.add(p.id);
    }
    return structuredClone(value);
}
export function applyPreset(config, preset, sync = false) {
    const result = structuredClone(config);
    const index = result.presets.findIndex(p => p.id === preset.id);
    if (index >= 0 && !sync) result.presets[index].enabled = true;
    else {
        const item = { id: preset.id, revision: preset.revision, name: preset.name,
            positive: preset.positive, negative: preset.negative,
            enabled: index >= 0 ? result.presets[index].enabled : true };
        if (index >= 0) result.presets[index] = item;
        else result.presets.push(item);
    }
    return result;
}
export function descendants(categories, id) {
    const ids = new Set([id]);
    let size;
    do { size = ids.size; for (const c of categories) if (ids.has(c.parent)) ids.add(c.id); } while (size !== ids.size);
    return ids;
}
export function movePreset(config, from, to) {
    const result = structuredClone(config);
    if (from < 0 || to < 0 || from >= result.presets.length || to >= result.presets.length) return result;
    result.presets.splice(to, 0, result.presets.splice(from, 1)[0]);
    return result;
}
