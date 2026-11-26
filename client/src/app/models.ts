// Shared types and helpers used by more than one screen.

export interface ImageRecord {
  relativePath: string;
  sizeBytes: number;
  smaller?: { sizeBytes: number; savingPercent: number; ssim: number };
  error?: string;
  suggestion?: 'green' | 'amber' | 'red';
  outcome?: {
    action: 'replaced' | 'kept' | 'restored' | 'failed';
    at: string;
    beforeBytes: number;
    afterBytes: number;
    message: string;
  };
}

// Turn 2345678 into "2.24 MB".
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// "holiday\\beach\\photo1.jpg" -> "photo1.jpg"
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// "holiday\\beach\\photo1.jpg" -> "holiday / beach"
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.length > 0 ? parts.join(' / ') : 'Main folder';
}

// Small preview picture from the server (the "v" makes the browser reload it after a replace).
export function thumbUrl(img: ImageRecord): string {
  return `/api/thumb?path=${encodeURIComponent(img.relativePath)}&v=${img.sizeBytes}`;
}

// The size the file had before we did anything to it.
export function originalSize(img: ImageRecord): number {
  return img.outcome?.action === 'replaced' ? img.outcome.beforeBytes : img.sizeBytes;
}

// A coloured label that says what state an image is in.
export interface Pill { text: string; cls: string }
export function statusPill(img: ImageRecord): Pill {
  const o = img.outcome;
  if (o?.action === 'replaced') return { text: 'Replaced', cls: 'blue' };
  if (o?.action === 'kept') return { text: 'Kept original', cls: 'grey' };
  if (o?.action === 'restored') return { text: 'Restored', cls: 'grey' };
  if (o?.action === 'failed') return { text: 'Failed', cls: 'red' };
  if (img.error) return { text: 'Error', cls: 'red' };
  if (img.smaller) {
    if (img.suggestion === 'green') return { text: 'Looks the same', cls: 'green' };
    if (img.suggestion === 'amber') return { text: 'Check this one', cls: 'amber' };
    return { text: 'Keep original', cls: 'red' };
  }
  if (img.sizeBytes < 500 * 1024) return { text: 'Under 500 KB', cls: 'grey' };
  return { text: 'Not compressed yet', cls: 'grey' };
}

// A short plain-words meaning for an SSIM score (1 = identical, lower = more different).
export function ssimVerdict(ssim: number): string {
  if (ssim >= 0.9999) return 'Identical';
  if (ssim >= 0.99) return 'Looks the same';
  if (ssim >= 0.95) return 'Small differences';
  if (ssim >= 0.9) return 'Some visible differences';
  return 'Clearly different';
}

// One sentence that explains what a score means for this picture.
export function ssimMeaning(ssim: number): string {
  if (ssim >= 0.9999) return 'Identical. Every pixel matches the original.';
  if (ssim >= 0.99) return 'Looks the same. Any differences are too small to see.';
  if (ssim >= 0.95) return 'Small differences. You may notice them when you zoom in.';
  if (ssim >= 0.9) return 'Some visible differences. Compare the two pictures carefully.';
  return 'Clearly different. This copy has changed a lot.';
}

// Where the marker goes on the scale from 0.90 (left) to 1.00 (right), in %.
export function ssimPosition(ssim: number): number {
  return Math.min(100, Math.max(0, ((ssim - 0.9) / 0.1) * 100));
}

// Which colour band a score falls in (the CSS classes are in styles.css).
export function ssimBand(ssim: number): string {
  if (ssim >= 0.9999) return 'band-identical';
  if (ssim >= 0.99) return 'band-same';
  if (ssim >= 0.95) return 'band-small';
  if (ssim >= 0.9) return 'band-some';
  return 'band-clear';
}

// How many bytes the smaller copy saves (0 if there is no smaller copy yet).
export function savingBytes(img: ImageRecord): number {
  return img.smaller ? Math.max(0, originalSize(img) - img.smaller.sizeBytes) : 0;
}

// Sort order for the lists: biggest saving first.
// Images that have no smaller copy yet come last, biggest file first.
export function biggestSavingFirst(a: ImageRecord, b: ImageRecord): number {
  if (!!a.smaller !== !!b.smaller) return a.smaller ? -1 : 1;
  if (a.smaller && b.smaller) return savingBytes(b) - savingBytes(a);
  return originalSize(b) - originalSize(a);
}

// ---- the PDF check (see src/pdfReport.ts on the server) ----
export type PdfGroup = 'worth' | 'small-pictures' | 'no-pictures' | 'skipped' | 'unreadable';

export interface PdfFileReport {
  relativePath: string;
  sizeBytes: number;
  group: PdfGroup;
  reason: string;
  pictureCount: number;
  pictureBytes: number;
  estimatedSaving: number;
}

export interface PdfGroupTotals { count: number; bytes: number; estimatedSaving: number }

export interface PdfReport {
  pdfCount: number;
  pdfBytes: number;
  tooSmallCount: number;
  tooSmallBytes: number;
  eligibleCount: number;
  eligibleBytes: number;
  checkedCount: number;
  checkedBytes: number;
  sampled: boolean;
  groups: Record<PdfGroup, PdfGroupTotals>;
  estimatedSavingChecked: number;
  estimatedSavingAll: number;
  biggest: PdfFileReport[];
  warnings: string[];
  seconds: number;
}

