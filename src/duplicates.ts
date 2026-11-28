import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { Config } from "./config";
import { safeJoin } from "./paths";
import { sha256, copyAndSwap } from "./replacer";
import { scanFolder } from "./scanner";
import { log } from "./logger";

sharp.cache(false); // do not keep files locked on Windows

// ---------- what we remember ----------

// How strict the "similar pictures" check is.
export type Sensitivity = "strict" | "normal" | "loose";

// Every picture is shrunk to a 48 x 48 grey "fingerprint". Two pictures are the same picture when:
//  - their shapes (width / height) match within "aspect", and
//  - hardly any of the 2304 fingerprint pixels differ clearly (by more than PIXEL_DIFF out of 255).
// "changed" is the share of pixels allowed to differ. Copies that were only resized or saved again
// differ in 0% of them. Two different screenshots that merely look alike differ in 1% or more.
const GRID = 48;
const GRAY_B64_LEN = Math.ceil((GRID * GRID) / 3) * 4; // size of the fingerprint when saved in the cache
const PIXEL_DIFF = 24;
const LIMITS: Record<Sensitivity, { aspect: number; changed: number }> = {
  strict: { aspect: 0.002, changed: 0.0005 },
  normal: { aspect: 0.004, changed: 0.0025 },
  loose: { aspect: 0.01, changed: 0.006 },
};

export interface DupFile {
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  type: "image" | "pdf";
  width?: number;
  height?: number;
  twin?: number; // in a "similar" group: files with the same twin number are byte for byte identical
}

export interface DupGroup {
  id: string;
  kind: "exact" | "similar"; // exact = byte for byte identical, similar = looks the same
  files: DupFile[];
  keep: string;              // our suggestion: the file to keep
  reclaimBytes: number;      // space freed if every file except "keep" goes to the vault
}

export interface DupResult {
  foundAt: string;
  sensitivity: Sensitivity;
  filesLooked: number;       // images + PDFs that were checked
  groups: DupGroup[];
}

// One file we moved to the vault because it was a duplicate.
export interface DupRemoved {
  id: string;
  at: string;
  relativePath: string;      // where it was inside the images folder
  vaultRelative: string;     // where it is now inside the vault folder
  sizeBytes: number;
  sha256: string;
  keptPath: string;          // the file we kept instead
  kind: "exact" | "similar";
  restoredAt?: string;
}

export interface DupStore {
  result: DupResult | null;
  removed: DupRemoved[];
}

