const MIN_FRAME_HEIGHT = 150;
const MAX_FRAME_HEIGHT = 900;
const DEFAULT_FRAME_WIDTH = 320;
const FRAME_VERTICAL_BORDER = 2;

/** Calculate a preview height in CSS pixels from its rendered width and image ratio. */
export function calculatePreviewFrameHeight(frameWidth, imageWidth, imageHeight) {
    const width = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : DEFAULT_FRAME_WIDTH;
    const hasImageRatio = Number.isFinite(imageWidth) && imageWidth > 0
        && Number.isFinite(imageHeight) && imageHeight > 0;
    const ratio = hasImageRatio ? imageHeight / imageWidth : 9 / 16;
    const imageHeightInCssPixels = Math.round(width * ratio);
    return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, imageHeightInCssPixels + FRAME_VERTICAL_BORDER));
}
