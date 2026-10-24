export const emptyConfig = () => ({ schema: 2, presets: [], styles: [], style_enabled: false, style_order: "user", multi_select: false,
    krea_style_reference: { low_scale_end: 1.1, ref_k_strength: 0, rf_mode: "rf_gamma" } });
export function parseConfig(raw) {
    const value = JSON.parse(raw);
    if (!value || ![1, 2].includes(value.schema) || !Array.isArray(value.presets) || value.presets.length > 256) throw Error("无效配置，原文已保留");
    const ids = new Set();
    for (const p of value.presets) {
        if (!p || typeof p.id !== "string" || !p.id || ids.has(p.id) || !Number.isInteger(p.revision) || p.revision < 1 ||
            typeof p.name !== "string" || !p.name.trim() || typeof p.enabled !== "boolean" ||
            typeof p.positive !== "string" || typeof p.negative !== "string") throw Error("无效预设快照，原配置已保留");
        ids.add(p.id);
    }
    if (value.schema === 1) return { ...emptyConfig(), presets: structuredClone(value.presets) };
    if (!Array.isArray(value.styles) || value.styles.length > 3 || typeof value.style_enabled !== "boolean" ||
        typeof value.multi_select !== "boolean" || !["user", "style", "krea"].includes(value.style_order) || (!value.multi_select && value.styles.length > 1)) throw Error("无效风格配置，原文已保留");
    const styleIds = new Set();
    for (const s of value.styles) {
        if (!s || typeof s.id !== "string" || !s.id || styleIds.has(s.id) || !Number.isInteger(s.revision) || s.revision < 1 ||
            typeof s.name !== "string" || !s.name.trim() || typeof s.positive !== "string" || typeof s.negative !== "string" ||
            !["tags", "paragraph"].includes(s.text_type)) throw Error("无效风格快照，原文已保留");
        styleIds.add(s.id);
    }
    const result = structuredClone(value);
    if (result.style_order === "krea") result.style_order = "style";
    const strengths = result.krea_style_reference ?? {};
    if (!strengths || typeof strengths !== "object" || Array.isArray(strengths)) throw Error("无效 Krea2 风格参考强度配置，原文已保留");
    const lowScaleEnd = strengths.low_scale_end ?? 1.1;
    let refKStrength = strengths.ref_k_strength ?? 0;
    const rfMode = strengths.rf_mode ?? "rf_gamma";
    if (typeof lowScaleEnd !== "number" || !Number.isFinite(lowScaleEnd) || lowScaleEnd < -4 || lowScaleEnd > 8 ||
        typeof refKStrength !== "number" || !Number.isFinite(refKStrength) || refKStrength < 0 || refKStrength > 5)
        throw Error("Krea2 风格参考强度超出范围，原文已保留");
    if (!Object.hasOwn(strengths, "rf_mode") && refKStrength === 1.1) refKStrength = 0;
    if (!["rf_gamma", "flowturbo_pc"].includes(rfMode)) throw Error("Krea2 参考计算模式无效，原文已保留");
    result.krea_style_reference = { low_scale_end: lowScaleEnd, ref_k_strength: refKStrength, rf_mode: rfMode };
    return result;
}
export function applyStyle(config, style, sync = false) {
    const c = parseConfig(JSON.stringify(config));
    const index = c.styles.findIndex(s => s.id === style.id);
    if (index >= 0 && !sync) { c.styles.splice(index, 1); return c; }
    const snapshot = Object.fromEntries(["id", "revision", "name", "positive", "negative", "text_type", "image"].map(k => [k, style[k] ?? ""]));
    if (index >= 0) c.styles[index] = snapshot;
    else if (!c.multi_select) c.styles = [snapshot];
    else if (c.styles.length >= 3) throw Error("已达 3 项上限，请先移除一个风格");
    else c.styles.push(snapshot);
    c.style_enabled = true;
    return c;
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
