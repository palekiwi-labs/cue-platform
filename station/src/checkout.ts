import { runAsync, spawnAsync } from "./git.js";

export async function trackedChanges(repo: string): Promise<string[]> {
  const out = await runAsync(repo, ["status", "--porcelain", "--untracked-files=no"]);
  return out.split("\n").filter((l) => l.trim() !== "");
}

export async function checkoutPr(repo: string, number: number): Promise<string> {
  const dirty = await trackedChanges(repo);
  if (dirty.length > 0) {
    throw new Error(`${repo} has uncommitted changes (${dirty.length} file${dirty.length === 1 ? "" : "s"}); commit or stash first`);
  }
  await spawnAsync("gh", ["pr", "checkout", String(number)], repo);
  const branch = (await runAsync(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const sha = (await runAsync(repo, ["rev-parse", "--short=10", "HEAD"])).trim();
  return `${repo} is on ${branch} at ${sha}`;
}
