import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FoldState {
  schema: "station/folds@1";
  files: string[];
  chunks: string[];
}

export function chunkFingerprint(path: string, patch: string): string {
  return createHash("sha1").update(path).update("\n").update(patch).digest("hex").slice(0, 16);
}

export function emptyFolds(): FoldState {
  return { schema: "station/folds@1", files: [], chunks: [] };
}

export function parseFolds(text: string | null): FoldState {
  if (text === null) return emptyFolds();
  try {
    const raw = JSON.parse(text) as Partial<FoldState>;
    if (raw.schema !== "station/folds@1") return emptyFolds();
    return { schema: "station/folds@1", files: raw.files ?? [], chunks: raw.chunks ?? [] };
  } catch {
    return emptyFolds();
  }
}

export function foldsPath(key: string): string {
  return join(homedir(), ".cache", "station", "folds", `${key}.json`);
}

export function loadFolds(key: string): FoldState {
  try {
    return parseFolds(readFileSync(foldsPath(key), "utf8"));
  } catch {
    return emptyFolds();
  }
}

export function saveFolds(key: string, folds: FoldState): void {
  const path = foldsPath(key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(folds, null, 2) + "\n");
  renameSync(tmp, path);
}
