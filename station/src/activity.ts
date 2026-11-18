export interface GitCommit {
  sha: string;
  parents: string[];
  author?: string;
  email?: string;
  author_ts?: number;
  subject?: string;
}

export interface GitActor {
  pi_session?: string;
  pi_model?: string;
  cue_context?: string;
  cue_context_branch?: string;
  tmux_pane?: string;
}

/** One event from the GIT_ACTIVITY stream (payload version 1). */
export interface GitEvent {
  v: 1;
  id: string;
  hook: string;
  args: string[];
  ts: string;
  host?: string;
  repo: { origin?: string; common_dir: string };
  worktree?: string;
  branch?: string;
  head?: string;
  commit?: GitCommit;
  rewrites?: { old: string; new: string }[];
  reflog_action?: string;
  actor?: GitActor;
}

export interface ActivityFilters {
  /** Common git dir of the repo to keep; null keeps all repos. */
  repo: string | null;
  hideCheckouts: boolean;
  hideTmp: boolean;
  agentsOnly: boolean;
}

export interface BranchActivity {
  key: string;
  repoDir: string;
  repoLabel: string;
  branch: string;
  last: GitEvent;
  commits: number;
  rewrites: number;
  /** Newest first. */
  events: GitEvent[];
}

export const DETACHED = "(detached)";

export function parseEvent(text: string): GitEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const e = value as Partial<GitEvent>;
  if (e.v !== 1 || typeof e.id !== "string" || typeof e.hook !== "string" || typeof e.ts !== "string") return null;
  if (typeof e.repo?.common_dir !== "string" || e.repo.common_dir === "") return null;
  return { ...e, args: Array.isArray(e.args) ? e.args : [] } as GitEvent;
}

export function repoLabel(repo: GitEvent["repo"]): string {
  const m = repo.origin?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  if (m) return m[1]!;
  const parts = repo.common_dir.replace(/\/+$/, "").split("/");
  if (parts.at(-1) === ".git") parts.pop();
  return parts.at(-1) || repo.common_dir;
}

export function isAgent(e: GitEvent): boolean {
  return e.actor?.pi_session !== undefined;
}

export function isTmp(e: GitEvent): boolean {
  return e.repo.common_dir.startsWith("/tmp/");
}

export function keep(e: GitEvent, f: ActivityFilters): boolean {
  if (f.repo !== null && e.repo.common_dir !== f.repo) return false;
  if (f.hideCheckouts && e.hook === "post-checkout") return false;
  if (f.hideTmp && isTmp(e)) return false;
  if (f.agentsOnly && !isAgent(e)) return false;
  return true;
}

/** Groups events by repo and branch, newest activity first. */
export function groupActivity(events: readonly GitEvent[], f: ActivityFilters): BranchActivity[] {
  const groups = new Map<string, BranchActivity>();
  for (const e of events) {
    if (!keep(e, f)) continue;
    const branch = e.branch ?? DETACHED;
    const key = `${e.repo.common_dir}\0${branch}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { key, repoDir: e.repo.common_dir, repoLabel: repoLabel(e.repo), branch, last: e, commits: 0, rewrites: 0, events: [] };
      groups.set(key, g);
    }
    g.events.push(e);
    if (e.hook === "post-commit") g.commits++;
    if (e.hook === "post-rewrite") g.rewrites++;
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.events.sort((a, b) => b.ts.localeCompare(a.ts));
    g.last = g.events[0]!;
  }
  return out.sort((a, b) => b.last.ts.localeCompare(a.last.ts));
}
