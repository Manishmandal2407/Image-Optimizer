import fs from "fs";
import path from "path";
import sharp from "sharp";
import ssim from "ssim.js";
import { PDFRawStream } from "pdf-lib";
import { examine, openPdf, recompressJpeg } from "./pdfCommon";
import { verifySmallerPdf } from "./pdfVerify";
import { log } from "./logger";

// Makes a smaller copy of a PDF in the work folder. ONLY the big JPEG pictures
// inside are made smaller. Everything else in the PDF is copied as it is.
// The original PDF is only READ, never changed.

// Same reduced-size comparison as for images, to save memory.
const COMPARE_MAX_SIDE = 1600;
const MIN_PDF_SAVING = 0.05; // the whole PDF must get at least 5% smaller, or we make no copy

export type PdfSmallerResult =
  | {
      made: true;
      sizeBytes: number; // size of the smaller PDF
      savingPercent: number; // how much smaller than the original
      ssim: number; // the LOWEST similarity of all shrunk pictures (1.0000 = identical)
      picturesShrunk: number; // pictures we made smaller
      picturesFound: number; // pictures in the PDF
      checks: { pages: number; partsChecked: number; picturesChecked: number }; // what the safety check confirmed
    }
  | { made: false; reason: string };

// A JPEG picture as raw pixels, so two pictures can be compared dot by dot.
async function readPixels(jpeg: Uint8Array) {
  const { data, info } = await sharp(Buffer.from(jpeg), { failOn: "none" })
    .resize({ width: COMPARE_MAX_SIDE, height: COMPARE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function pictureSsim(before: Uint8Array, after: Uint8Array): Promise<number> {
  const a = await readPixels(before);
  const b = await readPixels(after);
  if (a.width !== b.width || a.height !== b.height) throw new Error("A shrunk picture changed size.");
  const toImage = (p: typeof a) => ({
    data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength),
    width: p.width,
    height: p.height,
  });
  return ssim(toImage(a), toImage(b), { ssim: "fast", downsample: false }).mssim;
}

export async function makeSmallerPdf(originalFile: string, smallerFile: string): Promise<PdfSmallerResult> {
  const opened = await openPdf(originalFile);
  if (!opened.ok) return { made: false, reason: opened.reason };
  const doc = opened.doc;

  const found = examine(doc);
  if (found.hasForm) return { made: false, reason: "Skipped: the PDF has form fields." };
  if (found.signed) return { made: false, reason: "Skipped: the PDF is digitally signed." };
  if (found.shrinkable.length === 0) return { made: false, reason: "No JPEG picture of 50 KB or more to shrink." };

  // Shrink the pictures one at a time.
  let lowestSsim = 1;
  let shrunk = 0;
  const shrunkRefs: string[] = []; // the pictures we replaced, for the safety check
  for (const picture of found.shrinkable) {
    const smaller = await recompressJpeg(picture.stream.contents, picture);
    if (!smaller) continue; // keep this picture as it is
    const score = await pictureSsim(picture.stream.contents, smaller);
    lowestSsim = Math.min(lowestSsim, score);
    // Put the new picture data in place. Its description (size, colours) stays the same.
    doc.context.assign(picture.ref, PDFRawStream.of(picture.stream.dict, smaller));
    shrunk++;
    shrunkRefs.push(picture.ref.tag);
    log(`  PDF picture shrunk: ${picture.stream.contents.length} to ${smaller.length} bytes, SSIM ${score.toFixed(4)}`);
  }
  if (shrunk === 0) return { made: false, reason: "No picture could be made at least 5% smaller." };

  // Save the new PDF under a temporary name first, so a half-written file is never left behind.
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: Infinity });
  const originalSize = fs.statSync(originalFile).size;
  if (bytes.length > originalSize * (1 - MIN_PDF_SAVING)) {
    return { made: false, reason: "The whole PDF would get less than 5% smaller, so it is not worth changing." };
  }
  fs.mkdirSync(path.dirname(smallerFile), { recursive: true });
  const tempFile = `${smallerFile}.tmp`;
  fs.writeFileSync(tempFile, bytes);

  // SAFETY CHECK on the file we just wrote. If anything is wrong, no copy is kept.
  const check = await verifySmallerPdf(originalFile, tempFile, shrunkRefs);
  if (!check.ok) {
    fs.unlinkSync(tempFile);
    log(`  PDF safety check FAILED: ${check.problems.join(" ")}`);
    return { made: false, reason: `Safety check failed, so no copy was kept. ${check.problems.join(" ")}` };
  }
  log(`  PDF safety check passed: ${check.pages} page(s), ${check.partsChecked} parts identical, ${check.picturesChecked} picture(s)`);
  fs.renameSync(tempFile, smallerFile);

  return {
    made: true,
    sizeBytes: bytes.length,
    savingPercent: Math.round(((originalSize - bytes.length) / originalSize) * 1000) / 10,
    ssim: Math.round(lowestSsim * 10000) / 10000,
    picturesShrunk: shrunk,
    picturesFound: found.pictureCount,
    checks: { pages: check.pages, partsChecked: check.partsChecked, picturesChecked: check.picturesChecked },
  };
}