const dataFolder = path.join(__dirname, "..", "data");
const storeFile = path.join(dataFolder, "duplicates.json");
const cacheFile = path.join(dataFolder, "dupe-cache.json");

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(dataFolder, { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

export function loadDupStore(): DupStore {
  try {
    if (fs.existsSync(storeFile)) {
      const s = JSON.parse(fs.readFileSync(storeFile, "utf8"));
      return { result: s.result ?? null, removed: Array.isArray(s.removed) ? s.removed : [] };
    }
  } catch {
    log("duplicates.json could not be read, starting empty");
  }
  return { result: null, removed: [] };
}

export function saveDupStore(store: DupStore) {
  writeJson(storeFile, store);
}

// ---------- the hash cache (so a second search is fast) ----------

interface CacheEntry {
  size: number;
  mtimeMs: number;
  sha?: string;    // SHA-256, only for files that share a size with another file
  gray?: string;   // a 48 x 48 grey thumbnail (base64), the picture's "fingerprint"
  w?: number;
  h?: number;
  bad?: boolean;   // the image could not be read
}
type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
  try {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    // a broken cache is simply rebuilt
  }
  return {};
}

// ---------- looking at one picture ----------

// A small grey thumbnail (48 x 48) of the picture, the right way up. Two copies of the
// same picture (even resized or saved again) give almost the same thumbnail.
async function look(file: string) {
  const meta = await sharp(file, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) throw new Error("not an image");
  const sideways = (meta.orientation ?? 1) >= 5;
  const { data, info } = await sharp(file, { failOn: "none" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(GRID, GRID, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gray = Buffer.alloc(GRID * GRID);
  for (let i = 0; i < GRID * GRID; i++) gray[i] = data[i * info.channels];
  return {
    w: sideways ? meta.height : meta.width,
    h: sideways ? meta.width : meta.height,
    gray: gray.toString("base64"),
  };
}

// 48 x 48 -> 8 x 8 (average of each 6 x 6 block): a quick first check before the full comparison.
function coarse(gray: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  const k = GRID / 8;
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) sum += gray[(by * k + y) * GRID + bx * k + x];
      out[by * 8 + bx] = Math.round(sum / (k * k));
    }
  }
  return out;
}

function isFlat(gray: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let sq = 0;
  for (let i = 0; i < gray.length; i++) sq += (gray[i] - mean) ** 2;
  return Math.sqrt(sq / gray.length) < 3; // a blank page carries no information to compare
}

// Run "fn" on every item, a few at a time.
async function pool<T>(items: T[], parallel: number, stop: () => boolean, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
}

// ---------- FIND ----------

export interface FindHooks {
  setTotal: (n: number) => void;
  tick: () => void;
  stopped: () => boolean;
}

// Look through the images folder for duplicates. This only READS your files.
// Returns null if you clicked Stop.
export async function findDuplicates(config: Config, sensitivity: Sensitivity, hooks: FindHooks): Promise<DupResult | null> {
  const limits = LIMITS[sensitivity];
  const scan = scanFolder(config.imagesFolder);

  // Every image and PDF, with its modified time.
  const files: DupFile[] = [];
  for (const [list, type] of [[scan.images, "image"], [scan.pdfs, "pdf"]] as const) {
    for (const f of list) {
      try {
        const st = fs.statSync(path.join(config.imagesFolder, f.relativePath));
        files.push({ relativePath: f.relativePath, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), type });
      } catch {
        // gone while we were looking: ignore
      }
    }
  }

  const cache = loadCache();
  const fresh: Cache = {}; // the cache we keep: only files that still exist
  const entryOf = (f: DupFile): CacheEntry => {
    if (fresh[f.relativePath]) return fresh[f.relativePath];
    const old = cache[f.relativePath];
    const e = old && old.size === f.sizeBytes && old.mtimeMs === f.mtimeMs ? old : { size: f.sizeBytes, mtimeMs: f.mtimeMs };
    fresh[f.relativePath] = e;
    return e;
  };

  // Files with the same size might be identical: those get a SHA-256 check.
  const bySize = new Map<number, DupFile[]>();
  for (const f of files) bySize.set(f.sizeBytes, [...(bySize.get(f.sizeBytes) ?? []), f]);
  const sameSize = files.filter((f) => (bySize.get(f.sizeBytes)?.length ?? 0) > 1 && f.sizeBytes > 0);
  const images = files.filter((f) => f.type === "image");
  hooks.setTotal(images.length + sameSize.length);
  log(`Duplicate search started: ${images.length} images, ${files.length - images.length} PDFs, ${sameSize.length} files share a size with another`);

  // 1) The grey thumbnail of every image.
  let sinceSave = 0;
  await pool(images, 4, hooks.stopped, async (f) => {
    const e = entryOf(f);
    if ((!e.gray || e.gray.length !== GRAY_B64_LEN) && !e.bad) {
      try {
        const r = await look(path.join(config.imagesFolder, f.relativePath));
        e.gray = r.gray; e.w = r.w; e.h = r.h;
      } catch {
        e.bad = true; // damaged or not really an image: it can still match as an exact copy
      }
    }
    hooks.tick();
    if (++sinceSave >= 300) { sinceSave = 0; writeJson(cacheFile, { ...cache, ...fresh }); }
  });

  // 2) The SHA-256 of files that share a size.
  await pool(sameSize, 3, hooks.stopped, async (f) => {
    const e = entryOf(f);
    if (!e.sha) {
      try { e.sha = await sha256(path.join(config.imagesFolder, f.relativePath)); } catch { /* unreadable: skip */ }
    }
    hooks.tick();
  });

  for (const f of files) entryOf(f); // keep every current file in the cache
  writeJson(cacheFile, fresh);
  if (hooks.stopped()) {
    log("Duplicate search STOPPED by you");
    return null;
  }

  // 3) Put files that belong together into groups (union-find).
  const parent = files.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const index = new Map(files.map((f, i) => [f.relativePath, i]));

  // Identical files (same SHA-256).
  const bySha = new Map<string, number>();
  for (const f of files) {
    const sha = fresh[f.relativePath]?.sha;
    if (!sha) continue;
    const i = index.get(f.relativePath)!;
    const first = bySha.get(sha);
    if (first === undefined) bySha.set(sha, i);
    else join(first, i);
  }

  // Similar pictures.
  interface Item { i: number; aspect: number; coarse: Uint8Array; gray: Uint8Array }
  const items: Item[] = [];
  for (const f of images) {
    const e = fresh[f.relativePath];
    if (!e?.gray || !e.w || !e.h) continue;
    const gray = new Uint8Array(Buffer.from(e.gray, "base64"));
    if (gray.length !== GRID * GRID || isFlat(gray)) continue;
    f.width = e.w; f.height = e.h;
    items.push({ i: index.get(f.relativePath)!, aspect: e.w / e.h, coarse: coarse(gray), gray });
  }
  for (const f of images) { // keep the size of every image for the screen, even blank ones
    const e = fresh[f.relativePath];
    if (e?.w && e?.h) { f.width = e.w; f.height = e.h; }
  }
  items.sort((a, b) => a.aspect - b.aspect);
  for (let x = 0; x < items.length; x++) {
    const a = items[x];
    for (let y = x + 1; y < items.length; y++) {
      const b = items[y];
      if (b.aspect > a.aspect * (1 + limits.aspect)) break; // too different in shape (sorted, so the rest are too)
      if (find(a.i) === find(b.i)) continue;
      // Quick check: do the two pictures have about the same overall light and dark areas?
      let rough = 0;
      for (let k = 0; k < 64; k++) rough += Math.abs(a.coarse[k] - b.coarse[k]);
      if (rough / 64 > 14) continue;
      // Full check: count the pixels that clearly differ. Stop as soon as there are too many.
      const allowed = limits.changed * GRID * GRID;
      let changed = 0;
      for (let k = 0; k < GRID * GRID && changed <= allowed; k++) {
        if (Math.abs(a.gray[k] - b.gray[k]) > PIXEL_DIFF) changed++;
      }
      if (changed > allowed) continue;
      join(a.i, b.i);
    }
    if (hooks.stopped()) return null;
  }

  // 4) Turn the sets into groups.
  const sets = new Map<number, DupFile[]>();
  files.forEach((f, i) => {
    const root = find(i);
    sets.set(root, [...(sets.get(root) ?? []), f]);
  });
  const groups: DupGroup[] = [];
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    const shas = new Set(members.map((m) => fresh[m.relativePath]?.sha ?? m.relativePath));
    const kind = shas.size === 1 ? "exact" : "similar";
    if (kind === "similar") {
      // Tell the screen which files inside the group are exact copies of each other.
      const count = new Map<string, number>();
      for (const m of members) { const h = fresh[m.relativePath]?.sha; if (h) count.set(h, (count.get(h) ?? 0) + 1); }
      const number = new Map<string, number>();
      for (const m of members) {
        const h = fresh[m.relativePath]?.sha;
        if (h && (count.get(h) ?? 0) > 1) {
          if (!number.has(h)) number.set(h, number.size + 1);
          m.twin = number.get(h);
        }
      }
    }
    const keep = suggestKeep(members, kind);
    groups.push({
      id: crypto.createHash("sha1").update(members.map((m) => m.relativePath).sort().join("\n")).digest("hex").slice(0, 12),
      kind,
      files: members.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      keep: keep.relativePath,
      reclaimBytes: members.reduce((s, m) => s + (m === keep ? 0 : m.sizeBytes), 0),
    });
  }
  groups.sort((a, b) => b.reclaimBytes - a.reclaimBytes);

  const result: DupResult = { foundAt: new Date().toISOString(), sensitivity, filesLooked: files.length, groups };
  log(`Duplicate search finished: ${groups.length} groups (${groups.filter((g) => g.kind === "exact").length} identical, ${groups.filter((g) => g.kind === "similar").length} similar)`);
  return result;
}

