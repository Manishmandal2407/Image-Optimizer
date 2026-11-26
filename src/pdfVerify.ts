import sharp from "sharp";
import { PDFDict, PDFName, PDFObject, PDFRawStream } from "pdf-lib";
import { openPdf } from "./pdfCommon";

// SAFETY CHECK for a smaller PDF. It reopens the original and the smaller copy
// (from disk, as two fresh files) and checks that:
//   1. both open, and have the same number of pages
//   2. every part of the PDF EXCEPT the pictures we shrank is identical
//   3. every shrunk picture still has the same type, size in pixels and colours
// It only READS both files.

export interface PdfVerifyResult {
  ok: boolean;
  pages: number; // pages in the PDF
  partsChecked: number; // parts (objects) that must be identical, and are
  picturesChecked: number; // shrunk pictures checked
  problems: string[]; // plain-words list of what is wrong (empty when ok)
}

// A text "fingerprint" of a PDF part. Two parts with the same fingerprint are
// the same. For streams the real data is compared separately.
// "Length" is left out: it changes by itself when a file is saved again.
function dictFingerprint(dict: PDFDict): string {
  return dict
    .entries()
    .map(([key, value]) => `${key.toString()} ${value.toString()}`)
    .filter((line) => !line.startsWith("/Length "))
    .sort()
    .join("\n");
}

function fingerprint(obj: PDFObject): string {
  if (obj instanceof PDFRawStream) return `stream\n${dictFingerprint(obj.dict)}`;
  if (obj instanceof PDFDict) return `dict\n${dictFingerprint(obj)}`;
  return obj.toString();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

// "shrunkRefs" are the pictures we replaced on purpose, written like "12 0 R".
export async function verifySmallerPdf(originalFile: string, smallerFile: string, shrunkRefs: string[]): Promise<PdfVerifyResult> {
  const problems: string[] = [];
  const result = (pages = 0, partsChecked = 0, picturesChecked = 0): PdfVerifyResult => ({
    ok: problems.length === 0,
    pages,
    partsChecked,
    picturesChecked,
    problems,
  });

  const a = await openPdf(originalFile);
  const b = await openPdf(smallerFile);
  if (!a.ok) { problems.push(`The original does not open: ${a.reason}`); return result(); }
  if (!b.ok) { problems.push(`The smaller copy does not open: ${b.reason}`); return result(); }

  // 1. Same number of pages.
  const pages = a.doc.getPageCount();
  if (b.doc.getPageCount() !== pages) {
    problems.push(`The page count changed: ${pages} page(s) before, ${b.doc.getPageCount()} after.`);
    return result(pages);
  }

  // The start of the document must be the same too.
  for (const key of ["Root", "Info"] as const) {
    const before = a.doc.context.trailerInfo[key]?.toString() ?? "";
    const after = b.doc.context.trailerInfo[key]?.toString() ?? "";
    if (before !== after) problems.push(`The document's ${key} entry changed.`);
  }

  // 2 and 3. Go through every part of the original.
  const shrunk = new Set(shrunkRefs);
  let partsChecked = 0;
  let picturesChecked = 0;
  let countA = 0;

  for (const [ref, objA] of a.doc.context.enumerateIndirectObjects()) {
    countA++;
    const objB = b.doc.context.lookup(ref);
    if (!objB) {
      problems.push(`Part ${ref.tag} is missing from the smaller copy.`);
      continue;
    }

    if (shrunk.has(ref.tag)) {
      // A picture we shrank on purpose: its description must be the same, and it must still be a good picture.
      if (!(objA instanceof PDFRawStream) || !(objB instanceof PDFRawStream)) {
        problems.push(`Picture ${ref.tag} is no longer a picture.`);
        continue;
      }
      if (fingerprint(objA) !== fingerprint(objB)) {
        problems.push(`The description of picture ${ref.tag} changed.`);
        continue;
      }
      try {
        const before = await sharp(Buffer.from(objA.contents), { failOn: "none" }).metadata();
        const after = await sharp(Buffer.from(objB.contents), { failOn: "none" }).metadata();
        if (after.format !== "jpeg" || after.width !== before.width || after.height !== before.height || after.channels !== before.channels) {
          problems.push(`Picture ${ref.tag} changed its type, size or colours.`);
          continue;
        }
      } catch {
        problems.push(`Picture ${ref.tag} cannot be read.`);
        continue;
      }
      picturesChecked++;
      continue;
    }

    // Everything else must be exactly the same.
    if (fingerprint(objA) !== fingerprint(objB)) {
      problems.push(`Part ${ref.tag} changed.`);
      continue;
    }
    if (objA instanceof PDFRawStream && objB instanceof PDFRawStream && !sameBytes(objA.contents, objB.contents)) {
      problems.push(`The data of part ${ref.tag} changed.`);
      continue;
    }
    partsChecked++;
  }

  // The smaller copy must not have extra parts.
  let countB = 0;
  for (const _ of b.doc.context.enumerateIndirectObjects()) countB++;
  if (countB !== countA) problems.push(`The number of parts changed: ${countA} before, ${countB} after.`);

  // Keep the list short and readable.
  if (problems.length > 5) {
    const extra = problems.length - 5;
    problems.length = 5;
    problems.push(`...and ${extra} more problem(s).`);
  }
  return result(pages, partsChecked, picturesChecked);
}
