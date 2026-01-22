import sharp from "sharp";

export type TemplateBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TemplateCrop = {
  bounds: TemplateBounds;
  buffer: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
};

const cropCache = new Map<string, TemplateCrop>();

export async function getTemplateCrop(templatePath: string): Promise<TemplateCrop> {
  const cached = cropCache.get(templatePath);
  if (cached) return cached;

  const image = sharp(templatePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) {
    throw new Error(`Unable to read template dimensions for ${templatePath}`);
  }

  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const idx = (y * info.width + x) * 4 + 3;
      if (data[idx] > 0) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!found) {
    minX = 0;
    minY = 0;
    maxX = info.width - 1;
    maxY = info.height - 1;
  }

  const bounds = {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  const cropped = await sharp(templatePath)
    .extract(bounds)
    .png()
    .toBuffer({ resolveWithObject: true });

  const cacheValue: TemplateCrop = {
    bounds,
    buffer: cropped.data,
    width: cropped.info.width ?? bounds.width,
    height: cropped.info.height ?? bounds.height,
    sourceWidth: info.width,
    sourceHeight: info.height,
  };

  cropCache.set(templatePath, cacheValue);
  return cacheValue;
}
