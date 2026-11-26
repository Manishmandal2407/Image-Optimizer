"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSmallerCopy = makeSmallerCopy;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const ssim_js_1 = __importDefault(require("ssim.js"));
const logger_1 = require("./logger");
// On Windows, sharp can keep files "locked" for a while. Turning its cache
// off means we can safely replace files later.
sharp_1.default.cache(false);
// JPEG quality from 1 to 100. Higher = better looking but bigger.
// Change this number if you want more (or less) compression.
const JPEG_QUALITY = 85;
// To save memory, we compare the images at a reduced size: at most this many
// pixels on the longest side. Both images are shrunk in exactly the same way.
const COMPARE_MAX_SIDE = 1600;
// Read an image as raw pixels (red, green, blue, alpha for every dot),
// so we can compare two images dot by dot.
async function readPixels(file) {
    const { data, info } = await (0, sharp_1.default)(file)
        .rotate() // apply the camera's rotation, same as for the copy
        .resize({ width: COMPARE_MAX_SIDE, height: COMPARE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .toColourspace("srgb") // make sure it is colour, not grey
        .ensureAlpha() // always 4 values per dot
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}
// Make a smaller copy of "originalFile" at "smallerFile" and score it.
// The original is only READ, never changed.
async function makeSmallerCopy(originalFile, smallerFile) {
    fs_1.default.mkdirSync(path_1.default.dirname(smallerFile), { recursive: true });
    const isPng = path_1.default.extname(originalFile).toLowerCase() === ".png";
    // .rotate() fixes sideways photos; .keepIccProfile() keeps the colours right.
    let pipeline = (0, sharp_1.default)(originalFile).rotate().keepIccProfile();
    pipeline = isPng
        ? pipeline.png({ compressionLevel: 9, effort: 7 }) // PNG: lossless
        : pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }); // JPG: lossy
    await pipeline.toFile(smallerFile);
    (0, logger_1.log)(`  smaller copy written, now comparing: ${path_1.default.basename(smallerFile)}`);
    // Compare original and smaller copy.
    const a = await readPixels(originalFile);
    const b = await readPixels(smallerFile);
    if (a.width !== b.width || a.height !== b.height) {
        throw new Error("The smaller copy has a different size in pixels. Not safe to use.");
    }
    const toImage = (p) => ({
        data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength),
        width: p.width,
        height: p.height,
    });
    const result = (0, ssim_js_1.default)(toImage(a), toImage(b), { ssim: "fast", downsample: false });
    (0, logger_1.log)(`  comparison done: SSIM ${result.mssim}`);
    return {
        sizeBytes: fs_1.default.statSync(smallerFile).size,
        ssim: Math.round(result.mssim * 10000) / 10000,
    };
}
