import fs from "fs";
import sharp from "sharp";
import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  ParseSpeeds,
} from "pdf-lib";

// Shared helpers for looking inside PDFs. Used by the PDF check
// (pdfReport.ts) and by the smaller-copy maker (pdfOptimizer.ts).
// Everything here only READS.

sharp.cache(false);

export const JPEG_QUALITY = 85; // same quality we use for JPG images
export const MIN_PICTURE_BYTES = 50 * 1024; // pictures smaller than this are left alone
export const MIN_PICTURE_SAVING = 0.05; // a picture must get at least 5% smaller, or we keep the original

// ---------- opening a PDF ----------

export type OpenResult =
  | { ok: true; doc: PDFDocument }
  | { ok: false; group: "skipped" | "unreadable"; reason: string };

export async function openPdf(fullPath: string): Promise<OpenResult> {
  let doc: PDFDocument;
  try {
    const bytes = fs.readFileSync(fullPath);
    // Fastest parse speed: otherwise pdf-lib pauses between small chunks.
    // updateMetadata false: we do not touch the author, dates or producer.
    doc = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // (The message check is a backup, because "instanceof" can fail for errors made by pdf-lib.)
    if (err instanceof EncryptedPDFError || /is encrypted/i.test(message)) {
      return { ok: false, group: "skipped", reason: "Password-protected" };
    }
    return { ok: false, group: "unreadable", reason: `Could not open it (${message})` };
  }
  // A damaged file can "open" but have no page tree at all.
  if (!doc.catalog) return { ok: false, group: "unreadable", reason: "Could not open it (the file is damaged)" };
  return { ok: true, doc };
}

// ---------- reading the parts of a picture's description ----------

// The name stored under a key, for example "/DCTDecode". Empty text if missing.
function nameAt(dict: PDFDict, key: string): string {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.toString() : "";
}

// All filter names of a picture, for example ["/DCTDecode"].
function filtersOf(dict: PDFDict): string[] {
  const value = dict.lookup(PDFName.of("Filter"));
  if (value instanceof PDFName) return [value.toString()];
  if (value instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < value.size(); i++) {
      const item = value.lookup(i);
      if (item instanceof PDFName) names.push(item.toString());
    }
    return names;
  }
  return [];
}

// How many colour channels the picture has, if it uses plain RGB (3) or grey (1) colours.
// CMYK and other colour spaces return 0: we skip those on purpose.
function colourChannels(dict: PDFDict): 0 | 1 | 3 {
  const space = dict.lookup(PDFName.of("ColorSpace"));
  if (space instanceof PDFName) {
    const n = space.toString();
    if (n === "/DeviceRGB" || n === "/CalRGB") return 3;
    if (n === "/DeviceGray" || n === "/CalGray") return 1;
    return 0;
  }
  if (space instanceof PDFArray && space.size() >= 2) {
    const first = space.lookup(0);
    if (first instanceof PDFName && first.toString() === "/ICCBased") {
      const profile = space.lookup(1);
      if (profile instanceof PDFRawStream) {
        const n = profile.dict.lookup(PDFName.of("N"));
        if (n instanceof PDFNumber && n.asNumber() === 1) return 1;
        if (n instanceof PDFNumber && n.asNumber() === 3) return 3;
      }
    }
  }
  return 0;
}

function numberAt(dict: PDFDict, key: string): number {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : 0;
}

// ---------- finding the pictures ----------

export interface Picture {
  ref: PDFRef;
  stream: PDFRawStream;
  width: number;
  height: number;
  channels: 1 | 3;
}

export interface Examined {
  hasForm: boolean; // has fill-in form fields
  signed: boolean; // has a digital signature
  pictureCount: number; // every picture in the PDF
  shrinkable: Picture[]; // plain JPEG pictures of at least 50 KB that we know how to handle
}

export function examine(doc: PDFDocument): Examined {
  const form = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const fields = form?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  const hasForm = !!fields && fields.size() > 0;

  let signed = false;
  let pictureCount = 0;
  const shrinkable: Picture[] = [];

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) continue;

    const type = nameAt(dict, "Type");
    if (type === "/Sig" || type === "/DocTimeStamp") signed = true;

    if (obj instanceof PDFRawStream && nameAt(dict, "Subtype") === "/Image") {
      pictureCount++;
      const filters = filtersOf(dict);
      const isJpeg = filters.length === 1 && (filters[0] === "/DCTDecode" || filters[0] === "/DCT");
      const isMask = dict.lookup(PDFName.of("ImageMask"))?.toString() === "true";
      const hasDecode = dict.lookup(PDFName.of("Decode")) !== undefined;
      const channels = colourChannels(dict);
      const width = numberAt(dict, "Width");
      const height = numberAt(dict, "Height");
      if (isJpeg && !isMask && !hasDecode && channels !== 0 && width > 0 && height > 0 && obj.contents.length >= MIN_PICTURE_BYTES) {
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
export async function recompressJpeg(data: Uint8Array, p: { width: number; height: number; channels: 1 | 3 }): Promise<Buffer | null> {
  const isGrey = p.channels === 1; // read once here, before the checks below
  try {
    const input = Buffer.from(data);
    const before = await sharp(input, { failOn: "none" }).metadata();
    if (before.format !== "jpeg" || before.width !== p.width || before.height !== p.height || before.channels !== p.channels) {
      return null;
    }
    // Baseline JPEG (not progressive), the type every PDF viewer and printer understands.
    // (A grey picture must stay grey: sharp would otherwise turn it into a 3-colour one.)
    let pipeline = sharp(input, { failOn: "none" }).keepIccProfile();
    if (isGrey) pipeline = pipeline.toColourspace("b-w");
    const out = await pipeline.jpeg({ quality: JPEG_QUALITY, progressive: false }).toBuffer();
    const after = await sharp(out).metadata();
    if (after.format !== "jpeg" || after.width !== p.width || after.height !== p.height || after.channels !== p.channels) {
      return null;
    }
    if (out.length > data.length * (1 - MIN_PICTURE_SAVING)) return null;
    return out;
  } catch {
    return null;
  }
}
