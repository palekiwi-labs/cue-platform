import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "./reconcile";
import type { RunRecord } from "./run";
import { parseBatchSpec } from "./spec";
import { writeJsonAtomic } from "./store";
import { cleanupWorktree, createWorktree, planWorktree } from "./worktree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sup-worktree-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "file"), "initial");
  git(repo, "add", "file");
  git(repo, "commit", "-m", "initial");
  const runDir = join(root, "state", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "session"));
  const record: RunRecord = {
    runId: "r1", batchId: "b1", unit: "u-r1", slice: "s-b1", sessionId: "sid", acceptedAt: 0,
    spec: { cwd: repo, context: "ctx", prompt: "hi", worktree: { base: "HEAD" } },
    worktree: planWorktree(repo, "HEAD", "r1"),
  };
  writeJsonAtomic(join(runDir, "run.json"), record);
  const result = () => writeJsonAtomic(join(runDir, "result.json"), { outcome: "succeeded" });
  const state = () => JSON.parse(readFileSync(join(runDir, "cleanup.json"), "utf8"));
  return { root, repo, runDir, record, tree: record.worktree!, result, state };
}

describe("owned supervisor worktrees", () => {
  test("normalizes the caller worktree request and rejects malformed requests", () => {
    const run = { cwd: "/tmp", context: "ctx", prompt: "hi" };
    expect(parseBatchSpec({ runs: [{ ...run, worktree: true }] }).runs[0].worktree).toEqual({ base: "HEAD" });
    expect(parseBatchSpec({ runs: [{ ...run, worktree: false }] }).runs[0].worktree).toBeUndefined();
    expect(parseBatchSpec({ runs: [{ ...run, worktree: { base: "abc" } }] }).runs[0].worktree).toEqual({ base: "abc" });
    for (const worktree of [null, "HEAD", {}, { base: "" }, { base: "HEAD", path: "/tmp" }]) {
      expect(() => parseBatchSpec({ runs: [{ ...run, worktree }] })).toThrow("worktree");
    }
  });

  test("creates a pinned detached checkout and removes it only after the result", () => {
    const { repo, runDir, record, tree, result, state } = setup();
    writeFileSync(join(repo, "file"), "later");
    git(repo, "commit", "-am", "later");
    createWorktree(record);
    expect(git(tree.path, "rev-parse", "HEAD")).toBe(tree.commit);
    expect(git(tree.path, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(tree.path, "file"), "utf8")).toBe("initial");
    expect(cleanupWorktree(runDir, record)).toBeNull();
    expect(existsSync(tree.path)).toBe(true);
    result();
    expect(cleanupWorktree(runDir, record)?.status).toBe("complete");
    expect(existsSync(tree.path)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(tree.path);
    cleanupWorktree(runDir, record);
    expect(state().attempts).toBe(1);
    expect(existsSync(join(runDir, "session"))).toBe(true);
  });

  test("refuses foreign ownership, then retries successfully after repair", () => {
    const { runDir, record, tree, result, state } = setup();
    createWorktree(record);
    result();
    const marker = join(git(tree.path, "rev-parse", "--absolute-git-dir"), "cue-supervisor-owner.json");
    const original = readFileSync(marker, "utf8");
    writeJsonAtomic(marker, { ...JSON.parse(original), runId: "other" });
    expect(cleanupWorktree(runDir, record)?.error).toContain("ownership mismatch");
    expect(existsSync(tree.path)).toBe(true);
    writeFileSync(marker, original);
    expect(cleanupWorktree(runDir, record)?.status).toBe("complete");
    expect(state().attempts).toBe(2);
  });

  test("preserves dirty files and retries cleanup without changing the result", () => {
    const { root, runDir, record, tree, result, state } = setup();
    createWorktree(record);
    result();
    const before = readFileSync(join(runDir, "result.json"), "utf8");
    writeFileSync(join(tree.path, "untracked"), "keep me");
    reconcile(join(root, "state"), () => false);
    expect(state().status).toBe("failed");
    expect(readFileSync(join(tree.path, "untracked"), "utf8")).toBe("keep me");
    rmSync(join(tree.path, "untracked"));
    reconcile(join(root, "state"), () => false);
    expect(state().status).toBe("complete");
    expect(state().attempts).toBe(2);
    expect(readFileSync(join(runDir, "result.json"), "utf8")).toBe(before);
  });

  test("recovery retains a live checkout, derives a lost result and cleans up", () => {
    const { root, runDir, record, tree, state } = setup();
    createWorktree(record);
    writeJsonAtomic(join(runDir, "outcome.json"), {
      serviceResult: "success", exitCode: "exited", exitStatus: "0", finalizedAt: 5,
    });
    reconcile(join(root, "state"), () => true);
    expect(existsSync(join(tree.path, "file"))).toBe(true);
    expect(existsSync(join(runDir, "cleanup.json"))).toBe(false);
    reconcile(join(root, "state"), () => false);
    expect(state().status).toBe("complete");
    expect(existsSync(tree.path)).toBe(false);
  });

  test("a user-manager connection failure cannot authorize cleanup", () => {
    const { root, runDir, record, tree, result } = setup();
    createWorktree(record);
    result();
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "cli.ts"), "reconcile"], {
      env: { ...process.env, CUE_SUPERVISOR_STATE: join(root, "state"),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "missing-bus")}`,
        XDG_RUNTIME_DIR: join(root, "missing-runtime") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(existsSync(tree.path)).toBe(true);
    expect(existsSync(join(runDir, "cleanup.json"))).toBe(false);
    reconcile(join(root, "state"), () => false);
    expect(existsSync(tree.path)).toBe(false);
  });

  test("unknown recovery cleans owned worktrees without relaunching", () => {
    const { root, runDir, record, tree, state } = setup();
    createWorktree(record);
    expect(reconcile(join(root, "state"), () => false).r1).toBe("unknown");
    expect(state().status).toBe("complete");
    expect(existsSync(tree.path)).toBe(false);
    expect(existsSync(join(runDir, "started.json"))).toBe(false);
  });

  test("a crash before ownership stamping leaves a visible cleanup failure", () => {
    const { runDir, record, tree, result } = setup();
    git(tree.repo, "worktree", "list", "--porcelain");
    git(tree.repo, "worktree", "add", "--detach", tree.path, tree.commit);
    result();
    expect(cleanupWorktree(runDir, record)?.status).toBe("failed");
    expect(existsSync(tree.path)).toBe(true);
  });

  test("retries prune after the checkout has already been removed", () => {
    const { runDir, record, tree, result } = setup();
    createWorktree(record);
    result();
    rmSync(tree.path, { recursive: true });
    expect(cleanupWorktree(runDir, record)?.status).toBe("complete");
    expect(git(tree.repo, "worktree", "list", "--porcelain")).not.toContain(tree.path);
  });

  test("path mismatch cannot remove a checkout and creation never reuses one", () => {
    const { runDir, record, tree, result } = setup();
    createWorktree(record);
    expect(() => createWorktree(record)).toThrow("already exists");
    expect(() => planWorktree(tree.repo, "HEAD", record.runId)).toThrow("already exists");
    expect(() => planWorktree(tree.repo, "--help", "r2")).toThrow();
    result();
    const other = { ...record, worktree: { ...tree, path: tree.repo } };
    expect(cleanupWorktree(runDir, other)?.error).toContain("path does not match");
    expect(existsSync(join(tree.repo, "file"))).toBe(true);
    expect(existsSync(join(tree.path, "file"))).toBe(true);
  });
});
