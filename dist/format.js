"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatBytes = formatBytes;
// Turn 2345678 into "2.24 MB" (used in messages and the log).
function formatBytes(bytes) {
    if (bytes >= 1024 * 1024 * 1024)
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (bytes >= 1024 * 1024)
        return (bytes / 1024 / 1024).toFixed(2) + " MB";
    if (bytes >= 1024)
        return (bytes / 1024).toFixed(0) + " KB";
    return bytes + " B";
}
