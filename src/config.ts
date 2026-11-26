import fs from "fs";
import path from "path";

export interface Config {
  imagesFolder: string;
  vaultFolder: string;
  workFolder: string;
}

// On Windows, "C:\Photos" and "c:\photos" are the same folder,
// so we compare in lower case there.
function normalize(p: string): string {
  const full = path.resolve(p);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

// True if "child" is the same as "parent" or sits somewhere inside it.
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Read config.json and check it. Throws an Error with a plain message if
// something is wrong.
export function loadConfig(): Config {
  const configPath = path.join(__dirname, "..", "config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json was not found. Expected it here: ${configPath}`);
  }

  let config: Config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("config.json is not valid JSON. Check commas and quotes.");
  }

  // All three settings must be present, non-empty text.
  const names = ["imagesFolder", "vaultFolder", "workFolder"] as const;
  for (const name of names) {
    if (typeof config[name] !== "string" || config[name].trim() === "") {
      throw new Error(`config.json: "${name}" is missing or empty.`);
    }
  }

  // The three folders must be different, and none inside another.
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i !== j && isInside(config[names[i]], config[names[j]])) {
        throw new Error(
          `Unsafe folders: "${names[i]}" (${config[names[i]]}) is the same as, or inside, ` +
          `"${names[j]}" (${config[names[j]]}). The three folders must be completely separate.`
        );
      }
    }
  }

  // The images folder must already exist (we never create it for you).
  if (!fs.existsSync(config.imagesFolder) || !fs.statSync(config.imagesFolder).isDirectory()) {
    throw new Error(`imagesFolder does not exist: ${config.imagesFolder}`);
  }

  // The vault and work folders are created if they do not exist yet.
  fs.mkdirSync(config.vaultFolder, { recursive: true });
  fs.mkdirSync(config.workFolder, { recursive: true });

  return config;
}
