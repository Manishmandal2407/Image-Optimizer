import path from "path";
import { isInside } from "./config";

// Join a root folder and a relative path, but REFUSE if the result would
// end up outside the root (for example "..\..\Windows\file.jpg").
// We use this every time we touch a file, as a safety net.
export function safeJoin(root: string, relativePath: string): string {
  const full = path.resolve(root, relativePath);
  if (relativePath.trim() === "" || !isInside(full, root)) {
    throw new Error(`Unsafe path refused: ${relativePath}`);
  }
  return full;
}
