"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSmallerPdf = makeSmallerPdf;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const ssim_js_1 = __importDefault(require("ssim.js"));
const pdf_lib_1 = require("pdf-lib");
const pdfCommon_1 = require("./pdfCommon");
const pdfVerify_1 = require("./pdfVerify");
const logger_1 = require("./logger");
// Makes a smaller copy of a PDF in the work folder. ONLY the big JPEG pictures
// inside are made smaller. Everything else in the PDF is copied as it is.
// The original PDF is only READ, never changed.
// Same reduced-size comparison as for images, to save memory.
const COMPARE_MAX_SIDE = 1600;
const MIN_PDF_SAVING = 0.05; // the whole PDF must get at least 5% smaller, or we make no copy
// A JPEG picture as raw pixels, so two pictures can be compared dot by dot.
async function readPixels(jpeg) {
    const { data, info } = await (0, sharp_1.default)(Buffer.from(jpeg), { failOn: "none" })
        .resize({ width: COMPARE_MAX_SIDE, height: COMPARE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}
async function pictureSsim(before, after) {
    const a = await readPixels(before);
    const b = await readPixels(after);
    if (a.width !== b.width || a.height !== b.height)
        throw new Error("A shrunk picture changed size.");
    const toImage = (p) => ({
        data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength),
        width: p.width,
        height: p.height,
    });
    return (0, ssim_js_1.default)(toImage(a), toImage(b), { ssim: "fast", downsample: false }).mssim;
}
async function makeSmallerPdf(originalFile, smallerFile) {
    const opened = await (0, pdfCommon_1.openPdf)(originalFile);
    if (!opened.ok)
        return { made: false, reason: opened.reason };
    const doc = opened.doc;
    const found = (0, pdfCommon_1.examine)(doc);
    if (found.hasForm)
        return { made: false, reason: "Skipped: the PDF has form fields." };
    if (found.signed)
        return { made: false, reason: "Skipped: the PDF is digitally signed." };
    if (found.shrinkable.length === 0)
        return { made: false, reason: "No JPEG picture of 50 KB or more to shrink." };
    // Shrink the pictures one at a time.
    let lowestSsim = 1;
    let shrunk = 0;
    const shrunkRefs = []; // the pictures we replaced, for the safety check
    for (const picture of found.shrinkable) {
        const smaller = await (0, pdfCommon_1.recompressJpeg)(picture.stream.contents, picture);
        if (!smaller)
            continue; // keep this picture as it is
        const score = await pictureSsim(picture.stream.contents, smaller);
        lowestSsim = Math.min(lowestSsim, score);
        // Put the new picture data in place. Its description (size, colours) stays the same.
        doc.context.assign(picture.ref, pdf_lib_1.PDFRawStream.of(picture.stream.dict, smaller));
        shrunk++;
        shrunkRefs.push(picture.ref.tag);
        (0, logger_1.log)(`  PDF picture shrunk: ${picture.stream.contents.length} to ${smaller.length} bytes, SSIM ${score.toFixed(4)}`);
    }
    if (shrunk === 0)
        return { made: false, reason: "No picture could be made at least 5% smaller." };
    // Save the new PDF under a temporary name first, so a half-written file is never left behind.
    const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: Infinity });
    const originalSize = fs_1.default.statSync(originalFile).size;
    if (bytes.length > originalSize * (1 - MIN_PDF_SAVING)) {
        return { made: false, reason: "The whole PDF would get less than 5% smaller, so it is not worth changing." };
    }
    fs_1.default.mkdirSync(path_1.default.dirname(smallerFile), { recursive: true });
    const tempFile = `${smallerFile}.tmp`;
    fs_1.default.writeFileSync(tempFile, bytes);
    // SAFETY CHECK on the file we just wrote. If anything is wrong, no copy is kept.
    const check = await (0, pdfVerify_1.verifySmallerPdf)(originalFile, tempFile, shrunkRefs);
    if (!check.ok) {
        fs_1.default.unlinkSync(tempFile);
        (0, logger_1.log)(`  PDF safety check FAILED: ${check.problems.join(" ")}`);
        return { made: false, reason: `Safety check failed, so no copy was kept. ${check.problems.join(" ")}` };
    }
    (0, logger_1.log)(`  PDF safety check passed: ${check.pages} page(s), ${check.partsChecked} parts identical, ${check.picturesChecked} picture(s)`);
    fs_1.default.renameSync(tempFile, smallerFile);
    return {
        made: true,
        sizeBytes: bytes.length,
        savingPercent: Math.round(((originalSize - bytes.length) / originalSize) * 1000) / 10,
        ssim: Math.round(lowestSsim * 10000) / 10000,
        picturesShrunk: shrunk,
        picturesFound: found.pictureCount,
        checks: { pages: check.pages, partsChecked: check.partsChecked, picturesChecked: check.picturesChecked },
    };
}
