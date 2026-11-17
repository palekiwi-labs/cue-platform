import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeRoot } from "./findings.js";
import { runAsync } from "./git.js";
import { ensureWorktree } from "./source.js";

export interface RunEntry {
  address: string;
  runId: string;
  head: string;
  state: string;
  verified: boolean;
}

export function prContext(repoSlug: string, pr: number): string {
  return `${repoSlug}/review-pr-${pr}`;
}

export function listRuns(repoSlug: string, pr: number, store = storeRoot()): RunEntry[] {
  const base = `${prContext(repoSlug, pr)}/review/runs`;
  const dir = join(store, base);
  if (!existsSync(dir)) return [];
  const out: RunEntry[] = [];
  for (const runId of readdirSync(dir)) {
    const runPath = join(dir, runId, "run.json");
    if (!existsSync(runPath)) continue;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const verified = readdirSync(join(dir, runId)).some((n) => /^verifiers-.+\.json$/.test(n));
    out.push({
      address: `${base}/${runId}`,
      runId,
      head: typeof meta.head === "string" ? meta.head : "",
      state: typeof meta.state === "string" ? meta.state : "unknown",
      verified,
    });
  }
  return out.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

export function findingsWorktreePath(repo: string, pr: number): string {
  return join(repo, "worktrees", "review", `pr-${pr}-findings`);
}

export async function findingsWorktree(repo: string, pr: number, head: string): Promise<string> {
  const path = findingsWorktreePath(repo, pr);
  if (existsSync(path)) {
    const current = (await runAsync(path, ["rev-parse", "HEAD"])).trim();
    if (current === head) return path;
    if ((await runAsync(path, ["status", "--porcelain"])).trim() !== "") {
      throw new Error(`findings worktree has uncommitted changes, not moving it to ${head.slice(0, 10)}: ${path}`);
    }
  }
  await ensureWorktree(repo, path, head);
  return path;
}
