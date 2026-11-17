import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FoldState {
  schema: "station/folds@1";
  files: string[];
  chunks: string[];
}

export interface DraftComment {
  id: string;
  path: string;
  chunk: string;
  from: number | null;
  to: number | null;
  text: string;
  created_at: number;
}

export interface CommentState {
  schema: "station/comments@1";
  comments: DraftComment[];
}

export function chunkFingerprint(path: string, patch: string): string {
  return createHash("sha1").update(path).update("\n").update(patch).digest("hex").slice(0, 16);
}

function cachePath(kind: string, key: string): string {
  return join(homedir(), ".cache", "station", kind, `${key}.json`);
}

function readCache(kind: string, key: string): string | null {
  try {
    return readFileSync(cachePath(kind, key), "utf8");
  } catch {
    return null;
  }
}

function writeCache(kind: string, key: string, value: unknown): void {
  const path = cachePath(kind, key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
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

export function loadFolds(key: string): FoldState {
  return parseFolds(readCache("folds", key));
}

export function saveFolds(key: string, folds: FoldState): void {
  writeCache("folds", key, folds);
}

export function emptyComments(): CommentState {
  return { schema: "station/comments@1", comments: [] };
}

function validComment(c: unknown): c is DraftComment {
  if (typeof c !== "object" || c === null) return false;
  const d = c as Record<string, unknown>;
  const line = (v: unknown): boolean => v === null || typeof v === "number";
  return (
    typeof d.id === "string" &&
    typeof d.path === "string" &&
    typeof d.chunk === "string" &&
    typeof d.text === "string" &&
    typeof d.created_at === "number" &&
    line(d.from) &&
    line(d.to)
  );
}

export function parseComments(text: string | null): CommentState {
  if (text === null) return emptyComments();
  try {
    const raw = JSON.parse(text) as Partial<CommentState>;
    if (raw.schema !== "station/comments@1" || !Array.isArray(raw.comments)) return emptyComments();
    return { schema: "station/comments@1", comments: raw.comments.filter(validComment) };
  } catch {
    return emptyComments();
  }
}

export function loadComments(key: string): CommentState {
  return parseComments(readCache("comments", key));
}

export function saveComments(key: string, comments: CommentState): void {
  writeCache("comments", key, comments);
}

export type ReaderKind = "finding" | "walkthrough";

/** A draft comment on one Markdown block of a finding or walkthrough step. */
export interface ReaderComment {
  id: string;
  kind: ReaderKind;
  source: string;
  item: string;
  item_title: string;
  section: string;
  block: number;
  quote: string;
  text: string;
  created_at: number;
}

export interface ReaderCommentState {
  schema: "station/reader-comments@1";
  comments: ReaderComment[];
}

export function emptyReaderComments(): ReaderCommentState {
  return { schema: "station/reader-comments@1", comments: [] };
}

function validReaderComment(c: unknown): c is ReaderComment {
  if (typeof c !== "object" || c === null) return false;
  const d = c as Record<string, unknown>;
  const s = (k: string): boolean => typeof d[k] === "string";
  return (
    (d.kind === "finding" || d.kind === "walkthrough") &&
    ["id", "source", "item", "item_title", "section", "quote", "text"].every(s) &&
    typeof d.block === "number" &&
    typeof d.created_at === "number"
  );
}

export function parseReaderComments(text: string | null): ReaderCommentState {
  if (text === null) return emptyReaderComments();
  try {
    const raw = JSON.parse(text) as Partial<ReaderCommentState>;
    if (raw.schema !== "station/reader-comments@1" || !Array.isArray(raw.comments)) return emptyReaderComments();
    return { schema: "station/reader-comments@1", comments: raw.comments.filter(validReaderComment) };
  } catch {
    return emptyReaderComments();
  }
}

export function loadReaderComments(key: string): ReaderCommentState {
  return parseReaderComments(readCache("reader-comments", key));
}

export function saveReaderComments(key: string, state: ReaderCommentState): void {
  writeCache("reader-comments", key, state);
}
