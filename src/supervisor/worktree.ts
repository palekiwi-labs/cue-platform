import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "./run";
import { readJsonIfExists, writeJsonAtomic } from "./store";

export interface WorktreeRecord {
  repo: string;
  path: string;
  commit: string;
  owner: string;
}

export interface CleanupState {
  status: "complete" | "failed";
  attempts: number;
  error?: string;
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args[0]}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

function worktrees(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
    .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

/** Resolves the revision and reserves an owned path without creating a checkout. */
export function planWorktree(cwd: string, base: string, runId: string): WorktreeRecord {
  const repo = realpathSync(worktrees(cwd)[0]);
  const commit = git(cwd, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`);
  const path = join(repo, "worktrees", `cue-run-${runId}`);
  if (existsSync(path) || worktrees(repo).includes(path)) throw new Error(`worktree path already exists: ${path}`);
  return { repo, path, commit, owner: crypto.randomUUID() };
}

function markerPath(path: string): string {
  return join(git(path, "rev-parse", "--absolute-git-dir"), "cue-supervisor-owner.json");
}

/** Creates the detached checkout and stamps its per-worktree Git metadata. */
export function createWorktree(record: RunRecord): void {
  const tree = record.worktree!;
  if (worktrees(tree.repo).includes(tree.path) || existsSync(tree.path)) {
    throw new Error(`worktree path already exists: ${tree.path}`);
  }
  git(tree.repo, "worktree", "add", "--detach", tree.path, tree.commit);
  writeJsonAtomic(markerPath(tree.path), { runId: record.runId, ...tree });
}

/** Removes only an owned, clean checkout after its result has been recorded. */
export function cleanupWorktree(runDir: string, record: RunRecord): CleanupState | null {
  const tree = record.worktree;
  if (!tree || !existsSync(join(runDir, "result.json"))) return null;
  const statePath = join(runDir, "cleanup.json");
  const previous = readJsonIfExists<CleanupState>(statePath);
  if (previous?.status === "complete") return previous;
  const attempts = (previous?.attempts ?? 0) + 1;
  let state: CleanupState;
  try {
    if (tree.path !== join(tree.repo, "worktrees", `cue-run-${record.runId}`)) {
      throw new Error("worktree path does not match owning run");
    }
    if (existsSync(tree.path)) {
      if (realpathSync(tree.path) !== tree.path || !worktrees(tree.repo).includes(tree.path)) {
        throw new Error("worktree path is not the registered checkout");
      }
      const marker = JSON.parse(readFileSync(markerPath(tree.path), "utf8"));
      if (marker.runId !== record.runId || marker.owner !== tree.owner || marker.path !== tree.path ||
          marker.repo !== tree.repo || marker.commit !== tree.commit) {
        throw new Error("worktree ownership mismatch");
      }
      git(tree.repo, "worktree", "remove", tree.path);
    }
    git(tree.repo, "worktree", "prune");
    state = { status: "complete", attempts };
  } catch (error) {
    state = { status: "failed", attempts, error: error instanceof Error ? error.message : String(error) };
  }
  writeJsonAtomic(statePath, state);
  return state;
}
