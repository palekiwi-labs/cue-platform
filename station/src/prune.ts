import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAsync } from "./git.js";

export interface PruneResult {
  removed: number[];
  kept: number[];
}

export async function pruneReviews(repo: string, open: Set<number>): Promise<PruneResult> {
  const dir = join(repo, "worktrees", "review");
  const result: PruneResult = { removed: [], kept: [] };
  const refs = (await runAsync(repo, ["for-each-ref", "--format=%(refname)", "refs/station/pr/"])).split("\n");
  const numbers = new Set<number>();
  for (const r of refs) {
    const m = r.match(/^refs\/station\/pr\/(\d+)\//);
    if (m) numbers.add(Number(m[1]));
  }
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^pr-(\d+)$/);
      if (m) numbers.add(Number(m[1]));
    }
  }
  for (const n of [...numbers].sort((a, b) => a - b)) {
    if (open.has(n)) continue;
    const wt = join(dir, `pr-${n}`);
    if (existsSync(wt)) {
      const dirty = (await runAsync(wt, ["status", "--porcelain"])).trim() !== "";
      if (dirty) {
        result.kept.push(n);
        continue;
      }
      await runAsync(repo, ["worktree", "remove", "--force", wt]);
    }
    for (const side of ["head", "base"]) {
      await runAsync(repo, ["update-ref", "-d", `refs/station/pr/${n}/${side}`]).catch(() => "");
    }
    result.removed.push(n);
  }
  await runAsync(repo, ["worktree", "prune"]);
  return result;
}
