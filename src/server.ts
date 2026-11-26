import express from "express";
import path from "path";
import { Config, loadConfig } from "./config";
import { log } from "./logger";
import { scanFolder } from "./scanner";
import { loadState, mergeDocScan, mergeScan, saveState } from "./state";
import { ListView, pageOf, rangeCount, summarize } from "./listing";
import { makeSmallerCopy } from "./optimizer";
import { safeJoin } from "./paths";
import fs from "fs";
import sharp from "sharp";
import { ImageRecord, Outcome, suggestFor } from "./state";
import { useSmallerVersion, restoreOriginal } from "./replacer";
import { formatBytes } from "./format";
import { buildPdfReport } from "./pdfReport";
import { makeSmallerPdf } from "./pdfOptimizer";
import { useSmallerPdf, restorePdf } from "./pdfReplacer";
import { sha256 } from "./replacer";
import { DocRecord } from "./state";

const PORT = 4000;
const MIN_SIZE_BYTES = 500 * 1024; // only images of 500 KB or more get a smaller copy

// Check the config BEFORE starting the server. If it is unsafe, stop here.
function startUp(): Config {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`STARTUP FAILED: ${message}`);
    console.error("\nCannot start. Please fix config.json and try again.");
    process.exit(1);
  }
}
const config = startUp();

const app = express();
app.use(express.json()); // lets us read data sent by the web page

// Serve the Angular web page (built into client/dist/client/browser).
app.use(express.static(path.join(__dirname, "..", "client", "dist", "client", "browser")));

// A tiny test address, to prove the server is alive and show the folders.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Smart Storage Optimizer server is running", folders: config });
});

