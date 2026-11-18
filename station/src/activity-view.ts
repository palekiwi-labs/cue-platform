import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ActivityFilters, type BranchActivity, type GitEvent, groupActivity, repoLabel } from "./activity.js";
import { BOLD, C, fit, RESET } from "./changes.js";
import { age } from "./prs.js";
import type { TabScreen } from "./tabs.js";

export interface ActivityOptions {
  /** Common git dir of the current repository. */
  repoDir: string;
  repoName: string;
  allRepos: boolean;
  onQuit: () => void;
  onCopy: (text: string) => void;
}

export interface FilterPreset {
  label: string;
  hideCheckouts: boolean;
  agentsOnly: boolean;
}

export const FILTER_PRESETS: readonly FilterPreset[] = [
  { label: "no checkouts", hideCheckouts: true, agentsOnly: false },
  { label: "all events", hideCheckouts: false, agentsOnly: false },
];

export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function eventSha(e: GitEvent): string | null {
  return e.commit?.sha ?? e.head ?? null;
}

function hookLabel(e: GitEvent): string {
  switch (e.hook) {
    case "post-commit":
      return "commit";
    case "post-checkout":
      return "checkout";
    case "post-merge":
      return "merge";
    case "post-rewrite":
      return e.args[0] === "amend" ? "amend" : (e.args[0] ?? "rewrite");
    default:
      return e.hook;
  }
}

function actorLabel(e: GitEvent): string {
  const a = e.actor;
  return [a?.pi_model, a?.cue_context].filter((p): p is string => p !== undefined && p !== "").join("  ");
}

export function eventRows(e: GitEvent, width: number): string[] {
  const sha = eventSha(e);
  const head = `${C.dim}${localTime(e.ts)}  ${C.text}${hookLabel(e).padEnd(8)} ${C.dim}${sha?.slice(0, 10) ?? ""}`;
  const out = [head];
  const subject = e.commit?.subject ?? e.reflog_action;
  if (subject !== undefined && subject !== "") out.push(`    ${C.text}${subject}`);
  const who = [actorLabel(e), e.worktree ?? ""].filter((p) => p !== "").join("  ");
  if (who !== "") out.push(`    ${C.dim}${who}`);
  for (const r of e.rewrites ?? []) out.push(`    ${C.faint}${r.old.slice(0, 10)} → ${r.new.slice(0, 10)}`);
  return out.map((l) => truncateToWidth(l, width, "…"));
}

export class ActivityView implements TabScreen {
  private readonly events: GitEvent[] = [];
  private readonly seen = new Set<string>();
  private groups: BranchActivity[] = [];
  private allRepos: boolean;
  private preset = 0;
  private cursor = 0;
  private listOffset = 0;
  private eventCursor = 0;
  private detailOffset = 0;
  private detailFocus = false;
  private note = "connecting to GIT_ACTIVITY…";
  private notice: { text: string; error: boolean } | null = null;
  private lastHeight = 20;

  constructor(private readonly opts: ActivityOptions) {
    this.allRepos = opts.allRepos;
  }

  invalidate(): void {}

  setNote(note: string): void {
    this.note = note;
  }

  filters(): ActivityFilters {
    const p = FILTER_PRESETS[this.preset]!;
    return { repo: this.allRepos ? null : this.opts.repoDir, hideCheckouts: p.hideCheckouts, agentsOnly: p.agentsOnly };
  }

