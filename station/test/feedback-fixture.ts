import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedbackSnapshot, ReviewThread, ThreadComment } from "../src/github-feedback.js";

export interface GitFixture {
  root: string;
  repo: string;
  git: (...args: string[]) => string;
  base: string;
  baseTip: string;
  first: string;
  head: string;
  cleanup: () => void;
}

const lines = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n") + "\n";

/**
 * main: base (a.ts l1..l10, old.ts o1..o5), then baseTip touching only c.ts.
 * pr branch from base: first (l5 -> changed5, l8 deleted, old.ts renamed to
 * new.ts with o5 -> new5), then head (two lines inserted on top of a.ts).
 */
export function gitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "station-feedback-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const write = (file: string, text: string): void => writeFileSync(join(repo, file), text);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("a.ts", lines("l", 10));
  write("old.ts", lines("o", 5));
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "pr");
  write("a.ts", lines("l", 10).replace("l5\n", "changed5\n").replace("l8\n", ""));
  git("mv", "old.ts", "new.ts");
  write("new.ts", lines("o", 5).replace("o5\n", "new5\n"));
  git("add", ".");
  git("commit", "-qm", "first");
  const first = git("rev-parse", "HEAD");
  write("a.ts", "top1\ntop2\n" + lines("l", 10).replace("l5\n", "changed5\n").replace("l8\n", ""));
  git("commit", "-qam", "second");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  write("c.ts", "c\n");
  git("add", ".");
  git("commit", "-qm", "main moves on");
  const baseTip = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", head);
  return { root, repo, git, base, baseTip, first, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function comment(over: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id: "c1", database_id: "1", author: { login: "alice", type: "User", association: "MEMBER" },
    body: "please rename", state: "SUBMITTED", created_at: "2025-01-02T03:04:05Z", updated_at: null,
    last_edited_at: null, url: "https://github.com/org/repo/pull/7#discussion_r1", is_minimized: false,
    minimized_reason: null, reply_to: null, review_id: "R1", review_state: "COMMENTED", path: "a.ts",
    commit: null, original_commit: null, line: null, original_line: null, start_line: null,
    original_start_line: null, outdated: false, diff_hunk: null, ...over,
  };
}

export function thread(over: Partial<ReviewThread> = {}, c: Partial<ThreadComment> = {}): ReviewThread {
  const comments = over.comments ?? [comment(c)];
  return {
    id: "T1", path: "a.ts", subject_type: "LINE", diff_side: "RIGHT", start_diff_side: null, line: null,
    start_line: null, original_line: null, original_start_line: null, is_resolved: false, is_outdated: false,
    is_collapsed: false, resolved_by: null, comments_total: comments.length, ...over, comments,
  };
}

export function snapshot(f: { head: string; baseTip: string }, threads: ReviewThread[] = [], over: Partial<FeedbackSnapshot> = {}): FeedbackSnapshot {
  return {
    schema: "station/github-feedback@1",
    fetched_at: "2025-01-03T00:00:00Z",
    source: "github-graphql",
    repo: "org/repo",
    pr: {
      number: 7, title: "Rename things", url: null, state: "OPEN", is_draft: false, author: "bob",
      head_ref: "pr", base_ref: "main", head_sha: f.head, base_sha: f.baseTip,
    },
    threads,
    conversation: [],
    omitted_reviews: 0,
    ...over,
  };
}

export const RIGHT_HUNK = "@@ -2,4 +2,4 @@\n l2\n l3\n l4\n-l5\n+changed5";
export const LEFT_HUNK = "@@ -6,3 +6,2 @@\n l6\n l7\n-l8";
export const RENAME_HUNK = "@@ -1,3 +1,3 @@\n o1\n o2\n o3";
