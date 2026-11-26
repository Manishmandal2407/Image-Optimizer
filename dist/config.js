"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isInside = isInside;
exports.loadConfig = loadConfig;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// On Windows, "C:\Photos" and "c:\photos" are the same folder,
// so we compare in lower case there.
function normalize(p) {
    const full = path_1.default.resolve(p);
    return process.platform === "win32" ? full.toLowerCase() : full;
}
// True if "child" is the same as "parent" or sits somewhere inside it.
function isInside(child, parent) {
    const rel = path_1.default.relative(normalize(parent), normalize(child));
    return rel === "" || (!rel.startsWith("..") && !path_1.default.isAbsolute(rel));
}
// Read config.json and check it. Throws an Error with a plain message if
// something is wrong.
function loadConfig() {
    const configPath = path_1.default.join(__dirname, "..", "config.json");
    if (!fs_1.default.existsSync(configPath)) {
        throw new Error(`config.json was not found. Expected it here: ${configPath}`);
    }
    let config;
    try {
        config = JSON.parse(fs_1.default.readFileSync(configPath, "utf8"));
    }
    catch {
        throw new Error("config.json is not valid JSON. Check commas and quotes.");
    }
    // All three settings must be present, non-empty text.
    const names = ["imagesFolder", "vaultFolder", "workFolder"];
    for (const name of names) {
        if (typeof config[name] !== "string" || config[name].trim() === "") {
            throw new Error(`config.json: "${name}" is missing or empty.`);
        }
    }
    // The three folders must be different, and none inside another.
    for (let i = 0; i < names.length; i++) {
        for (let j = 0; j < names.length; j++) {
            if (i !== j && isInside(config[names[i]], config[names[j]])) {
                throw new Error(`Unsafe folders: "${names[i]}" (${config[names[i]]}) is the same as, or inside, ` +
                    `"${names[j]}" (${config[names[j]]}). The three folders must be completely separate.`);
            }
        }
    }
    // The images folder must already exist (we never create it for you).
    if (!fs_1.default.existsSync(config.imagesFolder) || !fs_1.default.statSync(config.imagesFolder).isDirectory()) {
        throw new Error(`imagesFolder does not exist: ${config.imagesFolder}`);
    }
    // The vault and work folders are created if they do not exist yet.
    fs_1.default.mkdirSync(config.vaultFolder, { recursive: true });
    fs_1.default.mkdirSync(config.workFolder, { recursive: true });
    return config;
}
