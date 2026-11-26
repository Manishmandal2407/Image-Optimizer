import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { Config } from "./config";
import { ImageRecord, Outcome } from "./state";
import { safeJoin } from "./paths";
import { formatBytes } from "./format";
import { log } from "./logger";

sharp.cache(false); // do not keep files locked on Windows

// ---------- small helpers ----------

// SHA-256 "fingerprint" of a file. Two files with the same fingerprint are identical.
export function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Open an image and report its type and size in pixels (as it is displayed).
// Throws if the file cannot be opened as an image.
async function describe(file: string) {
  const m = await sharp(file).metadata();
  if (!m.format || !m.width || !m.height) {
    throw new Error("the file could not be opened as an image");
  }
  const sideways = (m.orientation ?? 1) >= 5; // camera rotation flag
  return {
    format: m.format,
    width: sideways ? m.height : m.width,
    height: sideways ? m.width : m.height,
  };
}

type Described = Awaited<ReturnType<typeof describe>>;
function sameLook(a: Described, b: Described): boolean {
  return a.format === b.format && a.width === b.width && a.height === b.height;
}

// A temporary file name in the same folder as "file".
function tempNameFor(file: string, label: string): string {
  return path.join(path.dirname(file), `${path.basename(file)}.${label}-${Date.now()}.tmp`);
}

// Copy "from" next to "target" under a temporary name, check it is identical,
// then swap it in under the target's name. If the swap fails, the target is
// left exactly as it was and the temporary file is removed.
export async function copyAndSwap(from: string, target: string, expectedHash: string, label: string) {
  const temp = tempNameFor(target, label);
  try {
    fs.copyFileSync(from, temp, fs.constants.COPYFILE_EXCL);
    if ((await sha256(temp)) !== expectedHash) {
      throw new Error("the temporary copy did not match (SHA-256 check failed)");
    }
    try {
      fs.renameSync(temp, target); // replaces the target in one step
    } catch {
      throw new Error("could not swap the file. Is the image open in another program?");
    }
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp); // clean up OUR temporary file
  }
}

// ---------- USE SMALLER VERSION ----------

export async function useSmallerVersion(config: Config, img: ImageRecord): Promise<Outcome> {
  const original = safeJoin(config.imagesFolder, img.relativePath);
  const smaller = safeJoin(config.workFolder, img.relativePath);
  const vaultFile = safeJoin(config.vaultFolder, img.relativePath);

  // Checks before we touch anything.
  if (!img.smaller) {
    throw new Error("There is no smaller copy yet. Click Make smaller copies first.");
  }
  if (img.outcome?.action === "replaced") {
    throw new Error("This image was already replaced.");
  }
  if (!fs.existsSync(original) || fs.statSync(original).size !== img.sizeBytes) {
    throw new Error("The original file changed or disappeared since the scan. Click Scan again.");
  }
  if (!fs.existsSync(smaller) || fs.statSync(smaller).size !== img.smaller.sizeBytes) {
    throw new Error("The smaller copy is missing or changed. Click Make smaller copies again.");
  }
  const expected = await describe(original);
  if (!sameLook(expected, await describe(smaller))) {
    throw new Error("The smaller copy has a different type or pixel size. Not safe to use.");
  }
  const originalHash = await sha256(original);
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
  log("  a) original is safe in the vault and checked");

  // b) + c) Put the smaller file next to the original under a temporary name,
  //         then swap it in. The name, folder and type stay the same.
  await copyAndSwap(smaller, original, smallerHash, "sso-new");
  log("  b,c) smaller file swapped in under the same name");

  // d) Check the new file opens and is exactly the smaller copy we vetted.
  try {
    if ((await sha256(original)) !== smallerHash) throw new Error("the new file is not identical to the smaller copy");
    if (!sameLook(expected, await describe(original))) throw new Error("the new file has a different type or size");
    log("  d) new file checked: it opens and matches");
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
    beforeBytes: img.sizeBytes,
    afterBytes,
    originalSha256: originalHash,
    message: `Replaced with the smaller version. Saved ${formatBytes(img.sizeBytes - afterBytes)}. Original is in the vault.`,
  };
}

// ---------- RESTORE ORIGINAL ----------

export async function restoreOriginal(config: Config, img: ImageRecord): Promise<Outcome> {
  const o = img.outcome;
  if (!o || o.action !== "replaced" || !o.originalSha256) {
    throw new Error("This image was not replaced by this app, so there is nothing to restore.");
  }
  const live = safeJoin(config.imagesFolder, img.relativePath);
  const vaultFile = safeJoin(config.vaultFolder, img.relativePath);

  if (!fs.existsSync(vaultFile)) {
    throw new Error(`The vault copy is missing: ${vaultFile}`);
  }
  // Check the vault copy is still exactly the original we saved.
  if ((await sha256(vaultFile)) !== o.originalSha256) {
    throw new Error(`The vault copy does not match what was saved (SHA-256). Not restoring. File: ${vaultFile}`);
  }
  // Do not overwrite a file that someone changed after we replaced it.
  if (fs.existsSync(live) && fs.statSync(live).size !== o.afterBytes) {
    throw new Error(
      `The file was changed after it was replaced, so it was NOT overwritten. ` +
      `The original is safe in the vault: ${vaultFile}`
    );
  }

  await copyAndSwap(vaultFile, live, o.originalSha256, "sso-back");

  // Check the restored file.
  if ((await sha256(live)) !== o.originalSha256) {
    throw new Error(`The restored file did not match the original. The original is safe in the vault: ${vaultFile}`);
  }
  await describe(live); // must open as an image

  const afterBytes = fs.statSync(live).size;
  return {
    action: "restored",
    at: new Date().toISOString(),
    beforeBytes: o.afterBytes,
    afterBytes,
    message: "Original restored from the vault and checked.",
  };
}
