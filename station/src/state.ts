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

/** A draft on a walkthrough step; legacy entries omit the walkthrough address. */
export interface WalkthroughDraft {
  id: string;
  walkthrough?: string;
  chunk: string;
  section: number;
  section_title: string;
  step: number;
  fingerprint: string;
  text: string;
  created_at: number;
}

export interface WalkthroughCommentState {
  schema: "station/walkthrough-comments@1";
  comments: WalkthroughDraft[];
}

export function stepFingerprint(markdown: string): string {
  return createHash("sha1").update(markdown).digest("hex").slice(0, 16);
}

export function emptyWalkthroughComments(): WalkthroughCommentState {
  return { schema: "station/walkthrough-comments@1", comments: [] };
}

function validWalkthroughDraft(c: unknown): c is WalkthroughDraft {
  if (typeof c !== "object" || c === null) return false;
  const d = c as Record<string, unknown>;
  const index = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
  return (
    ["id", "chunk", "section_title", "fingerprint", "text"].every((k) => typeof d[k] === "string") &&
    (d.walkthrough === undefined || typeof d.walkthrough === "string") &&
    index(d.section) &&
    index(d.step) &&
    typeof d.created_at === "number"
  );
}

export function parseWalkthroughComments(text: string | null): WalkthroughCommentState {
  if (text === null) return emptyWalkthroughComments();
  try {
    const raw = JSON.parse(text) as Partial<WalkthroughCommentState>;
    if (raw.schema !== "station/walkthrough-comments@1" || !Array.isArray(raw.comments)) return emptyWalkthroughComments();
    return { schema: "station/walkthrough-comments@1", comments: raw.comments.filter(validWalkthroughDraft) };
  } catch {
    return emptyWalkthroughComments();
  }
}

export function loadWalkthroughComments(key: string): WalkthroughCommentState {
  return parseWalkthroughComments(readCache("walkthrough-comments", key));
}

export function saveWalkthroughComments(key: string, state: WalkthroughCommentState): void {
  writeCache("walkthrough-comments", key, state);
}
