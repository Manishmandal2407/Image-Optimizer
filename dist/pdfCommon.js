"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_PICTURE_SAVING = exports.MIN_PICTURE_BYTES = exports.JPEG_QUALITY = void 0;
exports.openPdf = openPdf;
exports.examine = examine;
exports.recompressJpeg = recompressJpeg;
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const pdf_lib_1 = require("pdf-lib");
// Shared helpers for looking inside PDFs. Used by the PDF check
// (pdfReport.ts) and by the smaller-copy maker (pdfOptimizer.ts).
// Everything here only READS.
sharp_1.default.cache(false);
exports.JPEG_QUALITY = 85; // same quality we use for JPG images
exports.MIN_PICTURE_BYTES = 50 * 1024; // pictures smaller than this are left alone
exports.MIN_PICTURE_SAVING = 0.05; // a picture must get at least 5% smaller, or we keep the original
async function openPdf(fullPath) {
    let doc;
    try {
        const bytes = fs_1.default.readFileSync(fullPath);
        // Fastest parse speed: otherwise pdf-lib pauses between small chunks.
        // updateMetadata false: we do not touch the author, dates or producer.
        doc = await pdf_lib_1.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: pdf_lib_1.ParseSpeeds.Fastest });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // (The message check is a backup, because "instanceof" can fail for errors made by pdf-lib.)
        if (err instanceof pdf_lib_1.EncryptedPDFError || /is encrypted/i.test(message)) {
            return { ok: false, group: "skipped", reason: "Password-protected" };
        }
        return { ok: false, group: "unreadable", reason: `Could not open it (${message})` };
    }
    // A damaged file can "open" but have no page tree at all.
    if (!doc.catalog)
        return { ok: false, group: "unreadable", reason: "Could not open it (the file is damaged)" };
    return { ok: true, doc };
}
// ---------- reading the parts of a picture's description ----------
// The name stored under a key, for example "/DCTDecode". Empty text if missing.
function nameAt(dict, key) {
    const value = dict.lookup(pdf_lib_1.PDFName.of(key));
    return value instanceof pdf_lib_1.PDFName ? value.toString() : "";
}
// All filter names of a picture, for example ["/DCTDecode"].
function filtersOf(dict) {
    const value = dict.lookup(pdf_lib_1.PDFName.of("Filter"));
    if (value instanceof pdf_lib_1.PDFName)
        return [value.toString()];
    if (value instanceof pdf_lib_1.PDFArray) {
        const names = [];
        for (let i = 0; i < value.size(); i++) {
            const item = value.lookup(i);
            if (item instanceof pdf_lib_1.PDFName)
                names.push(item.toString());
        }
        return names;
    }
    return [];
}
// How many colour channels the picture has, if it uses plain RGB (3) or grey (1) colours.
// CMYK and other colour spaces return 0: we skip those on purpose.
function colourChannels(dict) {
    const space = dict.lookup(pdf_lib_1.PDFName.of("ColorSpace"));
    if (space instanceof pdf_lib_1.PDFName) {
        const n = space.toString();
        if (n === "/DeviceRGB" || n === "/CalRGB")
            return 3;
        if (n === "/DeviceGray" || n === "/CalGray")
            return 1;
        return 0;
    }
    if (space instanceof pdf_lib_1.PDFArray && space.size() >= 2) {
        const first = space.lookup(0);
        if (first instanceof pdf_lib_1.PDFName && first.toString() === "/ICCBased") {
            const profile = space.lookup(1);
            if (profile instanceof pdf_lib_1.PDFRawStream) {
                const n = profile.dict.lookup(pdf_lib_1.PDFName.of("N"));
                if (n instanceof pdf_lib_1.PDFNumber && n.asNumber() === 1)
                    return 1;
                if (n instanceof pdf_lib_1.PDFNumber && n.asNumber() === 3)
                    return 3;
            }
        }
    }
    return 0;
}
function numberAt(dict, key) {
    const value = dict.lookup(pdf_lib_1.PDFName.of(key));
    return value instanceof pdf_lib_1.PDFNumber ? value.asNumber() : 0;
}
function examine(doc) {
    const form = doc.catalog.lookupMaybe(pdf_lib_1.PDFName.of("AcroForm"), pdf_lib_1.PDFDict);
    const fields = form?.lookupMaybe(pdf_lib_1.PDFName.of("Fields"), pdf_lib_1.PDFArray);
    const hasForm = !!fields && fields.size() > 0;
    let signed = false;
    let pictureCount = 0;
    const shrinkable = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        const dict = obj instanceof pdf_lib_1.PDFRawStream ? obj.dict : obj instanceof pdf_lib_1.PDFDict ? obj : undefined;
        if (!dict)
            continue;
        const type = nameAt(dict, "Type");
        if (type === "/Sig" || type === "/DocTimeStamp")
            signed = true;
        if (obj instanceof pdf_lib_1.PDFRawStream && nameAt(dict, "Subtype") === "/Image") {
            pictureCount++;
            const filters = filtersOf(dict);
            const isJpeg = filters.length === 1 && (filters[0] === "/DCTDecode" || filters[0] === "/DCT");
            const isMask = dict.lookup(pdf_lib_1.PDFName.of("ImageMask"))?.toString() === "true";
            const hasDecode = dict.lookup(pdf_lib_1.PDFName.of("Decode")) !== undefined;
            const channels = colourChannels(dict);
            const width = numberAt(dict, "Width");
            const height = numberAt(dict, "Height");
            if (isJpeg && !isMask && !hasDecode && channels !== 0 && width > 0 && height > 0 && obj.contents.length >= exports.MIN_PICTURE_BYTES) {
                shrinkable.push({ ref, stream: obj, width, height, channels });
            }
        }
    }
    return { hasForm, signed, pictureCount, shrinkable };
}
// ---------- making one picture smaller ----------
// Recompress one JPEG picture. Returns the new JPEG data, or null if we should
// keep the original picture (it cannot be read, would change, or saves under 5%).
// The new picture always has the same size in pixels and the same colour type.
async function recompressJpeg(data, p) {
    const isGrey = p.channels === 1; // read once here, before the checks below
    try {
        const input = Buffer.from(data);
        const before = await (0, sharp_1.default)(input, { failOn: "none" }).metadata();
        if (before.format !== "jpeg" || before.width !== p.width || before.height !== p.height || before.channels !== p.channels) {
            return null;
        }
        // Baseline JPEG (not progressive), the type every PDF viewer and printer understands.
        // (A grey picture must stay grey: sharp would otherwise turn it into a 3-colour one.)
        let pipeline = (0, sharp_1.default)(input, { failOn: "none" }).keepIccProfile();
        if (isGrey)
            pipeline = pipeline.toColourspace("b-w");
        const out = await pipeline.jpeg({ quality: exports.JPEG_QUALITY, progressive: false }).toBuffer();
        const after = await (0, sharp_1.default)(out).metadata();
        if (after.format !== "jpeg" || after.width !== p.width || after.height !== p.height || after.channels !== p.channels) {
            return null;
        }
        if (out.length > data.length * (1 - exports.MIN_PICTURE_SAVING))
            return null;
        return out;
    }
    catch {
        return null;
    }
}
