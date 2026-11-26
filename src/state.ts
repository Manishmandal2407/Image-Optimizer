import fs from "fs";
import path from "path";

// What happened to an image when you clicked a button.
export interface Outcome {
  action: "replaced" | "kept" | "restored" | "failed";
  at: string;              // when it happened
  beforeBytes: number;     // size before this action
  afterBytes: number;      // size after this action
  message: string;         // plain-English description
  originalSha256?: string; // fingerprint of the original (set when replaced)
}

// One image found by the scan.
export interface ImageRecord {
  relativePath: string; // path inside imagesFolder, e.g. "holiday/photo1.jpg"
  sizeBytes: number;    // size on disk right now
  // Filled in after we make a smaller copy in workFolder:
  smaller?: {
    sizeBytes: number;    // size of the smaller copy
    savingPercent: number; // how much smaller, e.g. 42.5
    ssim: number;         // similarity to the original (1 = identical)
  };
  error?: string;         // plain-English problem, if something failed
  outcome?: Outcome;      // what you decided / what happened (see above)
}

// One PDF we made a smaller copy of (created by "Make smaller copy").
export interface DocRecord {
  relativePath: string; // path inside imagesFolder, e.g. "reports/may.pdf"
  sizeBytes: number;    // size on disk right now
  smaller?: {
    sizeBytes: number;        // size of the smaller copy
    savingPercent: number;
    ssim: number;             // lowest SSIM of the shrunk pictures
    picturesShrunk: number;
    picturesFound: number;
    originalSha256: string;   // fingerprint of the original when the copy was made
  };
  noCopyReason?: string;  // why no smaller copy was made (e.g. no pictures inside)
  error?: string;         // plain-English problem, if something failed
  outcome?: Outcome;      // what you decided / what happened
}

// Everything we remember between runs lives in data/state.json.
export interface State {
  lastScan: string | null; // when the last scan happened
  images: ImageRecord[];
  documents: DocRecord[];  // every PDF found by the scan (plus what we did with it)
}

const dataFolder = path.join(__dirname, "..", "data");
const stateFile = path.join(dataFolder, "state.json");

// Read state.json. If it does not exist yet, return an empty state.
export function loadState(): State {
  if (!fs.existsSync(stateFile)) {
    return { lastScan: null, images: [], documents: [] };
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!state.documents) state.documents = []; // state.json from before PDFs were added
  return state;
}

// Save state.json. Two things keep it fast and safe when the list is long:
//  - no indentation (the file is about half the size and much quicker to write)
//  - we write a temporary file first and then swap it in, so a crash in the
//    middle of saving can never leave a half-written state.json
export function saveState(state: State): void {
  fs.mkdirSync(dataFolder, { recursive: true });
  const temp = stateFile + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, stateFile);
}

// After a new scan: keep what we already know about a file, but only if
// the file's size is unchanged (a changed file needs a fresh smaller copy).
export function mergeScan(oldImages: ImageRecord[], scanned: ImageRecord[]): ImageRecord[] {
  const oldByPath = new Map(oldImages.map((img) => [img.relativePath, img]));
  return scanned.map((img) => {
    const old = oldByPath.get(img.relativePath);
    return old && old.sizeBytes === img.sizeBytes ? old : img;
  });
}

// Same idea for the PDFs found by a scan.
export function mergeDocScan(oldDocs: DocRecord[], scanned: DocRecord[]): DocRecord[] {
  const oldByPath = new Map(oldDocs.map((d) => [d.relativePath, d]));
  return scanned.map((d) => {
    const old = oldByPath.get(d.relativePath);
    return old && old.sizeBytes === d.sizeBytes ? old : d;
  });
}

// Our suggestion for each image, based on the smaller copy:
//   red   = "Keep original" (saving is under 5%, not worth it)
//   green = "Looks the same" (SSIM 0.99 or higher)
//   amber = "Check this one" (SSIM lower than 0.99)
export type Suggestion = "green" | "amber" | "red";

export function suggestFor(img: ImageRecord): Suggestion | undefined {
  if (!img.smaller) return undefined; // no smaller copy yet, nothing to suggest
  if (img.smaller.savingPercent < 5) return "red";
  if (img.smaller.ssim >= 0.99) return "green";
  return "amber";
}

// Add the suggestion to every image before sending the list to the web page.
export function withSuggestions(images: ImageRecord[]) {
  return images.map((img) => ({ ...img, suggestion: suggestFor(img) }));
}
