"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.saveState = saveState;
exports.mergeScan = mergeScan;
exports.mergeDocScan = mergeDocScan;
exports.suggestFor = suggestFor;
exports.withSuggestions = withSuggestions;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dataFolder = path_1.default.join(__dirname, "..", "data");
const stateFile = path_1.default.join(dataFolder, "state.json");
// Read state.json. If it does not exist yet, return an empty state.
function loadState() {
    if (!fs_1.default.existsSync(stateFile)) {
        return { lastScan: null, images: [], documents: [] };
    }
    const state = JSON.parse(fs_1.default.readFileSync(stateFile, "utf8"));
    if (!state.documents)
        state.documents = []; // state.json from before PDFs were added
    return state;
}
// Save state.json. Two things keep it fast and safe when the list is long:
//  - no indentation (the file is about half the size and much quicker to write)
//  - we write a temporary file first and then swap it in, so a crash in the
//    middle of saving can never leave a half-written state.json
function saveState(state) {
    fs_1.default.mkdirSync(dataFolder, { recursive: true });
    const temp = stateFile + ".tmp";
    fs_1.default.writeFileSync(temp, JSON.stringify(state));
    fs_1.default.renameSync(temp, stateFile);
}
// After a new scan: keep what we already know about a file, but only if
// the file's size is unchanged (a changed file needs a fresh smaller copy).
function mergeScan(oldImages, scanned) {
    const oldByPath = new Map(oldImages.map((img) => [img.relativePath, img]));
    return scanned.map((img) => {
        const old = oldByPath.get(img.relativePath);
        return old && old.sizeBytes === img.sizeBytes ? old : img;
    });
}
// Same idea for the PDFs found by a scan.
function mergeDocScan(oldDocs, scanned) {
    const oldByPath = new Map(oldDocs.map((d) => [d.relativePath, d]));
    return scanned.map((d) => {
        const old = oldByPath.get(d.relativePath);
        return old && old.sizeBytes === d.sizeBytes ? old : d;
    });
}
function suggestFor(img) {
    if (!img.smaller)
        return undefined; // no smaller copy yet, nothing to suggest
    if (img.smaller.savingPercent < 5)
        return "red";
    if (img.smaller.ssim >= 0.99)
        return "green";
    return "amber";
}
// Add the suggestion to every image before sending the list to the web page.
function withSuggestions(images) {
    return images.map((img) => ({ ...img, suggestion: suggestFor(img) }));
}
