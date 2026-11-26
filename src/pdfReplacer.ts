import fs from "fs";
import path from "path";
import { Config } from "./config";
import { DocRecord, Outcome } from "./state";
import { safeJoin } from "./paths";
import { formatBytes } from "./format";
import { log } from "./logger";
import { sha256, copyAndSwap } from "./replacer";
import { openPdf } from "./pdfCommon";

// Open a PDF and return its page count. Throws a plain-words error if it cannot be opened.
async function pageCount(file: string): Promise<number> {
  const r = await openPdf(file);
  if (!r.ok) throw new Error(r.reason);
  return r.doc.getPageCount();
}

// Where the smaller test copy of a PDF lives.
export function smallerPdfPath(config: Config, relativePath: string): string {
  return safeJoin(path.join(config.workFolder, "pdf"), relativePath);
}

// ---------- USE SMALLER VERSION (PDF) ----------

export async function useSmallerPdf(config: Config, doc: DocRecord): Promise<Outcome> {
  const original = safeJoin(config.imagesFolder, doc.relativePath);
  const smaller = smallerPdfPath(config, doc.relativePath);
  const vaultFile = safeJoin(config.vaultFolder, doc.relativePath);

  // Checks before we touch anything.
  if (!doc.smaller) throw new Error("There is no smaller copy yet. Click Make smaller copy first.");
  if (doc.outcome?.action === "replaced") throw new Error("This PDF was already replaced.");
  if (!fs.existsSync(original) || fs.statSync(original).size !== doc.sizeBytes) {
    throw new Error("The PDF changed or disappeared since the smaller copy was made. Click Make again.");
  }
  const originalHash = await sha256(original);
  if (originalHash !== doc.smaller.originalSha256) {
    throw new Error("The PDF changed since the smaller copy was made. Click Make again.");
  }
  if (!fs.existsSync(smaller) || fs.statSync(smaller).size !== doc.smaller.sizeBytes) {
    throw new Error("The smaller copy is missing or changed. Click Make again.");
  }
  const pages = await pageCount(original);
  if ((await pageCount(smaller)) !== pages) throw new Error("The smaller copy has a different number of pages. Not safe to use.");
  const smallerHash = await sha256(smaller);

  // a) Copy the original into the vault and check the copy is identical.
  fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
  if (fs.existsSync(vaultFile)) {
    if ((await sha256(vaultFile)) !== originalHash) {
      throw new Error(
        `The vault already holds a different file at ${vaultFile}. It was NOT overwritten. ` +
        `Move or rename that vault file and try again.`
      );
    }
    log("  vault already has an identical copy, reusing it");
  } else {
    fs.copyFileSync(original, vaultFile, fs.constants.COPYFILE_EXCL);
    if ((await sha256(vaultFile)) !== originalHash) {
      fs.rmSync(vaultFile); // remove the bad copy (it is OUR file in the vault)
      throw new Error("The vault copy did not match the original (SHA-256). Nothing was changed.");
    }
  }
  log("  a) original PDF is safe in the vault and checked");

  // b) + c) Smaller file next to the original under a temporary name, then swap.
  await copyAndSwap(smaller, original, smallerHash, "sso-new");
  log("  b,c) smaller PDF swapped in under the same name");

  // d) The new file must be exactly the vetted copy, and open with the same pages.
  try {
    if ((await sha256(original)) !== smallerHash) throw new Error("the new file is not identical to the smaller copy");
    if ((await pageCount(original)) !== pages) throw new Error("the new file has a different number of pages");
    log("  d) new PDF checked: it opens and matches");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`  d) CHECK FAILED (${reason}), putting the original back`);
    try {
      await copyAndSwap(vaultFile, original, originalHash, "sso-back");
    } catch {
      throw new Error(
        `The new file failed its check (${reason}) AND putting the original back failed. ` +
        `Your original is safe in the vault: ${vaultFile}. Copy it back by hand.`
      );
    }
    throw new Error(`The new file failed its check (${reason}). The original was put back from the vault.`);
  }

  const afterBytes = fs.statSync(original).size;
  return {
    action: "replaced",
    at: new Date().toISOString(),
    beforeBytes: doc.sizeBytes,
    afterBytes,
    originalSha256: originalHash,
    message: `Replaced with the smaller version. Saved ${formatBytes(doc.sizeBytes - afterBytes)}. Original is in the vault.`,
  };
}

// ---------- RESTORE ORIGINAL (PDF) ----------

export async function restorePdf(config: Config, doc: DocRecord): Promise<Outcome> {
  const o = doc.outcome;
  if (!o || o.action !== "replaced" || !o.originalSha256) {
    throw new Error("This PDF was not replaced by this app, so there is nothing to restore.");
  }
  const live = safeJoin(config.imagesFolder, doc.relativePath);
  const vaultFile = safeJoin(config.vaultFolder, doc.relativePath);

  if (!fs.existsSync(vaultFile)) throw new Error(`The vault copy is missing: ${vaultFile}`);
  if ((await sha256(vaultFile)) !== o.originalSha256) {
    throw new Error(`The vault copy does not match what was saved (SHA-256). Not restoring. File: ${vaultFile}`);
  }
  if (fs.existsSync(live) && fs.statSync(live).size !== o.afterBytes) {
    throw new Error(
      `The file was changed after it was replaced, so it was NOT overwritten. ` +
      `The original is safe in the vault: ${vaultFile}`
    );
  }

  await copyAndSwap(vaultFile, live, o.originalSha256, "sso-back");

  if ((await sha256(live)) !== o.originalSha256) {
    throw new Error(`The restored file did not match the original. The original is safe in the vault: ${vaultFile}`);
  }
  await pageCount(live); // must open as a PDF

  const afterBytes = fs.statSync(live).size;
  return {
    action: "restored",
    at: new Date().toISOString(),
    beforeBytes: o.afterBytes,
    afterBytes,
    message: "Original restored from the vault and checked.",
  };
}
