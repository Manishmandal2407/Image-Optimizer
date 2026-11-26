import fs from "fs";
import path from "path";
import { DocRecord, ImageRecord } from "./state";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const PDF_EXTENSION = ".pdf";

export interface ScanResult {
  images: ImageRecord[];
  pdfs: DocRecord[]; // the PDFs (listed only, never opened by the scan)
  warnings: string[]; // folders or files we could not read
}

// Look through a folder (and its sub-folders) for images and PDFs.
// This only READS. It never changes, moves or deletes anything.
export function scanFolder(rootFolder: string): ScanResult {
  const images: ImageRecord[] = [];
  const pdfs: DocRecord[] = [];
  const warnings: string[] = [];

  function walk(folder: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Could not open folder: ${folder}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath); // go into the sub-folder
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const isImage = IMAGE_EXTENSIONS.includes(ext);
        if (isImage || ext === PDF_EXTENSION) {
          try {
            const size = fs.statSync(fullPath).size;
            const record = { relativePath: path.relative(rootFolder, fullPath), sizeBytes: size };
            if (isImage) images.push(record);
            else pdfs.push(record);
          } catch {
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
