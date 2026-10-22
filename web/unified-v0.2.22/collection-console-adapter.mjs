const LEGACY_PANEL_ROUTES = Object.freeze({
    model: "model-manager",
    styles: "style-manager",
    prompts: "prompt-manager",
    resolution: "resolution-selector",
    sampler: "sampler-settings",
    gallery: "image-library",
});

export function legacyPanelRoute(panel) {
    return LEGACY_PANEL_ROUTES[panel] || null;
}

export function toSamplerWidgetValue(sampler) {
    return JSON.stringify({
        seed: Number(sampler.seed),
        steps: Number(sampler.steps),
        cfg: Number(sampler.cfg),
        sampler_name: String(sampler.sampler || "euler"),
        scheduler: String(sampler.scheduler || "normal"),
        denoise: Number(sampler.denoise),
        control_after_generate: sampler.controlAfterGenerate === "fixed" ? "fixed" : "randomize",
    });
}