// SCAN: list the images AND the PDFs in imagesFolder. Read-only for your files.
// (It only writes our own data/state.json.)
app.get("/api/scan", (_req, res) => {
  try {
    const started = Date.now();
    log("Scan started");
    const result = scanFolder(config.imagesFolder);

    const state = loadState();
    state.lastScan = new Date().toISOString();
    state.images = mergeScan(state.images, result.images);
    state.documents = mergeDocScan(state.documents, result.pdfs);
    saveState(state);

    const totalBytes = result.images.reduce((sum, img) => sum + img.sizeBytes, 0);
    const pdfBytes = result.pdfs.reduce((sum, d) => sum + d.sizeBytes, 0);
    log(`Scan finished: ${result.images.length} images, ${totalBytes} bytes, ${result.pdfs.length} PDFs, ${pdfBytes} bytes, ${result.warnings.length} warnings, ${Math.round((Date.now() - started) / 100) / 10} s`);
    result.warnings.forEach((w) => log(`Scan warning: ${w}`));

    res.json({
      count: result.images.length,
      totalBytes,
      pdfCount: result.pdfs.length,
      pdfBytes,
      warnings: result.warnings,
      totals: summarize(state.images),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Scan FAILED: ${message}`);
    res.status(500).json({ error: `Scan failed: ${message}` });
  }
});

// SUMMARY: the totals for the left side of the page (the whole list is never sent to the browser).
app.get("/api/summary", (_req, res) => {
  res.json({ totals: summarize(loadState().images) });
});

// IMAGES: ONE PAGE of a list. view = list | review | results. Read-only.
app.get("/api/images", (req, res) => {
  const v = String(req.query.view ?? "list");
  const view: ListView = v === "review" || v === "results" ? v : "list";
  const size = Math.min(100, Math.max(1, Math.floor(Number(req.query.size)) || 50));
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  res.json(pageOf(loadState().images, view, page, size));
});

// RANGE COUNT: how many images "Replace by saving" would replace for this range. Read-only.
app.get("/api/range-count", (req, res) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 100 || from > to) {
    res.json({ n: 0 });
    return;
  }
  res.json({ n: rangeCount(loadState().images, from, to, MIN_SSIM_FOR_RANGE) });
});

// PREPARE: make a smaller copy (in workFolder) of every image and every PDF >= 500 KB.
// Originals are only read, never changed.
let working = false; // stops two runs at the same time

// PROGRESS and STOP for the long jobs (Make smaller copies, Replace all ...).
// The web page asks /api/progress every second. Stop never interrupts a file in the
// middle of a swap: the job finishes the file it is on, then stops before the next one.
const job = { active: false, label: "", done: 0, total: 0, stop: false };
function startJob(label: string, total: number) {
  job.active = true; job.label = label; job.done = 0; job.total = total; job.stop = false;
}
function endJob() {
  job.active = false; job.stop = false;
}
app.get("/api/progress", (_req, res) => {
  res.json({ active: job.active, label: job.label, done: job.done, total: job.total, stopping: job.stop });
});
app.post("/api/stop", (_req, res) => {
  if (job.active) {
    job.stop = true;
    log(`Stop requested by you (${job.label})`);
  }
  res.json({ ok: true });
});
// Make the smaller copy of ONE PDF and write the answer into its record.
// Used by "Make smaller copies" and by the one-PDF button. The original is only read.
async function makePdfCopy(rec: DocRecord, original: string, smaller: string) {
  const originalHash = await sha256(original);
  const r = await makeSmallerPdf(original, smaller);
  rec.sizeBytes = fs.statSync(original).size;
  delete rec.error;
  if (r.made) {
    rec.smaller = {
      sizeBytes: r.sizeBytes,
      savingPercent: r.savingPercent,
      ssim: r.ssim,
      picturesShrunk: r.picturesShrunk,
      picturesFound: r.picturesFound,
      originalSha256: originalHash,
    };
    delete rec.noCopyReason;
    if (rec.outcome?.action !== "kept") delete rec.outcome; // an old "failed"/"restored" note is out of date
  } else {
    // Remove an older test copy of ours, so it is not mistaken for a good one.
    if (fs.existsSync(smaller)) fs.unlinkSync(smaller);
    delete rec.smaller;
    rec.noCopyReason = r.reason;
  }
  return r;
}

app.post("/api/prepare", async (_req, res) => {
  if (working) {
    res.status(409).json({ error: "Already working. Please wait for the current run to finish." });
    return;
  }
  const state = loadState();
  if (state.images.length === 0 && state.documents.length === 0) {
    res.status(400).json({ error: "Nothing in the list. Run Scan first." });
    return;
  }

  working = true;
  const counts = { made: 0, alreadyDone: 0, tooSmall: 0, failed: 0, pdfMade: 0, pdfAlreadyDone: 0, pdfTooSmall: 0, pdfNoCopy: 0, pdfFailed: 0 };
  let sinceSave = 0;
  let stopped = false;
  startJob("Making smaller copies", state.images.length + state.documents.length);
  try {
    log(`Making smaller copies started (${state.images.length} images and ${state.documents.length} PDFs in list)`);
    for (const img of state.images) {
      if (job.stop) { stopped = true; break; } // you clicked Stop
      job.done++;
      if (img.outcome?.action === "replaced") { counts.alreadyDone++; continue; }
      if (img.sizeBytes < MIN_SIZE_BYTES) { counts.tooSmall++; continue; }

      const originalFile = safeJoin(config.imagesFolder, img.relativePath);
      const smallerFile = safeJoin(config.workFolder, img.relativePath);

      // Already done earlier and the copy is still there: skip it.
      if (img.smaller && fs.existsSync(smallerFile)) { counts.alreadyDone++; continue; }

      try {
        // The file must still be the same one we scanned.
        if (!fs.existsSync(originalFile) || fs.statSync(originalFile).size !== img.sizeBytes) {
          throw new Error("The file changed or disappeared since the scan. Please run Scan again.");
        }
        log(`Making smaller copy: ${img.relativePath}`);
        const r = await makeSmallerCopy(originalFile, smallerFile);
        img.smaller = {
          sizeBytes: r.sizeBytes,
          savingPercent: Math.round((1 - r.sizeBytes / img.sizeBytes) * 1000) / 10,
          ssim: r.ssim,
        };
        delete img.error;
        counts.made++;
        log(`Done: ${img.relativePath} -> ${r.sizeBytes} bytes, saving ${img.smaller.savingPercent}%, SSIM ${r.ssim}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Remove a half-written temporary copy (it is OUR file in workFolder).
        if (fs.existsSync(smallerFile)) fs.rmSync(smallerFile);
        delete img.smaller;
        img.error = message;
        counts.failed++;
        log(`FAILED: ${img.relativePath}: ${message}`);
      }
      // Saving the whole list is slow when it is long, so save every 10 images.
      // (A crash can lose at most 10 notes; the smaller copies themselves stay on disk.)
      if (++sinceSave >= 10) {
        saveState(state);
        sinceSave = 0;
      }
    }

    // Now the PDFs (only the big JPEG pictures inside are made smaller).
    if (!stopped) {
      const pdfWork = path.join(config.workFolder, "pdf");
      for (const doc of state.documents) {
        if (job.stop) { stopped = true; break; } // you clicked Stop
        job.done++;
        if (doc.outcome?.action === "replaced") { counts.pdfAlreadyDone++; continue; }
        if (doc.sizeBytes < MIN_SIZE_BYTES) { counts.pdfTooSmall++; continue; }

        const originalFile = safeJoin(config.imagesFolder, doc.relativePath);
        const smallerFile = safeJoin(pdfWork, doc.relativePath);

        // Already done earlier (copy still there), or we already know there is nothing to shrink.
        if (doc.smaller && fs.existsSync(smallerFile)) { counts.pdfAlreadyDone++; continue; }
        if (doc.noCopyReason && !doc.smaller) { counts.pdfNoCopy++; continue; }

        try {
          if (!fs.existsSync(originalFile) || fs.statSync(originalFile).size !== doc.sizeBytes) {
            throw new Error("The file changed or disappeared since the scan. Please run Scan again.");
          }
          log(`Making smaller PDF copy: ${doc.relativePath}`);
          const r = await makePdfCopy(doc, originalFile, smallerFile);
          if (r.made) {
            counts.pdfMade++;
            log(`Done: ${doc.relativePath} -> ${formatBytes(r.sizeBytes)}, ${r.savingPercent}% smaller, lowest SSIM ${r.ssim}`);
          } else {
            counts.pdfNoCopy++;
            log(`No smaller PDF copy: ${doc.relativePath}: ${r.reason}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (fs.existsSync(smallerFile)) fs.rmSync(smallerFile);
          delete doc.smaller;
          doc.error = message;
          counts.pdfFailed++;
          log(`FAILED: ${doc.relativePath}: ${message}`);
        }
        if (++sinceSave >= 10) {
          saveState(state);
          sinceSave = 0;
        }
      }
    }
    saveState(state);
    log(`Making smaller copies ${stopped ? "STOPPED by you" : "finished"}: ${JSON.stringify(counts)}`);
    res.json({ ...counts, stopped, totals: summarize(state.images), documents: state.documents });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Prepare FAILED: ${message}`);
    saveState(state); // keep what was done before the problem
    res.status(500).json({ error: `Could not make smaller copies: ${message}` });
  } finally {
    working = false;
    endJob();
  }
});

// PDF CHECK: look inside the PDFs and estimate how much the pictures could shrink.
// Read-only: no PDF is changed, moved or deleted, and state.json is not touched.
app.post("/api/pdf-report", async (_req, res) => {
  if (working) {
    res.status(409).json({ error: "Already working. Please wait for the current run to finish." });
    return;
  }
  working = true;
  try {
    log("PDF check started");
    const report = await buildPdfReport(config.imagesFolder);
    log(
      `PDF check finished: ${report.pdfCount} PDFs found, ${report.checkedCount} checked, ` +
      `estimated saving ${formatBytes(report.estimatedSavingAll)}, ${report.seconds} s`
    );
    report.warnings.forEach((w) => log(`PDF check warning: ${w}`));
    res.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`PDF check FAILED: ${message}`);
    res.status(500).json({ error: `Could not check the PDFs: ${message}` });
  } finally {
    working = false;
    endJob();
  }
});

// MAKE A SMALLER COPY OF ONE PDF (in workFolder/pdf). The original PDF is only read.
// Only the big JPEG pictures inside are made smaller; everything else is copied as it is.
app.post("/api/pdf-prepare", async (req, res) => {
  const relativePath = typeof req.body?.relativePath === "string" ? req.body.relativePath : "";
  if (!relativePath.toLowerCase().endsWith(".pdf")) {
    res.status(400).json({ error: "That is not a PDF file." });
    return;
  }
  if (working) {
    res.status(409).json({ error: "Already working. Please wait for the current run to finish." });
    return;
  }
  working = true;
  try {
    const original = safeJoin(config.imagesFolder, relativePath);
    if (!fs.existsSync(original)) {
      res.status(404).json({ error: `The PDF was not found: ${relativePath}` });
      return;
    }
    const smaller = safeJoin(path.join(config.workFolder, "pdf"), relativePath);
    const state = loadState();
    let rec = state.documents.find((d) => d.relativePath === relativePath);
    if (rec?.outcome?.action === "replaced") {
      res.status(400).json({ error: "This PDF is already replaced. Click Restore original first if you want to try again." });
      return;
    }
    log(`Smaller PDF copy started: ${relativePath}`);
    if (!rec) {
      rec = { relativePath, sizeBytes: 0 };
      state.documents.push(rec);
    }
    const r = await makePdfCopy(rec, original, smaller);
    if (r.made) {
      log(`Smaller PDF copy done: ${relativePath}, ${formatBytes(r.sizeBytes)}, ${r.savingPercent}% smaller, lowest SSIM ${r.ssim}`);
    } else {
      log(`Smaller PDF copy not made: ${relativePath}: ${r.reason}`);
    }
    saveState(state);
    res.json({ ...r, workFile: path.join("pdf", relativePath), documents: state.documents });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Smaller PDF copy FAILED: ${relativePath}: ${message}`);
    res.status(500).json({ error: `Could not make a smaller copy: ${message}` });
  } finally {
    working = false;
    endJob();
  }
});

// PDF RECORDS: what we remember about PDFs (so the Documents tab survives a page reload).
app.get("/api/pdf-records", (_req, res) => {
  res.json({ documents: loadState().documents });
});

// Shared code for the three one-PDF buttons (same safe steps as for images).
function onePdfAction(name: string, job: (doc: DocRecord) => Promise<Outcome>) {
  return async (req: express.Request, res: express.Response) => {
    if (working) {
      res.status(409).json({ error: "Another job is running. Please wait for it to finish." });
      return;
    }
    const state = loadState();
    const doc = state.documents.find((d) => d.relativePath === req.body?.relativePath);
    if (!doc) {
      res.status(404).json({ error: "That PDF has no smaller copy yet. Click Make smaller copy first." });
      return;
    }
    working = true;
    try {
      log(`${name} started: ${doc.relativePath}`);
      const outcome = await job(doc);
      doc.outcome = outcome;
      doc.sizeBytes = outcome.afterBytes;
      saveState(state);
      log(`${name} finished: ${doc.relativePath}: ${outcome.message}`);
      res.json({ message: `${doc.relativePath}: ${outcome.message}`, documents: state.documents });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${name} FAILED: ${doc.relativePath}: ${message}`);
      // Never overwrite the "replaced" record: it is needed to restore later.
      if (doc.outcome?.action !== "replaced") {
        doc.outcome = { action: "failed", at: new Date().toISOString(), beforeBytes: doc.sizeBytes, afterBytes: doc.sizeBytes, message };
      }
      saveState(state);
      res.status(500).json({ error: `${doc.relativePath}: ${message}`, documents: state.documents });
    } finally {
      working = false;
      endJob();
    }
  };
}

app.post("/api/pdf-replace", onePdfAction("Use smaller PDF", (doc) => useSmallerPdf(config, doc)));
app.post("/api/pdf-restore", onePdfAction("Restore original PDF", (doc) => restorePdf(config, doc)));
app.post("/api/pdf-keep", onePdfAction("Keep original PDF", async (doc) => {
  if (doc.outcome?.action === "replaced") {
    throw new Error("This PDF is already replaced. Use Restore original instead.");
  }
  return {
    action: "kept" as const,
    at: new Date().toISOString(),
    beforeBytes: doc.sizeBytes,
    afterBytes: doc.sizeBytes,
    message: "You chose to keep the original. Nothing was changed.",
  };
}));

// REPLACE ALL SAFE PDFs: PDFs with a smaller copy that saves 5% or more and whose lowest
// picture SSIM is 0.99 or higher, and that you have not decided about yet.
// One PDF at a time, each with all the safe steps. Stops at the first problem.
app.post("/api/pdf-replace-ready", async (_req, res) => {
  if (working) {
    res.status(409).json({ error: "Another job is running. Please wait for it to finish." });
    return;
  }
  const state = loadState();
  const todo = state.documents.filter(
    (d) => !d.outcome && d.smaller !== undefined && d.smaller.savingPercent >= 5 && d.smaller.ssim >= 0.99
  );
  if (todo.length === 0) {
    res.status(400).json({ error: "There are no safe PDFs waiting.", documents: state.documents });
    return;
  }
  working = true;
  let replaced = 0;
  let savedBytes = 0;
  let stoppedBecause = "";
  let stoppedByUser = false;
  startJob("Replacing PDFs", todo.length);
  try {
    log(`Bulk PDF replace started: ${todo.length} PDFs`);
    for (const doc of todo) {
      if (job.stop) { stoppedByUser = true; break; } // you clicked Stop
      job.done++;
      try {
        log(`Use smaller PDF started: ${doc.relativePath}`);
        const outcome = await useSmallerPdf(config, doc);
        doc.outcome = outcome;
        doc.sizeBytes = outcome.afterBytes;
        replaced++;
        savedBytes += outcome.beforeBytes - outcome.afterBytes;
        saveState(state);
        log(`Use smaller PDF finished: ${doc.relativePath}: ${outcome.message}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        doc.outcome = { action: "failed", at: new Date().toISOString(), beforeBytes: doc.sizeBytes, afterBytes: doc.sizeBytes, message };
        saveState(state);
        log(`Use smaller PDF FAILED: ${doc.relativePath}: ${message}`);
        stoppedBecause = `Stopped at ${doc.relativePath}: ${message}`;
        break; // stop to be safe
      }
    }
    const summary = `Replaced ${replaced} of ${todo.length} PDFs. Saved ${formatBytes(savedBytes)}.${stoppedByUser ? " Stopped by you." : ""}`;
    log(`Bulk PDF replace finished: ${summary} ${stoppedBecause}`);
    if (stoppedBecause) res.status(500).json({ error: `${summary} ${stoppedBecause}`, documents: state.documents });
    else res.json({ message: summary, documents: state.documents });
  } finally {
    working = false;
    endJob();
  }
});

// ---------- buttons that change files: replace, keep, restore ----------
// ("working" is the same flag used by Make smaller copies: one job at a time.)

function failedOutcome(img: ImageRecord, message: string): Outcome {
  return { action: "failed", at: new Date().toISOString(), beforeBytes: img.sizeBytes, afterBytes: img.sizeBytes, message };
}

// Shared code for the three one-image buttons.
function oneImageAction(
  name: string,
  job: (img: ImageRecord) => Promise<Outcome>
) {
  return async (req: express.Request, res: express.Response) => {
    if (working) {
      res.status(409).json({ error: "Another job is running. Please wait for it to finish." });
      return;
    }
    const state = loadState();
    const img = state.images.find((i) => i.relativePath === req.body?.relativePath);
    if (!img) {
      res.status(404).json({ error: "That image is not in the list. Click Scan again." });
      return;
    }
    working = true;
    try {
      log(`${name} started: ${img.relativePath}`);
      const outcome = await job(img);
      img.outcome = outcome;
      img.sizeBytes = outcome.afterBytes; // the file on disk now has this size
      saveState(state);
      log(`${name} finished: ${img.relativePath}: ${outcome.message}`);
      res.json({ message: `${img.relativePath}: ${outcome.message}`, totals: summarize(state.images) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${name} FAILED: ${img.relativePath}: ${message}`);
      // Remember the failure, but never overwrite the "replaced" record
      // (we need it to restore the original later).
      if (img.outcome?.action !== "replaced") img.outcome = failedOutcome(img, message);
      saveState(state);
      res.status(500).json({ error: `${img.relativePath}: ${message}`, totals: summarize(state.images) });
    } finally {
      working = false;
      endJob();
    }
  };
}

app.post("/api/replace", oneImageAction("Use smaller version", (img) => useSmallerVersion(config, img)));
app.post("/api/restore", oneImageAction("Restore original", (img) => restoreOriginal(config, img)));

// KEEP ORIGINAL: only records your decision. No file is touched.
app.post("/api/keep", oneImageAction("Keep original", async (img) => {
  if (img.outcome?.action === "replaced") {
    throw new Error("This image is already replaced. Use Restore original instead.");
  }
  return {
    action: "kept" as const,
    at: new Date().toISOString(),
    beforeBytes: img.sizeBytes,
    afterBytes: img.sizeBytes,
    message: "You chose to keep the original. Nothing was changed.",
  };
}));

// BULK REPLACE (shared by the two bulk buttons): one image at a time, each
// with all the safe steps. It stops at the first problem, to be safe.
async function bulkReplace(
  res: express.Response,
  what: string,                                  // for messages, e.g. "green images"
  pick: (images: ImageRecord[]) => ImageRecord[] // which images to replace
) {
  if (working) {
    res.status(409).json({ error: "Another job is running. Please wait for it to finish." });
    return;
  }
  const state = loadState();
  const todo = pick(state.images);
  if (todo.length === 0) {
    res.status(400).json({ error: `There are no ${what} waiting.`, totals: summarize(state.images) });
    return;
  }

  working = true;
  let replaced = 0;
  let savedBytes = 0;
  let stoppedBecause = "";
  let stoppedByUser = false;
  startJob(`Replacing ${what}`, todo.length);
  try {
    log(`Bulk replace started (${what}): ${todo.length} images`);
    for (const img of todo) {
      if (job.stop) { stoppedByUser = true; break; } // you clicked Stop
      job.done++;
      try {
        log(`Use smaller version started: ${img.relativePath}`);
        const outcome = await useSmallerVersion(config, img);
        img.outcome = outcome;
        img.sizeBytes = outcome.afterBytes;
        replaced++;
        savedBytes += outcome.beforeBytes - outcome.afterBytes;
        saveState(state);
        log(`Use smaller version finished: ${img.relativePath}: ${outcome.message}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        img.outcome = failedOutcome(img, message);
        saveState(state);
        log(`Use smaller version FAILED: ${img.relativePath}: ${message}`);
        stoppedBecause = `Stopped at ${img.relativePath}: ${message}`;
        break; // stop to be safe
      }
    }
    const summary = `Replaced ${replaced} of ${todo.length} ${what}. Saved ${formatBytes(savedBytes)}.${stoppedByUser ? " Stopped by you." : ""}`;
    log(`Bulk replace finished: ${summary} ${stoppedBecause}`);
    if (stoppedBecause) {
      res.status(500).json({ error: `${summary} ${stoppedBecause}`, totals: summarize(state.images) });
    } else {
      res.json({ message: summary, totals: summarize(state.images) });
    }
  } finally {
    working = false;
    endJob();
  }
}

// REPLACE ALL GREEN: only green images you have not decided about yet.
app.post("/api/replace-green", async (_req, res) => {
  await bulkReplace(res, "green images", (images) =>
    images.filter((img) => suggestFor(img) === "green" && !img.outcome)
  );
});

// REPLACE BY SAVING: images whose saving is inside the range you typed
// (for example 15 to 20 %) AND whose SSIM is at least 0.95. Only images you
// have not decided about yet.
const MIN_SSIM_FOR_RANGE = 0.95;
app.post("/api/replace-range", async (req, res) => {
  const from = Number(req.body?.fromPercent);
  const to = Number(req.body?.toPercent);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 100 || from > to) {
    res.status(400).json({
      error: "Please type a valid range, for example from 15 to 20. Use numbers from 0 to 100, and the first number cannot be bigger than the second.",
    });
    return;
  }
  await bulkReplace(
    res,
    `images saving ${from}% to ${to}% with SSIM ${MIN_SSIM_FOR_RANGE} or higher`,
    (images) =>
      images.filter(
        (img) =>
          !img.outcome &&
          img.smaller !== undefined &&
          img.smaller.savingPercent >= from &&
          img.smaller.savingPercent <= to &&
          img.smaller.ssim >= MIN_SSIM_FOR_RANGE
      )
  );
});

// THUMB: a small preview picture for the lists. Read-only: it only reads the
// original and sends back a tiny version. Nothing is written to disk.
app.get("/api/thumb", async (req, res) => {
  const relativePath = String(req.query.path ?? "");
  const img = loadState().images.find((i) => i.relativePath === relativePath);
  if (!img) {
    res.status(404).send("Image not found");
    return;
  }
  try {
    const file = safeJoin(config.imagesFolder, img.relativePath);
    if (!fs.existsSync(file)) {
      res.status(404).send("File not found");
      return;
    }
    const small = await sharp(file)
      .rotate()
      .resize({ width: 128, height: 128, fit: "cover" })
      .jpeg({ quality: 70 })
      .toBuffer();
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=60");
    res.send(small);
  } catch {
    res.status(404).send("No preview");
  }
});

// IMAGE: send one picture to the Review screen so the browser can show it.
// Only images that are in our list can be requested, and only from the
// images folder ("original") or the work folder ("smaller"). Read-only.
app.get("/api/image/:which", (req, res) => {
  const which = req.params.which;
  const relativePath = String(req.query.path ?? "");
  const img = loadState().images.find((i) => i.relativePath === relativePath);

  if (!img || (which !== "original" && which !== "smaller")) {
    res.status(404).send("Image not found");
    return;
  }
  try {
    const root = which === "original" ? config.imagesFolder : config.workFolder;
    const file = safeJoin(root, img.relativePath);
    if (!fs.existsSync(file)) {
      res.status(404).send("File not found");
      return;
    }
    res.sendFile(file);
  } catch {
    res.status(404).send("Image not found");
  }
});

// PDF FILE: send one PDF to the Review screen so the browser can show it.
// Only PDFs that are in our list can be requested, and only from the images folder
// ("original") or the work folder, under "pdf" ("smaller"). Read-only.
app.get("/api/pdf-file/:which", (req, res) => {
  const which = req.params.which;
  const relativePath = String(req.query.path ?? "");
  const doc = loadState().documents.find((d) => d.relativePath === relativePath);
  if (!doc || (which !== "original" && which !== "smaller")) {
    res.status(404).send("PDF not found");
    return;
  }
  try {
    const root = which === "original" ? config.imagesFolder : path.join(config.workFolder, "pdf");
    const file = safeJoin(root, doc.relativePath);
    if (!fs.existsSync(file)) {
      res.status(404).send("File not found");
      return;
    }
    res.type("application/pdf");
    res.sendFile(file);
  } catch {
    res.status(404).send("PDF not found");
  }
});

app.listen(PORT, () => {
  log(`Server started at http://localhost:${PORT}`);
  log(`Images: ${config.imagesFolder} | Vault: ${config.vaultFolder} | Work: ${config.workFolder}`);
});
