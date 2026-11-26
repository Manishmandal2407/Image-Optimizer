"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanFolder = scanFolder;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const PDF_EXTENSION = ".pdf";
// Look through a folder (and its sub-folders) for images and PDFs.
// This only READS. It never changes, moves or deletes anything.
function scanFolder(rootFolder) {
    const images = [];
    const pdfs = [];
    const warnings = [];
    function walk(folder) {
        let entries;
        try {
            entries = fs_1.default.readdirSync(folder, { withFileTypes: true });
        }
        catch (err) {
            warnings.push(`Could not open folder: ${folder}`);
            return;
        }
        for (const entry of entries) {
            const fullPath = path_1.default.join(folder, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath); // go into the sub-folder
            }
            else if (entry.isFile()) {
                const ext = path_1.default.extname(entry.name).toLowerCase();
                const isImage = IMAGE_EXTENSIONS.includes(ext);
                if (isImage || ext === PDF_EXTENSION) {
                    try {
                        const size = fs_1.default.statSync(fullPath).size;
                        const record = { relativePath: path_1.default.relative(rootFolder, fullPath), sizeBytes: size };
                        if (isImage)
                            images.push(record);
                        else
                            pdfs.push(record);
                    }
                    catch {
                        warnings.push(`Could not read file: ${fullPath}`);
                    }
                }
            }
        }
    }
    walk(rootFolder);
    // Biggest files first, because they save the most space.
    images.sort((a, b) => b.sizeBytes - a.sizeBytes);
    pdfs.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { images, pdfs, warnings };
}
