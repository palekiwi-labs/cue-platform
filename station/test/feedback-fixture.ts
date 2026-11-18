import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedbackResult, FeedbackThread, FeedbackThreadComment, PrFeedback } from "../../github-service/src/protocol.js";

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

export function comment(over: Partial<FeedbackThreadComment> = {}): FeedbackThreadComment {
  return {
    id: "c1", databaseId: "1", author: { login: "alice", type: "User", association: "MEMBER" },
    body: "please rename", state: "SUBMITTED", createdAt: "2025-01-02T03:04:05Z", updatedAt: null,
    lastEditedAt: null, url: "https://github.com/org/repo/pull/7#discussion_r1", isMinimized: false,
    minimizedReason: null, replyTo: null, reviewId: "R1", reviewState: "COMMENTED", path: "a.ts",
    commit: null, originalCommit: null, line: null, originalLine: null, startLine: null,
    originalStartLine: null, outdated: false, ...over,
  };
}

export function thread(over: Partial<FeedbackThread> = {}, c: Partial<FeedbackThreadComment> = {}): FeedbackThread {
  const { diffHunk, ...rest } = c;
  const comments = over.comments ?? [comment(rest)];
  return {
    id: "T1", path: "a.ts", subjectType: "LINE", diffSide: "RIGHT", startDiffSide: null, line: null,
    startLine: null, originalLine: null, originalStartLine: null, isResolved: false, isOutdated: false,
    isCollapsed: false, resolvedBy: null, commentsTotal: comments.length, diffHunk: diffHunk ?? null, ...over, comments,
  };
}

export function snapshot(f: { head: string; baseTip: string }, threads: FeedbackThread[] = [], over: Partial<PrFeedback> = {}): PrFeedback {
  return {
    repo: "org/repo",
    pr: {
      number: 7, title: "Rename things", url: null, state: "OPEN", isDraft: false, author: "bob",
      headRef: "pr", baseRef: "main", headSha: f.head, baseSha: f.baseTip,
    },
    threads,
    conversation: [],
    omittedReviews: 0,
    ...over,
  };
}

export function result(feedback: PrFeedback | null, over: Partial<FeedbackResult> = {}): FeedbackResult {
  return {
    storeId: "store", repo: "org/repo", number: 7, revision: feedback === null ? 0 : 1,
    fetchedAt: feedback === null ? null : Date.parse("2025-01-03T00:00:00Z"), attemptedAt: null,
    sourceUpdatedAt: null, failures: 0, error: null, pausedUntil: null, feedback, ...over,
  };
}

export const RIGHT_HUNK = "@@ -2,4 +2,4 @@\n l2\n l3\n l4\n-l5\n+changed5";
export const LEFT_HUNK = "@@ -6,3 +6,2 @@\n l6\n l7\n-l8";
export const RENAME_HUNK = "@@ -1,3 +1,3 @@\n o1\n o2\n o3";
