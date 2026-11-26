"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// The log file lives in the "data" folder next to the project.
const dataFolder = path_1.default.join(__dirname, "..", "data");
const logFile = path_1.default.join(dataFolder, "app.log");
// Write one line to the log file (and also show it in the terminal).
function log(message) {
    fs_1.default.mkdirSync(dataFolder, { recursive: true }); // make "data" if missing
    const line = `${new Date().toISOString()}  ${message}\n`;
    fs_1.default.appendFileSync(logFile, line);
    console.log(line.trim());
}
