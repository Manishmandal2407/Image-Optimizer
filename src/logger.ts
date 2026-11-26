import fs from "fs";
import path from "path";

// The log file lives in the "data" folder next to the project.
const dataFolder = path.join(__dirname, "..", "data");
const logFile = path.join(dataFolder, "app.log");

// Write one line to the log file (and also show it in the terminal).
export function log(message: string): void {
  fs.mkdirSync(dataFolder, { recursive: true }); // make "data" if missing
  const line = `${new Date().toISOString()}  ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(line.trim());
}
