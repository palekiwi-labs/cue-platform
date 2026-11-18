import { catFiles, run } from "./git.js";
import type { FeedbackSnapshot, ReviewThread } from "./github-feedback.js";

export interface HunkLine {
  kind: " " | "-" | "+";
  text: string;
  old: number | null;
  new: number | null;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a GitHub diff hunk; null when it has no hunk header. */
export function parseHunk(hunk: string): HunkLine[] | null {
  const out: HunkLine[] = [];
  let oldN = 0;
  let newN = 0;
  let seen = false;
  for (const raw of hunk.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
    const h = raw.match(HEADER);
    if (h !== null) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      seen = true;
      continue;
    }
    if (!seen || raw.startsWith("\\")) continue;
    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === "+") out.push({ kind, text, old: null, new: newN++ });
    else if (kind === "-") out.push({ kind, text, old: oldN++, new: null });
    else if (kind === " " || raw === "") out.push({ kind: " ", text, old: oldN++, new: newN++ });
  }
  return seen ? out : null;
}

/** The commented line: GitHub hunks end on it. Null when the last line is not on the given side. */
export function hunkAnchor(hunk: string | null, side: "LEFT" | "RIGHT"): HunkLine | null {
  if (hunk === null) return null;
  const last = parseHunk(hunk)?.at(-1);
  if (last === undefined) return null;
  if (side === "LEFT" ? last.kind === "+" : last.kind === "-") return null;
  return last;
}

export interface GitAccess {
  hasCommit(sha: string): boolean;
  mergeBase(a: string, b: string): string | null;
  fileAt(rev: string, path: string): string | null;
  renamedFrom(from: string, to: string, path: string): string | null;
}

export type Located =
  | { ok: true; rev: string; path: string; line: number; side: "LEFT" | "RIGHT"; base: string | null; note: string }
  | { ok: false; reason: string };

function short(sha: string): string {
  return sha.slice(0, 10);
}

function side(thread: ReviewThread): "LEFT" | "RIGHT" | null {
  if (thread.diff_side === "LEFT" || thread.diff_side === "RIGHT") return thread.diff_side;
  return thread.subject_type === "FILE" ? "RIGHT" : null;
}

function isCurrent(thread: ReviewThread): boolean {
  return !thread.is_outdated && (thread.line !== null || thread.subject_type === "FILE");
}

/** The commit a thread's coordinates refer to: the PR head for current threads, else the commit it was made on. */
export function threadCommit(thread: ReviewThread, snapshot: FeedbackSnapshot): string | null {
  return isCurrent(thread) ? snapshot.pr.head_sha : (thread.comments[0]?.original_commit ?? null);
}

/** Commits the location of a thread depends on, for fetching before resolving. */
export function requiredCommits(thread: ReviewThread, snapshot: FeedbackSnapshot): string[] {
  const commit = threadCommit(thread, snapshot);
  if (commit === null) return [];
  return side(thread) === "LEFT" ? [commit, snapshot.pr.base_sha] : [commit];
}

/**
 * Resolves where a review thread points to in local git: the revision, path
 * and line on the side it was written on. Lines GitHub reports are checked
 * against the captured diff hunk; any mismatch is reported, never guessed.
 */
export function resolveThread(thread: ReviewThread, snapshot: FeedbackSnapshot, git: GitAccess): Located {
  const fail = (reason: string): Located => ({ ok: false, reason });
  const first = thread.comments[0];
  if (first === undefined) return fail("the thread has no comments");
  const s = side(thread);
  if (s === null) return fail(`GitHub reported no diff side for ${thread.path}`);
  const fileLevel = thread.subject_type === "FILE";
  const current = isCurrent(thread);
  const commit = threadCommit(thread, snapshot);
  if (commit === null) return fail("GitHub reported no original commit for this outdated thread");
  const line = fileLevel ? 1 : current ? thread.line : thread.original_line;
  if (line === null) return fail("GitHub reported no line for this thread");
  if (!git.hasCommit(commit)) return fail(`commit ${short(commit)} is not in the local repository and could not be fetched`);

  let rev = commit;
  let path = thread.path;
  let base: string | null = null;
  if (s === "LEFT") {
    if (!git.hasCommit(snapshot.pr.base_sha)) {
      return fail(`base ${short(snapshot.pr.base_sha)} is not in the local repository and could not be fetched`);
    }
    const mb = git.mergeBase(commit, snapshot.pr.base_sha);
    if (mb === null) return fail(`no merge-base between ${short(commit)} and base ${short(snapshot.pr.base_sha)}`);
    rev = mb;
    if (git.fileAt(rev, path) === null) {
      const old = git.renamedFrom(rev, commit, path);
      if (old === null) return fail(`${path} does not exist on the base side (${short(rev)})`);
      path = old;
    }
  } else {
    base = git.mergeBase(commit, snapshot.pr.base_sha);
  }

  const src = git.fileAt(rev, path);
  if (src === null) return fail(`${path} does not exist at ${short(rev)}`);
  const lines = src.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (line > Math.max(1, lines.length)) return fail(`${path} has ${lines.length} lines at ${short(rev)}, the thread points at ${line}`);

  const where = s === "LEFT" ? `base side at merge-base ${short(rev)}` : current ? `PR head ${short(rev)}` : `commit ${short(rev)}`;
  if (fileLevel) return { ok: true, rev, path, line, side: s, base, note: `file comment, ${where}` };

  const anchor = hunkAnchor(first.diff_hunk, s);
  if (anchor === null) {
    if (s === "LEFT") return fail("the captured diff hunk does not end on a base-side line, so the old-side location cannot be verified");
    return { ok: true, rev, path, line, side: s, base, note: `${where} (no captured diff to verify against)` };
  }
  if (!current) {
    const expected = s === "LEFT" ? anchor.old : anchor.new;
    if (expected !== line) {
      return fail(`the captured diff hunk ends at line ${expected ?? "?"}, GitHub reports line ${line}`);
    }
  }
  if ((lines[line - 1] ?? "").replace(/\r$/, "") !== anchor.text.replace(/\r$/, "")) {
    return fail(`line ${line} of ${path} at ${short(rev)} does not match the commented line in the captured diff`);
  }
  return { ok: true, rev, path, line, side: s, base, note: where + (current ? "" : ", outdated thread at its original commit") };
}

export function localGit(repo: string): GitAccess {
  const tryRun = (args: string[]): string | null => {
    try {
      return run(repo, args);
    } catch {
      return null;
    }
  };
  return {
    hasCommit: (sha) => tryRun(["cat-file", "-e", `${sha}^{commit}`]) !== null,
    mergeBase: (a, b) => tryRun(["merge-base", a, b])?.trim() || null,
    fileAt: (rev, path) => catFiles(repo, [`${rev}:${path}`])[0] ?? null,
    renamedFrom: (from, to, path) => {
      const out = tryRun(["diff", "--name-status", "-M", "-z", from, to]);
      if (out === null) return null;
      const parts = out.split("\0");
      for (let i = 0; i < parts.length; ) {
        const status = parts[i] ?? "";
        if (/^[RC]/.test(status)) {
          if (parts[i + 2] === path) return parts[i + 1] ?? null;
          i += 3;
        } else i += 2;
      }
      return null;
    },
  };
}
