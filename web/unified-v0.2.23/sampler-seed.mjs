export const MAX_SEED = Number.MAX_SAFE_INTEGER;
const SEED_RANGE_SIZE = MAX_SEED + 1;

export function normalizeSamplerConfig(value) {
    const config = typeof value === "string" ? JSON.parse(value) : value;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new TypeError("K 采样器设置无效");
    }
    return {
        ...config,
        control_after_generate: config.control_after_generate === "fixed" ? "fixed" : "randomize",
    };
}

export function randomSafeSeed(random = Math.random) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
        throw new RangeError("随机数必须在 0（含）到 1（不含）之间");
    }
    return Math.floor(sample * SEED_RANGE_SIZE);
}

export function randomizeSamplingConfigAfterQueue(value, random = Math.random, seedToAvoid) {
    const config = normalizeSamplerConfig(value);
    if (config.control_after_generate === "fixed") return config;
    const blockedSeeds = new Set([Number(config.seed ?? 0), Number(seedToAvoid)].filter(Number.isSafeInteger));
    let seed = randomSafeSeed(random);
    while (blockedSeeds.has(seed)) seed = seed >= MAX_SEED ? 0 : seed + 1;
    return { ...config, seed, control_after_generate: "randomize" };
}
