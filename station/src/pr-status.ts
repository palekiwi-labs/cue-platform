import { spawnSync } from "node:child_process";
import { storeRoot, isDismissed, loadRun } from "./findings.js";
import { listRuns } from "./pr-review.js";
import { listWalkthroughs } from "./walkthrough.js";

export type RunState = "in progress" | "completed" | "incomplete" | "failed" | "aborted" | "interrupted" | "unknown";

export interface RunStatus {
  runId: string;
  state: RunState;
  verified: boolean;
}

export interface FindingsCount {
  runId: string;
  open: number;
  total: number;
}

export interface PrReviewStatus {
  runs: RunStatus[];
  inProgress: boolean;
  latest: RunState | null;
  findings: FindingsCount[];
  walkthroughs: string[];
}

export interface ReviewWindow {
  context: string;
  run: string;
  state: string;
  command: string;
}

export type Windows = { ok: true; windows: ReviewWindow[] } | { ok: false };

const SHELLS = new Set(["bash", "sh", "zsh", "fish"]);
const FIELDS = ["@review_context", "@review_run", "@review_state", "pane_current_command"];

export function parseWindows(stdout: string): ReviewWindow[] {
  return stdout.split("\n").filter((l) => l !== "").map((line) => {
    const [context = "", run = "", state = "", command = ""] = line.split("\t");
    return { context, run, state, command };
  });
}

export function tmuxWindows(): Windows {
  const res = spawnSync("tmux", ["list-windows", "-a", "-F", FIELDS.map((f) => `#{${f}}`).join("\t")], { encoding: "utf8" });
  if (res.status === 0) return { ok: true, windows: parseWindows(res.stdout) };
  const err = `${res.stderr ?? ""}${res.error?.message ?? ""}`;
  if (/no server running|no sessions|error connecting to/i.test(err)) return { ok: true, windows: [] };
  return { ok: false };
}

function live(w: ReviewWindow): boolean {
  return (w.state === "running" || w.state === "") && !SHELLS.has(w.command);
}

function contextName(address: string): string {
  return address.split("/").pop() ?? address;
}

export function runState(state: string): RunState {
  switch (state) {
    case "completed":
    case "incomplete":
    case "failed":
    case "aborted":
      return state;
    default:
      return "unknown";
  }
}

export interface StatusInput {
  context: string;
  runs: { runId: string; state: string; verified: boolean }[];
  windows: Windows;
  findings: (runId: string) => FindingsCount | null;
  walkthroughs: string[];
}

export function deriveStatus(input: StatusInput): PrReviewStatus {
  const name = contextName(input.context);
  const mine = input.windows.ok ? input.windows.windows.filter((w) => w.context === name || w.context === input.context) : [];
  const liveRuns = new Set(mine.filter(live).map((w) => w.run));
  const runs: RunStatus[] = input.runs.map((r) => {
    let state: RunState;
    if (liveRuns.has(r.runId)) state = "in progress";
    else if (r.state === "running") state = input.windows.ok ? "interrupted" : "unknown";
    else state = runState(r.state);
    return { runId: r.runId, state, verified: r.verified };
  });
  const known = new Set(input.runs.map((r) => r.runId));
  const starting = mine.some((w) => live(w) && (w.run === "" || !known.has(w.run)));
  const inProgress = starting || runs.some((r) => r.state === "in progress");
  const findings = runs.filter((r) => r.verified).flatMap((r) => {
    const c = input.findings(r.runId);
    return c === null ? [] : [c];
  });
  const finished = runs.find((r) => r.state !== "in progress");
  return { runs, inProgress, latest: finished?.state ?? null, findings, walkthroughs: input.walkthroughs };
}

export function countFindings(address: string, runId: string, store = storeRoot()): FindingsCount | null {
  try {
    const run = loadRun(address, store);
    const open = run.findings.filter((f) =>
      !isDismissed(f) && f.status?.toLowerCase() !== "applied" && f.verification?.verdict.toLowerCase() !== "refuted",
    ).length;
    return { runId, open, total: run.findings.length };
  } catch {
    return null;
  }
}

export function prReviewStatus(repoSlug: string, pr: number, windows: Windows, store = storeRoot()): PrReviewStatus | null {
  const runs = listRuns(repoSlug, pr, store);
  const walkthroughs = listWalkthroughs(repoSlug, pr, store).map((w) => w.id);
  const status = deriveStatus({
    context: `review-pr-${pr}`,
    runs,
    windows,
    findings: (runId) => {
      const run = runs.find((r) => r.runId === runId);
      return run === undefined ? null : countFindings(run.address, runId, store);
    },
    walkthroughs,
  });
  if (status.runs.length === 0 && !status.inProgress && walkthroughs.length === 0) return null;
  return status;
}

export function openFindings(status: PrReviewStatus): number {
  return status.findings[0]?.open ?? 0;
}

export const POLL_MS = 5000;

export interface StatusTarget {
  numbers: () => number[];
  setStatuses: (statuses: Map<number, PrReviewStatus>) => void;
}

/**
 * Recomputes review status for every listed PR on demand, and keeps polling
 * while any PR has a review in progress so finished runs show up unprompted.
 */
export class ReviewStatuses {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly target: StatusTarget,
    private readonly repoSlug: string,
    private readonly render: () => void,
    private readonly read: (pr: number, windows: Windows) => PrReviewStatus | null =
      (pr, windows) => prReviewStatus(repoSlug, pr, windows),
    private readonly windows: () => Windows = tmuxWindows,
    private readonly pollMs = POLL_MS,
  ) {}

  refresh(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const windows = this.windows();
    const statuses = new Map<number, PrReviewStatus>();
    for (const n of this.target.numbers()) {
      const s = this.read(n, windows);
      if (s !== null) statuses.set(n, s);
    }
    this.target.setStatuses(statuses);
    this.render();
    if ([...statuses.values()].some((s) => s.inProgress)) {
      this.timer = setTimeout(() => this.refresh(), this.pollMs);
      this.timer.unref?.();
    }
  }

  polling(): boolean {
    return this.timer !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