// Our suggestion for the file to keep.
//  identical: the oldest one (most likely the original), then the shortest path
//  similar:   the one with the most pixels, then the biggest file, then the oldest
function suggestKeep(files: DupFile[], kind: "exact" | "similar"): DupFile {
  const sorted = [...files].sort((a, b) => {
    if (kind === "similar") {
      const pa = (a.width ?? 0) * (a.height ?? 0);
      const pb = (b.width ?? 0) * (b.height ?? 0);
      if (pa !== pb) return pb - pa;
      if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
    }
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    if (a.relativePath.length !== b.relativePath.length) return a.relativePath.length - b.relativePath.length;
    return a.relativePath.localeCompare(b.relativePath);
  });
  return sorted[0];
}

// ---------- MOVE THE EXTRAS TO THE VAULT ----------

export interface RemoveOutcome {
  removed: DupRemoved[];
  freedBytes: number;
}

// Keep ONE file of a group and move all the others to the vault (under "_duplicates").
// Nothing is deleted without a checked copy in the vault. Throws before touching
// anything if a file changed since the search.
export async function removeExtras(config: Config, store: DupStore, groupId: string, keepPath: string): Promise<RemoveOutcome> {
  const group = store.result?.groups.find((g) => g.id === groupId);
  if (!group) throw new Error("That group is no longer in the list. Click Find duplicates again.");
  const keep = group.files.find((f) => f.relativePath === keepPath);
  if (!keep) throw new Error("The file you chose to keep is not in this group.");
  const extras = group.files.filter((f) => f !== keep);
  if (extras.length === 0) throw new Error("There is nothing to remove in this group.");

  // 1) Check everything BEFORE touching any file.
  const same = (f: DupFile) => {
    const abs = safeJoin(config.imagesFolder, f.relativePath);
    if (!fs.existsSync(abs)) throw new Error(`${f.relativePath} is missing now. Click Find duplicates again.`);
    const st = fs.statSync(abs);
    if (st.size !== f.sizeBytes || Math.round(st.mtimeMs) !== f.mtimeMs) {
      throw new Error(`${f.relativePath} changed since the search. Click Find duplicates again.`);
    }
    return abs;
  };
  const keepAbs = same(keep);
  const hashes = new Map<string, string>();
  const keepHash = await sha256(keepAbs);
  for (const f of extras) {
    const abs = same(f);
    const h = await sha256(abs);
    if (group.kind === "exact" && h !== keepHash) {
      throw new Error(`${f.relativePath} is no longer identical to ${keep.relativePath}. Nothing was changed.`);
    }
    hashes.set(f.relativePath, h);
  }

  // 2) One file at a time: copy to the vault, check the copy, then remove the original.
  const removed: DupRemoved[] = [];
  let freedBytes = 0;
  try {
    for (const f of extras) {
      const abs = safeJoin(config.imagesFolder, f.relativePath);
      const hash = hashes.get(f.relativePath)!;
      let vaultRelative = path.join("_duplicates", f.relativePath);
      let vaultFile = safeJoin(config.vaultFolder, vaultRelative);
      if (fs.existsSync(vaultFile) && (await sha256(vaultFile)) !== hash) {
        // A different file already sits there: use a new name, never overwrite.
        const p = path.parse(vaultRelative);
        vaultRelative = path.join(p.dir, `${p.name}.${Date.now()}${p.ext}`);
        vaultFile = safeJoin(config.vaultFolder, vaultRelative);
      }
      fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
      if (!fs.existsSync(vaultFile)) {
        fs.copyFileSync(abs, vaultFile, fs.constants.COPYFILE_EXCL);
        if ((await sha256(vaultFile)) !== hash) {
          fs.rmSync(vaultFile); // our own bad copy
          throw new Error(`The vault copy of ${f.relativePath} did not match (SHA-256). Nothing was removed.`);
        }
      }
      try {
        fs.rmSync(abs);
      } catch {
        throw new Error(`Could not remove ${f.relativePath}. Is it open in another program? The file is untouched; a copy is in the vault.`);
      }
      log(`  duplicate moved to the vault: ${f.relativePath} (kept ${keep.relativePath})`);
      const rec: DupRemoved = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        relativePath: f.relativePath,
        vaultRelative,
        sizeBytes: f.sizeBytes,
        sha256: hash,
        keptPath: keep.relativePath,
        kind: group.kind,
      };
      removed.push(rec);
      store.removed.push(rec);
      freedBytes += f.sizeBytes;
    }
  } finally {
    // Whatever was done, remember it. If every extra went, the group is finished.
    const gone = new Set(removed.map((r) => r.relativePath));
    if (store.result) {
      group.files = group.files.filter((f) => !gone.has(f.relativePath));
      if (group.files.length < 2) store.result.groups = store.result.groups.filter((g) => g !== group);
      else group.reclaimBytes = group.files.reduce((s, f) => s + (f.relativePath === keep.relativePath ? 0 : f.sizeBytes), 0);
    }
    saveDupStore(store);
  }
  return { removed, freedBytes };
}

// ---------- PUT A REMOVED FILE BACK ----------

export async function restoreRemoved(config: Config, store: DupStore, id: string): Promise<string> {
  const rec = store.removed.find((r) => r.id === id);
  if (!rec) throw new Error("That file is not in the removed list.");
  if (rec.restoredAt) throw new Error("This file was already restored.");
  const vaultFile = safeJoin(config.vaultFolder, rec.vaultRelative);
  const target = safeJoin(config.imagesFolder, rec.relativePath);
  if (!fs.existsSync(vaultFile)) throw new Error(`The vault copy is missing: ${vaultFile}`);
  if ((await sha256(vaultFile)) !== rec.sha256) {
    throw new Error(`The vault copy does not match what was saved (SHA-256). Not restoring. File: ${vaultFile}`);
  }
  if (fs.existsSync(target)) {
    if ((await sha256(target)) !== rec.sha256) {
      throw new Error(`A different file now exists at ${rec.relativePath}, so it was NOT overwritten. The copy is safe in the vault.`);
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await copyAndSwap(vaultFile, target, rec.sha256, "sso-dup");
  }
  rec.restoredAt = new Date().toISOString();
  saveDupStore(store);
  return `Restored ${rec.relativePath}. A copy also stays in the vault.`;
}