  add(e: GitEvent): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.events.push(e);
    this.regroup();
  }

  rows(): readonly BranchActivity[] {
    return this.groups;
  }

  selected(): BranchActivity | undefined {
    return this.groups[this.cursor];
  }

  private regroup(): void {
    const key = this.selected()?.key;
    this.groups = groupActivity(this.events, this.filters());
    const i = this.groups.findIndex((g) => g.key === key);
    if (i >= 0) this.cursor = i;
    else {
      this.cursor = Math.min(this.cursor, Math.max(0, this.groups.length - 1));
      this.eventCursor = 0;
      this.detailOffset = 0;
    }
    this.eventCursor = Math.min(this.eventCursor, Math.max(0, (this.selected()?.events.length ?? 1) - 1));
  }

  private select(to: number): void {
    const next = Math.max(0, Math.min(to, this.groups.length - 1));
    if (next !== this.cursor) {
      this.eventCursor = 0;
      this.detailOffset = 0;
    }
    this.cursor = next;
  }

  private moveEvent(to: number): void {
    const n = this.selected()?.events.length ?? 0;
    this.eventCursor = Math.max(0, Math.min(to, n - 1));
  }

  private copy(): void {
    const e = this.selected()?.events[this.detailFocus ? this.eventCursor : 0];
    const sha = e === undefined ? null : eventSha(e);
    if (sha === null) {
      this.notice = { text: "copy failed: no commit selected", error: true };
      return;
    }
    try {
      this.opts.onCopy(sha);
      this.notice = { text: `copied ${sha.slice(0, 12)}`, error: false };
    } catch (e) {
      this.notice = { text: `copy failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
    }
  }

  handleEscape(): boolean {
    if (!this.detailFocus) return false;
    this.detailFocus = false;
    return true;
  }

  handleInput(data: string): void {
    this.notice = null;
    const half = Math.max(1, Math.floor(this.lastHeight / 2));
    const move = (to: (cur: number) => number): void => {
      if (this.detailFocus) this.moveEvent(to(this.eventCursor));
      else this.select(to(this.cursor));
    };
    switch (data) {
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      case "\t":
        this.detailFocus = !this.detailFocus && this.selected() !== undefined;
        return;
      case "j":
      case "\x1b[B":
        move((c) => c + 1);
        return;
      case "k":
      case "\x1b[A":
        move((c) => c - 1);
        return;
      case "g":
        move(() => 0);
        return;
      case "G":
        move(() => Number.MAX_SAFE_INTEGER);
        return;
      case "\x04":
      case "\x1b[6~":
        move((c) => c + half);
        return;
      case "\x15":
      case "\x1b[5~":
        move((c) => c - half);
        return;
      case "a":
        this.allRepos = !this.allRepos;
        this.regroup();
        return;
      case "f":
        this.preset = (this.preset + 1) % FILTER_PRESETS.length;
        this.regroup();
        this.notice = { text: `filter: ${FILTER_PRESETS[this.preset]!.label}`, error: false };
        return;
      case "y":
        this.copy();
        return;
      default:
        return;
    }
  }

  private sideRow(g: BranchActivity, on: boolean, w: number, now: number): string[] {
    const marker = on ? `${this.detailFocus ? C.dim : C.accent}▎` : " ";
    const base = on ? C.selBg : "";
    const counts = `${C.dim}${g.commits}c${g.rewrites > 0 ? ` ${g.rewrites}r` : ""}`;
    const right = `${counts} ${C.dim}${age(g.last.ts, now).padStart(3)} `;
    const top = this.allRepos ? `${C.dim}${g.repoLabel} ${C.text}${g.branch}` : `${C.text}${g.branch}`;
    const leftW = Math.max(0, w - visibleWidth(right) - 1);
    const line = `${base}${fit(`${marker}${base}${top}`, leftW)}${base} ${right}`;
    return [fit(line, w) + RESET];
  }

  private renderSide(height: number, w: number, now: number): string[] {
    const out: string[] = [];
    const label = this.detailFocus ? C.text : C.accent;
    out.push(C.barBg + fit(` ${label}${BOLD}Branches${RESET}${C.barBg} ${C.dim}${this.groups.length}`, w) + RESET);
    const listH = height - 1;
    if (this.cursor < this.listOffset) this.listOffset = this.cursor;
    if (this.cursor >= this.listOffset + listH) this.listOffset = this.cursor - listH + 1;
    for (let i = this.listOffset; i < this.groups.length && out.length < height; i++) {
      out.push(...this.sideRow(this.groups[i]!, i === this.cursor, w, now));
    }
    if (this.groups.length === 0) out.push(fit(`  ${C.dim}no activity in the last day`, w) + RESET);
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  private renderDetail(height: number, w: number): string[] {
    const g = this.selected();
    if (g === undefined) return [];
    const rows: string[] = [`${C.text}${BOLD}${g.branch}${RESET}  ${C.dim}${repoLabel(g.last.repo)}`, ""];
    let curStart = 0;
    let curEnd = 0;
    g.events.forEach((e, i) => {
      if (i > 0) rows.push("");
      if (i === this.eventCursor) curStart = rows.length;
      rows.push(...eventRows(e, w - 2));
      if (i === this.eventCursor) curEnd = rows.length;
    });
    if (this.detailFocus) {
      if (curStart < this.detailOffset) this.detailOffset = curStart;
      else if (curEnd > this.detailOffset + height) this.detailOffset = Math.min(curStart, curEnd - height);
    }
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, rows.length - height));
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      const n = this.detailOffset + i;
      const on = this.detailFocus && n >= curStart && n < curEnd;
      out.push(`${on ? `${C.accent}▎` : " "} ${rows[n] ?? ""}`);
    }
    return out;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const now = Date.now();
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}Git activity`, width) + RESET);
    const scope = this.allRepos ? "all repos" : this.opts.repoName;
    const meta = ` ${C.dim}${scope}   ${C.text}${FILTER_PRESETS[this.preset]!.label}` + (this.note !== "" ? `  ${C.dim}${this.note}` : "");
    out.push(C.barBg + fit(meta, width) + RESET);

    const sideW = Math.min(64, Math.max(32, Math.floor(width * 0.4)));
    const mainW = width - sideW - 1;
    const side = this.renderSide(bodyH, sideW, now);
    const main = this.renderDetail(bodyH, mainW);
    for (let i = 0; i < bodyH; i++) {
      out.push(`${side[i] ?? ""}${RESET}${C.faint}│${RESET}${fit(main[i] ?? "", mainW)}${RESET}`);
    }

    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const keys = this.notice !== null
      ? ` ${this.notice.error ? C.del : C.add}${this.notice.text}`
      : ` ${k("j/k", this.detailFocus ? "event" : "branch")}${k("tab", this.detailFocus ? "branches" : "timeline")}${k("a", this.allRepos ? "this repo" : "all repos")}${k("f", "filter")}${k("y", "copy sha")}${k("q", "quit")}`;
    const g = this.selected();
    const pos = this.groups.length === 0 ? "" : this.detailFocus && g !== undefined
      ? `${this.eventCursor + 1}/${g.events.length} `
      : `${this.cursor + 1}/${this.groups.length} `;
    const gap = Math.max(1, width - visibleWidth(keys) - pos.length);
    out.push(C.barBg + fit(`${keys}${C.barBg}${" ".repeat(gap)}${C.dim}${pos}`, width) + RESET);
    return out;
  }
}
