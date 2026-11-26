"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarize = summarize;
exports.pageOf = pageOf;
exports.rangeCount = rangeCount;
const state_1 = require("./state");
// The size the file had before we did anything to it.
function originalSize(img) {
    return img.outcome?.action === "replaced" ? img.outcome.beforeBytes : img.sizeBytes;
}
// How many bytes the smaller copy saves (0 if there is no smaller copy yet).
function savingBytes(img) {
    return img.smaller ? Math.max(0, originalSize(img) - img.smaller.sizeBytes) : 0;
}
// Biggest saving first; images without a smaller copy come last, biggest file first.
function biggestSavingFirst(a, b) {
    if (!!a.smaller !== !!b.smaller)
        return a.smaller ? -1 : 1;
    if (a.smaller && b.smaller)
        return savingBytes(b) - savingBytes(a);
    return originalSize(b) - originalSize(a);
}
function summarize(images) {
    const s = {
        count: images.length, totalBytes: 0, baseBytes: 0, readyCount: 0, replacedCount: 0,
        keptCount: 0, decidedCount: 0, greenWaiting: 0, savedBytes: 0, couldSave: 0,
    };
    for (const img of images) {
        const o = img.outcome;
        s.totalBytes += img.sizeBytes;
        s.baseBytes += originalSize(img);
        if (img.smaller)
            s.readyCount++;
        if (o?.action === "replaced") {
            s.replacedCount++;
            s.savedBytes += o.beforeBytes - o.afterBytes;
        }
        if (o?.action === "kept")
            s.keptCount++;
        if (o && o.action !== "failed")
            s.decidedCount++;
        if (!o && (0, state_1.suggestFor)(img) === "green")
            s.greenWaiting++;
        const open = !o || o.action === "restored" || o.action === "failed";
        if (img.smaller && open)
            s.couldSave += Math.max(0, originalSize(img) - img.smaller.sizeBytes);
    }
    return s;
}
function pageOf(images, view, page, size) {
    let rows;
    if (view === "review") {
        rows = images.filter((img) => img.smaller).sort(biggestSavingFirst);
    }
    else if (view === "results") {
        // Files with a decision first, then the biggest savings.
        rows = [...images].sort((a, b) => Number(!!b.outcome) - Number(!!a.outcome) || biggestSavingFirst(a, b));
    }
    else {
        rows = [...images].sort(biggestSavingFirst);
    }
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const now = Math.min(Math.max(1, page), pages); // never past the last page
    const start = (now - 1) * size;
    return { total: rows.length, page: now, items: (0, state_1.withSuggestions)(rows.slice(start, start + size)) };
}
// How many images "Replace by saving" would replace (same rule as the server uses to do it).
function rangeCount(images, from, to, minSsim) {
    return images.filter((img) => !img.outcome &&
        img.smaller !== undefined &&
        img.smaller.savingPercent >= from &&
        img.smaller.savingPercent <= to &&
        img.smaller.ssim >= minSsim).length;
}
