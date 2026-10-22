export const MAX_STYLE_COVER_EDGE = 4096;

export async function normalizeCoverBlob(blob, maxBytes = 70 * 1024 * 1024) {
    if (!(blob instanceof Blob)) throw Error("风格封面无效");
    const bitmap = await createImageBitmap(blob);
    try {
        const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
        if (!sourceWidth || !sourceHeight) throw Error("风格封面尺寸无效");
        if (Math.max(sourceWidth, sourceHeight) <= MAX_STYLE_COVER_EDGE && blob.size <= maxBytes) return blob;

        let scale = Math.min(1, MAX_STYLE_COVER_EDGE / Math.max(sourceWidth, sourceHeight));
        let quality = 0.92;
        const canvas = document.createElement("canvas");
        for (let attempt = 0; attempt < 12; attempt++) {
            canvas.width = Math.max(1, Math.floor(sourceWidth * scale));
            canvas.height = Math.max(1, Math.floor(sourceHeight * scale));
            const context = canvas.getContext("2d", {alpha: false});
            if (!context) throw Error("封面压缩画布不可用");
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const result = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
            if (!result) throw Error("封面压缩失败");
            if (result.size <= maxBytes) return result;
            if (quality > 0.72) quality = Math.max(0.72, quality - 0.05);
            else scale *= 0.9;
        }
        throw Error(`封面压缩后仍超过 ${maxBytes / (1024 * 1024)} MB`);
    } finally {
        bitmap.close();
    }
}
