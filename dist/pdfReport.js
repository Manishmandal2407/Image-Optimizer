"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PDF_MIN_SIZE_BYTES = void 0;
exports.inspectPdf = inspectPdf;
exports.buildPdfReport = buildPdfReport;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pdfCommon_1 = require("./pdfCommon");
// PDF CHECK (read-only). It looks inside PDFs and estimates how much the
// pictures could shrink. It never changes, moves or deletes any file.
exports.PDF_MIN_SIZE_BYTES = 500 * 1024; // PDFs smaller than this are not checked
const INSPECT_LIMIT = 300; // check at most this many PDFs (a spread-out sample if there are more)
const PICTURE_WORTH_BYTES = 200 * 1024; // a PDF needs this much JPEG picture data to be "worth shrinking"
function findPdfs(rootFolder, warnings) {
    const found = [];
    function walk(folder) {
        let entries;
        try {
            entries = fs_1.default.readdirSync(folder, { withFileTypes: true });
        }
        catch {
            warnings.push(`Could not open folder: ${folder}`);
            return;
        }
        for (const entry of entries) {
            const fullPath = path_1.default.join(folder, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (entry.isFile() && path_1.default.extname(entry.name).toLowerCase() === ".pdf") {
                try {
                    found.push({
                        fullPath,
                        relativePath: path_1.default.relative(rootFolder, fullPath),
                        sizeBytes: fs_1.default.statSync(fullPath).size,
                    });
                }
                catch {
                    warnings.push(`Could not read file: ${fullPath}`);
                }
            }
        }
    }
    walk(rootFolder);
    return found;
}
function result(group, reason, pictureCount = 0, pictureBytes = 0, estimatedSaving = 0) {
    return { group, reason, pictureCount, pictureBytes, estimatedSaving };
}
async function inspectPdf(fullPath) {
    const opened = await (0, pdfCommon_1.openPdf)(fullPath);
    if (!opened.ok)
        return result(opened.group, opened.reason);
    try {
        const found = (0, pdfCommon_1.examine)(opened.doc);
        if (found.hasForm)
            return result("skipped", "Has form fields");
        // Signed PDFs are skipped: changing them breaks the signature.
        if (found.signed)
            return result("skipped", "Digitally signed");
        const pictureBytes = found.shrinkable.reduce((sum, p) => sum + p.stream.contents.length, 0);
        if (found.pictureCount === 0)
            return result("no-pictures", "No pictures inside");
        if (pictureBytes < PICTURE_WORTH_BYTES) {
            return result("small-pictures", `${found.pictureCount} picture(s), but too small or in a format we cannot shrink`, found.pictureCount, pictureBytes);
        }
        // Estimate the saving: recompress each JPEG the same way the real copy will be made
        // (same quality, same size in pixels) and add up the difference.
        let saving = 0;
        for (const p of found.shrinkable) {
            const smaller = await (0, pdfCommon_1.recompressJpeg)(p.stream.contents, p);
            if (smaller)
                saving += p.stream.contents.length - smaller.length;
        }
        return result("worth", `${found.shrinkable.length} JPEG picture(s) to shrink`, found.pictureCount, pictureBytes, saving);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return result("unreadable", `Could not read it (${message})`);
    }
}
// ---------- step 3: put the numbers together ----------
function emptyGroups() {
    const none = () => ({ count: 0, bytes: 0, estimatedSaving: 0 });
    return { worth: none(), "small-pictures": none(), "no-pictures": none(), skipped: none(), unreadable: none() };
}
async function buildPdfReport(rootFolder) {
    const started = Date.now();
    const warnings = [];
    const all = findPdfs(rootFolder, warnings);
    const eligible = all.filter((f) => f.sizeBytes >= exports.PDF_MIN_SIZE_BYTES).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const sum = (list) => list.reduce((s, f) => s + f.sizeBytes, 0);
    // Too many PDFs? Check an evenly spread-out sample, so the numbers stay representative.
    let chosen = eligible;
    if (eligible.length > INSPECT_LIMIT) {
        chosen = [];
        const step = eligible.length / INSPECT_LIMIT;
        for (let i = 0; i < INSPECT_LIMIT; i++)
            chosen.push(eligible[Math.floor(i * step)]);
    }
    const groups = emptyGroups();
    const files = [];
    for (const f of chosen) {
        const r = await inspectPdf(f.fullPath);
        files.push({ relativePath: f.relativePath, sizeBytes: f.sizeBytes, ...r });
        groups[r.group].count++;
        groups[r.group].bytes += f.sizeBytes;
        groups[r.group].estimatedSaving += r.estimatedSaving;
    }
    const estimatedSavingChecked = files.reduce((s, f) => s + f.estimatedSaving, 0);
    const checkedBytes = sum(chosen);
    const eligibleBytes = sum(eligible);
    // Scale by size: saving per checked byte times all eligible bytes.
    const estimatedSavingAll = chosen.length === eligible.length || checkedBytes === 0
        ? estimatedSavingChecked
        : Math.round((estimatedSavingChecked / checkedBytes) * eligibleBytes);
    const small = all.filter((f) => f.sizeBytes < exports.PDF_MIN_SIZE_BYTES);
    return {
        pdfCount: all.length,
        pdfBytes: sum(all),
        tooSmallCount: small.length,
        tooSmallBytes: sum(small),
        eligibleCount: eligible.length,
        eligibleBytes,
        checkedCount: chosen.length,
        checkedBytes,
        sampled: chosen.length < eligible.length,
        groups,
        estimatedSavingChecked,
        estimatedSavingAll,
        biggest: files.filter((f) => f.group === "worth").sort((a, b) => b.estimatedSaving - a.estimatedSaving).slice(0, 20),
        warnings,
        seconds: Math.round((Date.now() - started) / 1000),
    };
}
