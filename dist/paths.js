"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeJoin = safeJoin;
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
// Join a root folder and a relative path, but REFUSE if the result would
// end up outside the root (for example "..\..\Windows\file.jpg").
// We use this every time we touch a file, as a safety net.
function safeJoin(root, relativePath) {
    const full = path_1.default.resolve(root, relativePath);
    if (relativePath.trim() === "" || !(0, config_1.isInside)(full, root)) {
        throw new Error(`Unsafe path refused: ${relativePath}`);
    }
    return full;
}