// The answer of "Make smaller copy" for one PDF (see src/pdfOptimizer.ts on the server).
export interface PdfPrepareResult {
  made: boolean;
  reason?: string; // when no copy was made
  sizeBytes?: number;
  savingPercent?: number;
  ssim?: number; // the lowest similarity of all shrunk pictures
  picturesShrunk?: number;
  picturesFound?: number;
  checks?: { pages: number; partsChecked: number; picturesChecked: number }; // what the safety check confirmed
  workFile?: string; // where the test copy is, inside the work folder
  documents?: PdfDoc[]; // everything the server remembers about PDFs
}

// What the server remembers about one PDF we made a smaller copy of (see src/state.ts).
export interface PdfDoc {
  relativePath: string;
  sizeBytes: number;
  smaller?: { sizeBytes: number; savingPercent: number; ssim: number; picturesShrunk: number; picturesFound: number };
  noCopyReason?: string; // why no smaller copy was made
  error?: string;
  outcome?: ImageRecord['outcome'];
}

// The totals the server calculates for the left side of the page (see src/listing.ts).
export interface Summary {
  count: number;
  totalBytes: number;
  baseBytes: number;
  readyCount: number;
  replacedCount: number;
  keptCount: number;
  decidedCount: number;
  greenWaiting: number;
  savedBytes: number;
  couldSave: number;
}

// One page of a list, as the server sends it.
export interface ListPage {
  total: number; // rows in the whole list
  page: number;  // the page this is (1 is the first)
  items: ImageRecord[];
}

export const EMPTY_SUMMARY: Summary = {
  count: 0, totalBytes: 0, baseBytes: 0, readyCount: 0, replacedCount: 0,
  keptCount: 0, decidedCount: 0, greenWaiting: 0, savedBytes: 0, couldSave: 0,
};
export const EMPTY_PAGE: ListPage = { total: 0, page: 1, items: [] };

// ---- PDFs shown like images (Documents list and PDF review) ----

// The size the PDF had before we did anything to it.
export function pdfOriginalSize(d: PdfDoc): number {
  return d.outcome?.action === 'replaced' ? d.outcome.beforeBytes : d.sizeBytes;
}

export function pdfSavingBytes(d: PdfDoc): number {
  return d.smaller ? Math.max(0, pdfOriginalSize(d) - d.smaller.sizeBytes) : 0;
}

// green = looks the same (SSIM 0.99 or higher, saves 5% or more), amber = check it, red = not worth it.
export function pdfSuggestion(d: PdfDoc): 'green' | 'amber' | 'red' | undefined {
  if (!d.smaller) return undefined;
  if (d.smaller.savingPercent < 5) return 'red';
  if (d.smaller.ssim >= 0.99) return 'green';
  return 'amber';
}

// Biggest saving first; PDFs without a smaller copy come last, biggest file first.
export function pdfBiggestSavingFirst(a: PdfDoc, b: PdfDoc): number {
  if (!!a.smaller !== !!b.smaller) return a.smaller ? -1 : 1;
  if (a.smaller && b.smaller) return pdfSavingBytes(b) - pdfSavingBytes(a);
  return pdfOriginalSize(b) - pdfOriginalSize(a);
}

// A coloured label that says what state a PDF is in.
export function pdfPill(d: PdfDoc): Pill {
  const o = d.outcome;
  if (o?.action === 'replaced') return { text: 'Replaced', cls: 'blue' };
  if (o?.action === 'kept') return { text: 'Kept original', cls: 'grey' };
  if (o?.action === 'restored') return { text: 'Restored', cls: 'grey' };
  if (o?.action === 'failed') return { text: 'Failed', cls: 'red' };
  if (d.error) return { text: 'Error', cls: 'red' };
  if (d.smaller) {
    const s = pdfSuggestion(d);
    if (s === 'green') return { text: 'Looks the same', cls: 'green' };
    if (s === 'amber') return { text: 'Check this one', cls: 'amber' };
    return { text: 'Keep original', cls: 'red' };
  }
  if (d.noCopyReason) return { text: 'Nothing to shrink', cls: 'grey' };
  if (d.sizeBytes < 500 * 1024) return { text: 'Under 500 KB', cls: 'grey' };
  return { text: 'Not compressed yet', cls: 'grey' };
}

// Totals for the PDFs (the same idea as Summary for images).
export interface DocSummary {
  count: number;
  totalBytes: number;
  baseBytes: number;
  readyCount: number;
  replacedCount: number;
  decidedCount: number;
  greenWaiting: number;
  savedBytes: number;
  couldSave: number;
}

export function summarizeDocs(list: PdfDoc[]): DocSummary {
  const s: DocSummary = { count: list.length, totalBytes: 0, baseBytes: 0, readyCount: 0, replacedCount: 0, decidedCount: 0, greenWaiting: 0, savedBytes: 0, couldSave: 0 };
  for (const d of list) {
    const o = d.outcome;
    s.totalBytes += d.sizeBytes;
    s.baseBytes += pdfOriginalSize(d);
    if (d.smaller) s.readyCount++;
    if (o?.action === 'replaced') {
      s.replacedCount++;
      s.savedBytes += o.beforeBytes - o.afterBytes;
    }
    if (o && o.action !== 'failed') s.decidedCount++;
    if (!o && pdfSuggestion(d) === 'green') s.greenWaiting++;
    const open = !o || o.action === 'restored' || o.action === 'failed';
    if (d.smaller && open) s.couldSave += pdfSavingBytes(d);
  }
  return s;
}

// One page of a list (the PDF lists are short, so the browser cuts them into pages itself).
export function pageSlice<T>(list: T[], page: number, size: number): { items: T[]; page: number; total: number } {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const now = Math.min(Math.max(1, page), pages);
  return { items: list.slice((now - 1) * size, now * size), page: now, total: list.length };
}
