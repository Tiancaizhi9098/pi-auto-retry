import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LIMIT = 10;

export function parseLimit(value) {
  if (!/^\d+$/.test(String(value).trim())) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export function readLimit(path) {
  try {
    const value = parseLimit(JSON.parse(readFileSync(path, "utf8")).maxRetries);
    if (value === undefined) throw new Error("maxRetries must be a non-negative integer");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_LIMIT;
    throw error;
  }
}

export function writeLimit(path, maxRetries) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify({ maxRetries }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
