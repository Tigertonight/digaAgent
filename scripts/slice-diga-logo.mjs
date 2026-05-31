import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const source = path.resolve(
  "output/imagegen/chibi_pixel_tiga_ultraman_2x8_green_bg_v2.png",
);
const outDir = path.resolve("public/brand/diga-logo-frames");
const rows = 2;
const cols = 8;
const pad = 10;

await fs.mkdir(outDir, { recursive: true });

const image = sharp(source).ensureAlpha();
const meta = await image.metadata();
if (!meta.width || !meta.height) {
  throw new Error("Could not read source dimensions");
}

const raw = await image.raw().toBuffer();
const channels = 4;

function idx(x, y) {
  return (y * meta.width + x) * channels;
}

function isGreen(r, g, b, a) {
  return a > 0 && r === 0 && g === 255 && b === 0;
}

for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const cellX0 = Math.round((col * meta.width) / cols);
    const cellX1 = Math.round(((col + 1) * meta.width) / cols);
    const cellY0 = Math.round((row * meta.height) / rows);
    const cellY1 = Math.round(((row + 1) * meta.height) / rows);

    let minX = cellX1;
    let minY = cellY1;
    let maxX = cellX0;
    let maxY = cellY0;

    for (let y = cellY0; y < cellY1; y++) {
      for (let x = cellX0; x < cellX1; x++) {
        const i = idx(x, y);
        const r = raw[i];
        const g = raw[i + 1];
        const b = raw[i + 2];
        const a = raw[i + 3];
        if (a > 0 && !isGreen(r, g, b, a)) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (minX > maxX || minY > maxY) {
      throw new Error(`No non-green pixels found in cell ${row + 1},${col + 1}`);
    }

    const cropX = Math.max(cellX0, minX - pad);
    const cropY = Math.max(cellY0, minY - pad);
    const cropRight = Math.min(cellX1, maxX + 1 + pad);
    const cropBottom = Math.min(cellY1, maxY + 1 + pad);
    const width = cropRight - cropX;
    const height = cropBottom - cropY;

    const cell = await sharp(source)
      .ensureAlpha()
      .extract({ left: cropX, top: cropY, width, height })
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let i = 0; i < cell.data.length; i += 4) {
      const r = cell.data[i];
      const g = cell.data[i + 1];
      const b = cell.data[i + 2];
      const a = cell.data[i + 3];
      if (isGreen(r, g, b, a)) {
        cell.data[i + 3] = 0;
      }
    }

    const frameNo = row * cols + col + 1;
    const name = `diga-logo-${String(frameNo).padStart(2, "0")}.webp`;
    const out = path.join(outDir, name);
    await sharp(cell.data, { raw: cell.info })
      .webp({ quality: 95, effort: 6, lossless: true })
      .toFile(out);

    console.log(
      `${name}: cell=(${cellX0},${cellY0})-${cellX1}x${cellY1} crop=${width}x${height}+${cropX},${cropY}`,
    );
  }
}

const mainSrc = path.join(outDir, "diga-logo-03.webp");
const mainDst = path.resolve("public/brand/diga-logo-main.webp");
await fs.copyFile(mainSrc, mainDst);
console.log(`main copied: ${mainDst}`);
