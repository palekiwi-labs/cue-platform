import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUE_SUPERVISOR_STATE ?? join(homedir(), ".local", "state", "cue-supervisor");
}

export function runsDir(root: string): string {
  return join(root, "runs");
}

export function batchesDir(root: string): string {
  return join(root, "batches");
}

export function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const random = crypto.getRandomValues(new Uint8Array(3));
  return stamp + "-" + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
