import fs from "fs";
import path from "path";
import sharp from "sharp";
import ssim from "ssim.js";
import { log } from "./logger";

// On Windows, sharp can keep files "locked" for a while. Turning its cache
// off means we can safely replace files later.
sharp.cache(false);

// JPEG quality from 1 to 100. Higher = better looking but bigger.
// Change this number if you want more (or less) compression.
const JPEG_QUALITY = 85;

// To save memory, we compare the images at a reduced size: at most this many
// pixels on the longest side. Both images are shrunk in exactly the same way.
const COMPARE_MAX_SIDE = 1600;

// Read an image as raw pixels (red, green, blue, alpha for every dot),
// so we can compare two images dot by dot.
async function readPixels(file: string) {
  const { data, info } = await sharp(file)
    .rotate()                 // apply the camera's rotation, same as for the copy
    .resize({ width: COMPARE_MAX_SIDE, height: COMPARE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")    // make sure it is colour, not grey
    .ensureAlpha()            // always 4 values per dot
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface SmallerCopyResult {
  sizeBytes: number; // size of the smaller copy
  ssim: number;      // similarity: 1.0000 = identical, lower = more different
}

// Make a smaller copy of "originalFile" at "smallerFile" and score it.
// The original is only READ, never changed.
export async function makeSmallerCopy(
  originalFile: string,
  smallerFile: string
): Promise<SmallerCopyResult> {
  fs.mkdirSync(path.dirname(smallerFile), { recursive: true });

  const isPng = path.extname(originalFile).toLowerCase() === ".png";

  // .rotate() fixes sideways photos; .keepIccProfile() keeps the colours right.
  let pipeline = sharp(originalFile).rotate().keepIccProfile();
  pipeline = isPng
    ? pipeline.png({ compressionLevel: 9, effort: 7 })      // PNG: lossless
    : pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }); // JPG: lossy
  await pipeline.toFile(smallerFile);
  log(`  smaller copy written, now comparing: ${path.basename(smallerFile)}`);

  // Compare original and smaller copy.
  const a = await readPixels(originalFile);
  const b = await readPixels(smallerFile);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("The smaller copy has a different size in pixels. Not safe to use.");
  }

  const toImage = (p: typeof a) => ({
    data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength),
    width: p.width,
    height: p.height,
  });
  const result = ssim(toImage(a), toImage(b), { ssim: "fast", downsample: false });
  log(`  comparison done: SSIM ${result.mssim}`);

  return {
    sizeBytes: fs.statSync(smallerFile).size,
    ssim: Math.round(result.mssim * 10000) / 10000,
  };
}
