import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "./git.js";

/** A comment on diff lines or a whole diff chunk; `chunk` is the chunk fingerprint. */
export interface DiffRoundComment {
  target: "diff";
  path: string;
  chunk: string;
  outdated: boolean;
  anchor: "lines" | "chunk";
  sides: ("old" | "new")[];
  old_lines: [number, number] | null;
  new_lines: [number, number] | null;
  snippet: string | null;
  text: string;
  created_at: number;
}

/**
 * A comment on one walkthrough step: `chunk` is the walkthrough chunk id,
 * `section` the section title and `step` the zero-based step index in it.
 * `first_line`, `path` and `lines` describe the step and are null when it is
 * outdated (the walkthrough was regenerated) or has no code snippet.
 */
export interface WalkthroughRoundComment {
  target: "walkthrough";
  chunk: string;
  section: string;
  step: number;
  first_line: string | null;
  path: string | null;
  lines: [number, number] | null;
  outdated: boolean;
  text: string;
  created_at: number;
}

export type RoundComment = DiffRoundComment | WalkthroughRoundComment;

export interface RoundTarget {
  repo: string;
  key: string;
  title: string;
  branch: string | null;
  pr: number | null;
}

/** One submitted review round: every draft comment of the review, diff and walkthrough. */
export interface Round {
  schema: "station/round@2";
  repo: string;
  review_key: string;
  title: string;
  branch: string | null;
  pr: number | null;
  base_sha: string;
  head_sha: string;
  submitted_at: number;
  comments: RoundComment[];
}

export function buildRound(target: RoundTarget, baseSha: string, headSha: string, comments: RoundComment[], now: number): Round {
  return {
    schema: "station/round@2",
    repo: target.repo,
    review_key: target.key,
    title: target.title,
    branch: target.branch,
    pr: target.pr,
    base_sha: baseSha,
    head_sha: headSha,
    submitted_at: now,
    comments,
  };
}

/** Same rule as cue-review's slugify, for the default review context. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll("/", "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function reviewContext(branch: string | null, pr: number | null, override: string | null): string {
  if (pr !== null) {
    if (override !== null) throw new Error(`--context is not allowed for PR reviews; rounds go to review-pr-${pr}`);
    return `review-pr-${pr}`;
  }
  if (override !== null) return override;
  if (branch === null || branch === "HEAD" || slugify(branch) === "") {
    throw new Error("no branch to name the review context; pass --context <slug>");
  }
  return `review-${slugify(branch)}`;
}

export function roundName(now: number): string {
  return `station/round-${now}.json`;
}

export async function ensureContext(dir: string, context: string, title: string): Promise<string> {
  let status: string;
  try {
    status = await spawnAsync("cue", ["status", "-C", dir, "--context", context, "--json"], dir);
  } catch {
    await spawnAsync("cue", ["context", "create", context, "--title", title, "--mode", "review", "-C", dir], dir);
    status = await spawnAsync("cue", ["status", "-C", dir, "--context", context, "--json"], dir);
  }
  return (JSON.parse(status) as { address: string }).address;
}

/** Writes the round as a review artifact and returns its canonical address. */
export async function submitRound(dir: string, context: string, round: Round): Promise<string> {
  const address = await ensureContext(dir, context, `Review ${round.branch ?? context}`);
  const name = roundName(round.submitted_at);
  const tmp = mkdtempSync(join(tmpdir(), "station-round-"));
  try {
    const file = join(tmp, "round.json");
    writeFileSync(file, JSON.stringify(round, null, 2) + "\n");
    await spawnAsync("cue", ["add", "-t", "review", "-C", dir, "--context", context, name, "--file", file], dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return `${address}/review/${name}`;
}

export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}
