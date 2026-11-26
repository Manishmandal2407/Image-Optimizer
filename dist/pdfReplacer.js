"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.smallerPdfPath = smallerPdfPath;
exports.useSmallerPdf = useSmallerPdf;
exports.restorePdf = restorePdf;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const paths_1 = require("./paths");
const format_1 = require("./format");
const logger_1 = require("./logger");
const replacer_1 = require("./replacer");
const pdfCommon_1 = require("./pdfCommon");
// Open a PDF and return its page count. Throws a plain-words error if it cannot be opened.
async function pageCount(file) {
    const r = await (0, pdfCommon_1.openPdf)(file);
    if (!r.ok)
        throw new Error(r.reason);
    return r.doc.getPageCount();
}
// Where the smaller test copy of a PDF lives.
function smallerPdfPath(config, relativePath) {
    return (0, paths_1.safeJoin)(path_1.default.join(config.workFolder, "pdf"), relativePath);
}
// ---------- USE SMALLER VERSION (PDF) ----------
async function useSmallerPdf(config, doc) {
    const original = (0, paths_1.safeJoin)(config.imagesFolder, doc.relativePath);
    const smaller = smallerPdfPath(config, doc.relativePath);
    const vaultFile = (0, paths_1.safeJoin)(config.vaultFolder, doc.relativePath);
    // Checks before we touch anything.
    if (!doc.smaller)
        throw new Error("There is no smaller copy yet. Click Make smaller copy first.");
    if (doc.outcome?.action === "replaced")
        throw new Error("This PDF was already replaced.");
    if (!fs_1.default.existsSync(original) || fs_1.default.statSync(original).size !== doc.sizeBytes) {
        throw new Error("The PDF changed or disappeared since the smaller copy was made. Click Make again.");
    }
    const originalHash = await (0, replacer_1.sha256)(original);
    if (originalHash !== doc.smaller.originalSha256) {
        throw new Error("The PDF changed since the smaller copy was made. Click Make again.");
    }
    if (!fs_1.default.existsSync(smaller) || fs_1.default.statSync(smaller).size !== doc.smaller.sizeBytes) {
        throw new Error("The smaller copy is missing or changed. Click Make again.");
    }
    const pages = await pageCount(original);
    if ((await pageCount(smaller)) !== pages)
        throw new Error("The smaller copy has a different number of pages. Not safe to use.");
    const smallerHash = await (0, replacer_1.sha256)(smaller);
    // a) Copy the original into the vault and check the copy is identical.
    fs_1.default.mkdirSync(path_1.default.dirname(vaultFile), { recursive: true });
    if (fs_1.default.existsSync(vaultFile)) {
        if ((await (0, replacer_1.sha256)(vaultFile)) !== originalHash) {
            throw new Error(`The vault already holds a different file at ${vaultFile}. It was NOT overwritten. ` +
                `Move or rename that vault file and try again.`);
        }
        (0, logger_1.log)("  vault already has an identical copy, reusing it");
    }
    else {
        fs_1.default.copyFileSync(original, vaultFile, fs_1.default.constants.COPYFILE_EXCL);
        if ((await (0, replacer_1.sha256)(vaultFile)) !== originalHash) {
            fs_1.default.rmSync(vaultFile); // remove the bad copy (it is OUR file in the vault)
            throw new Error("The vault copy did not match the original (SHA-256). Nothing was changed.");
        }
    }
    (0, logger_1.log)("  a) original PDF is safe in the vault and checked");
    // b) + c) Smaller file next to the original under a temporary name, then swap.
    await (0, replacer_1.copyAndSwap)(smaller, original, smallerHash, "sso-new");
    (0, logger_1.log)("  b,c) smaller PDF swapped in under the same name");
    // d) The new file must be exactly the vetted copy, and open with the same pages.
    try {
        if ((await (0, replacer_1.sha256)(original)) !== smallerHash)
            throw new Error("the new file is not identical to the smaller copy");
        if ((await pageCount(original)) !== pages)
            throw new Error("the new file has a different number of pages");
        (0, logger_1.log)("  d) new PDF checked: it opens and matches");
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        (0, logger_1.log)(`  d) CHECK FAILED (${reason}), putting the original back`);
        try {
            await (0, replacer_1.copyAndSwap)(vaultFile, original, originalHash, "sso-back");
        }
        catch {
            throw new Error(`The new file failed its check (${reason}) AND putting the original back failed. ` +
                `Your original is safe in the vault: ${vaultFile}. Copy it back by hand.`);
        }
        throw new Error(`The new file failed its check (${reason}). The original was put back from the vault.`);
    }
    const afterBytes = fs_1.default.statSync(original).size;
    return {
        action: "replaced",
        at: new Date().toISOString(),
        beforeBytes: doc.sizeBytes,
        afterBytes,
        originalSha256: originalHash,
        message: `Replaced with the smaller version. Saved ${(0, format_1.formatBytes)(doc.sizeBytes - afterBytes)}. Original is in the vault.`,
    };
}
// ---------- RESTORE ORIGINAL (PDF) ----------
async function restorePdf(config, doc) {
    const o = doc.outcome;
    if (!o || o.action !== "replaced" || !o.originalSha256) {
        throw new Error("This PDF was not replaced by this app, so there is nothing to restore.");
    }
    const live = (0, paths_1.safeJoin)(config.imagesFolder, doc.relativePath);
    const vaultFile = (0, paths_1.safeJoin)(config.vaultFolder, doc.relativePath);
    if (!fs_1.default.existsSync(vaultFile))
        throw new Error(`The vault copy is missing: ${vaultFile}`);
    if ((await (0, replacer_1.sha256)(vaultFile)) !== o.originalSha256) {
        throw new Error(`The vault copy does not match what was saved (SHA-256). Not restoring. File: ${vaultFile}`);
    }
    if (fs_1.default.existsSync(live) && fs_1.default.statSync(live).size !== o.afterBytes) {
        throw new Error(`The file was changed after it was replaced, so it was NOT overwritten. ` +
            `The original is safe in the vault: ${vaultFile}`);
    }
    await (0, replacer_1.copyAndSwap)(vaultFile, live, o.originalSha256, "sso-back");
    if ((await (0, replacer_1.sha256)(live)) !== o.originalSha256) {
        throw new Error(`The restored file did not match the original. The original is safe in the vault: ${vaultFile}`);
    }
    await pageCount(live); // must open as a PDF
    const afterBytes = fs_1.default.statSync(live).size;
    return {
        action: "restored",
        at: new Date().toISOString(),
        beforeBytes: o.afterBytes,
        afterBytes,
        message: "Original restored from the vault and checked.",
    };
}
