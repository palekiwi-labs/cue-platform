import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import { stackPrs } from "../../src/prs/stack.js";
import { openFindings, type PrReviewStatus, type RunState } from "./pr-status.js";
import { nearestSurvivor } from "./reload.js";
import type { PrSummary } from "./source.js";

export interface PrsOptions {
  repo: string;
  onQuit: () => void;
  onOpen: (pr: PrSummary) => void;
  onCheckout: (pr: PrSummary) => void;
  onLaunch: (pr: PrSummary) => void;
  onRefresh: () => void;
  onCopy: (text: string) => void;
  onPickSort: (current: PrSort, choose: (sort: PrSort) => void) => void;
}

export type PrSort = "updated" | "created" | "author";

export const PR_SORTS: readonly { sort: PrSort; key: string; label: string }[] = [
  { sort: "updated", key: "u", label: "recently updated" },
  { sort: "created", key: "c", label: "newest created" },
  { sort: "author", key: "a", label: "author" },
];

export function sortLabel(sort: PrSort): string {
  return PR_SORTS.find((s) => s.sort === sort)?.label ?? sort;
}

export function sortPickerText(current: PrSort): string {
  return PR_SORTS.map((s) => `${s.sort === current ? `${C.accent}●` : " "} ${C.text}${s.key}${C.dim}  ${s.label}`).join("\n");
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function text(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function comparePrs(sort: PrSort): (a: PrSummary, b: PrSummary) => number {
  const updated = (a: PrSummary, b: PrSummary): number => time(b.updatedAt) - time(a.updatedAt);
  const compare = (a: PrSummary, b: PrSummary): number => {
    switch (sort) {
      case "created":
        return time(b.createdAt) - time(a.createdAt);
      case "author":
        return text(a.author.toLowerCase(), b.author.toLowerCase()) || text(a.author, b.author) || updated(a, b);
      default:
        return updated(a, b);
    }
  };
  return (a, b) => compare(a, b) || b.number - a.number;
}

export function sortPrs(prs: readonly PrSummary[], sort: PrSort): PrSummary[] {
  return [...prs].sort(comparePrs(sort));
}

export type PrLayout = "flat" | "tree";

export interface PrRow {
  pr: PrSummary;
  depth: number;
  guide: string;
}

export function treeRows(prs: readonly PrSummary[], sort: PrSort): PrRow[] {
  const entries = stackPrs(prs, comparePrs(sort));
  const hasNext = entries.map((e, i) => {
    for (const later of entries.slice(i + 1)) {
      if (later.depth <= e.depth) return later.depth === e.depth;
    }
    return false;
  });
  const open: boolean[] = [];
  return entries.map((e, i) => {
    open.length = e.depth;
    const last = !hasNext[i];
    const guide = e.depth === 0 ? "" : open.slice(1).map((o) => (o ? "│ " : "  ")).join("") + (last ? "└ " : "├ ");
    open.push(!last);
    return { pr: e.pr, depth: e.depth, guide };
  });
}

export function layoutRows(prs: readonly PrSummary[], sort: PrSort, layout: PrLayout): PrRow[] {
  if (layout === "tree") return treeRows(prs, sort);
  return sortPrs(prs, sort).map((pr) => ({ pr, depth: 0, guide: "" }));
}

export function age(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

export const DECISION_WIDTH = 8;

export function decision(d: string): string {
  switch (d) {
    case "APPROVED":
      return `${C.add}approved`;
    case "CHANGES_REQUESTED":
      return `${C.del}changes`;
    case "REVIEW_REQUIRED":
      return `${C.dim}review`;
    default:
      return "";
  }
}

function stateColor(state: RunState): string {
  switch (state) {
    case "completed":
      return C.add;
    case "incomplete":
      return C.mod;
    case "unknown":
      return C.dim;
    default:
      return C.del;
  }
}

export const STATUS_WIDTH = 7;

export function statusSlot(status: PrReviewStatus | undefined): string {
  if (status === undefined) return " ".repeat(STATUS_WIDTH);
  const run = status.inProgress
    ? `${C.accent}◐`
    : status.latest === null ? " " : `${stateColor(status.latest)}●`;
  const open = openFindings(status);
  const count = open > 0 ? `${C.mod}${open > 99 ? "99+" : String(open)}` : "";
  const walk = status.walkthroughs.length > 0 ? `${C.ren}w` : " ";
  return `${run} ${count}${" ".repeat(3 - visibleWidth(count))} ${walk}`;
}

function runAge(runId: string, now: number): string {
  const s = Number(runId);
  return Number.isFinite(s) && s > 0 ? `${age(new Date(s * 1000).toISOString(), now)} ago` : "";
}

export function previewLines(pr: PrSummary | undefined, status: PrReviewStatus | undefined, now: number): string[] {
  if (pr === undefined) return [];
  const out = [`${C.text}${BOLD}#${pr.number}${RESET} ${C.text}${pr.title}`];
  if (status === undefined) {
    out.push(`${C.dim}no reviews or walkthroughs`);
    return out;
  }
  out.push(`${C.dim}runs`);
  if (status.inProgress && !status.runs.some((r) => r.state === "in progress")) out.push(`  ${C.accent}◐ ${C.text}starting`);
  if (status.runs.length === 0 && !status.inProgress) out.push(`  ${C.dim}none`);
  for (const r of status.runs) {
    const glyph = r.state === "in progress" ? `${C.accent}◐` : `${stateColor(r.state)}●`;
    const counts = status.findings.find((f) => f.runId === r.runId);
    const findings = counts === undefined
      ? r.verified ? "" : `  ${C.dim}not verified`
      : `  ${counts.open > 0 ? C.mod : C.dim}${counts.open}/${counts.total} findings open`;
    out.push(`  ${glyph} ${C.text}${r.runId}  ${C.dim}${r.state}  ${runAge(r.runId, now)}${findings}`);
  }
  out.push(`${C.dim}walkthroughs`);
  if (status.walkthroughs.length === 0) out.push(`  ${C.dim}none`);
  for (const w of status.walkthroughs) out.push(`  ${C.ren}w ${C.text}${w}`);
  return out;
}

export class PrsView implements Component {
  private readonly opts: PrsOptions;
  private prs: PrSummary[] = [];
  private rows: PrRow[] = [];
  private layout: PrLayout = "flat";
  private me = "";
  private loaded = false;
  private note = "";
  private sort: PrSort = "updated";
  private cursor = 0;
  private offset = 0;
  private lastHeight = 20;
  private notice: { text: string; error: boolean; until?: number } | null = null;
  private statuses = new Map<number, PrReviewStatus>();
  private previewOffset = 0;
  private previewFor: number | undefined;

  constructor(opts: PrsOptions) {
    this.opts = opts;
  }

  invalidate(): void {}

  setNote(note: string): void {
    this.note = note;
  }

  flash(text: string, ms = 4000): void {
    this.notice = { text, error: false, until: Date.now() + ms };
  }

  /**
   * Replaces the list keeping the selected PR and the scroll position. When
   * the selected PR is gone its nearest surviving neighbour is selected and
   * the gone PR is returned.
   */
  setPrs(prs: PrSummary[], me: string): PrSummary | undefined {
    this.me = me;
    this.loaded = true;
    return this.reorder(prs);
  }

  setStatuses(statuses: Map<number, PrReviewStatus>): void {
    this.statuses = statuses;
  }

  numbers(): number[] {
    return this.prs.map((p) => p.number);
  }

  sortBy(): PrSort {
    return this.sort;
  }

  setSort(sort: PrSort): void {
    this.sort = sort;
    this.reorder(this.prs);
  }

  layoutMode(): PrLayout {
    return this.layout;
  }

  setLayout(layout: PrLayout): void {
    this.layout = layout;
    this.reorder(this.prs);
  }

  private reorder(prs: PrSummary[]): PrSummary | undefined {
    const selected = this.selected();
    const previous = this.rows;
    this.prs = prs;
    this.rows = layoutRows(prs, this.sort, this.layout);
    const at = (row: PrRow): number => this.rows.findIndex((r) => r.pr.number === row.pr.number);
    const index = selected === undefined ? -1 : this.rows.findIndex((row) => row.pr.number === selected.number);
    if (index >= 0) {
      this.cursor = index;
      return undefined;
    }
    const neighbour = nearestSurvivor(previous, this.cursor, at);
    this.cursor = neighbour >= 0 ? neighbour : Math.min(this.cursor, Math.max(0, this.rows.length - 1));
    return selected;
  }

  selected(): PrSummary | undefined {
    return this.rows[this.cursor]?.pr;
  }

  private move(to: number): void {
    this.cursor = Math.max(0, Math.min(to, this.rows.length - 1));
  }

  private step(delta: 1 | -1): void {
    const n = this.rows.length;
    if (n === 0) return;
    this.cursor = (this.cursor + delta + n) % n;
  }

  private copy(what: "url" | "markdown"): void {
    const pr = this.selected();
    if (pr === undefined) {
      this.notice = { text: "copy failed: no pull request selected", error: true };
      return;
    }
    if (pr.url === "") {
      this.notice = { text: `copy failed: #${pr.number} has no URL`, error: true };
      return;
    }
    const text = what === "url" ? pr.url : `[${pr.title}](${pr.url})`;
    try {
      this.opts.onCopy(text);
      this.notice = { text: `copied ${text}`, error: false };
    } catch (e) {
      this.notice = { text: `copy failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
    }
  }

  handleInput(data: string): void {
    this.notice = null;
    if (matchesKey(data, "shift+down")) {
      this.previewOffset++;
      return;
    }
    if (matchesKey(data, "shift+up")) {
      this.previewOffset = Math.max(0, this.previewOffset - 1);
      return;
    }
    switch (data) {
      case "y":
        this.copy("url");
        return;
      case "h":
        this.copy("markdown");
        return;
      case "c": {
        const pr = this.selected();
        if (pr !== undefined) this.opts.onCheckout(pr);
        return;
      }
      case "L": {
        const pr = this.selected();
        if (pr !== undefined) this.opts.onLaunch(pr);
        return;
      }
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      case "j":
      case "\x1b[B":
        this.step(1);
        return;
      case "k":
      case "\x1b[A":
        this.step(-1);
        return;
      case "g":
        this.move(0);
        return;
      case "G":
        this.move(this.rows.length - 1);
        return;
      case "t":
        this.setLayout(this.layout === "flat" ? "tree" : "flat");
        return;
      case "\x04":
      case "\x1b[6~":
        this.move(this.cursor + Math.floor(this.lastHeight / 2));
        return;
      case "\x15":
      case "\x1b[5~":
        this.move(this.cursor - Math.floor(this.lastHeight / 2));
        return;
      case "R":
      case "r":
        this.opts.onRefresh();
        return;
      case "s":
        this.opts.onPickSort(this.sort, (sort) => this.setSort(sort));
        return;
      case "\r":
      case "o": {
        const pr = this.selected();
        if (pr !== undefined) this.opts.onOpen(pr);
        return;
      }
      default:
        return;
    }
  }

  private renderPr(row: PrRow, selected: boolean, width: number, now: number): string {
    const pr = row.pr;
    const mine = this.me !== "" && pr.requested.includes(this.me);
    const marker = selected ? `${C.accent}▌` : " ";
    const base = selected ? C.selBg : "";
    const num = `${C.dim}#${String(pr.number).padEnd(6)}`;
    const req = mine ? `${C.mod}● ` : "  ";
    const dec = decision(pr.reviewDecision);
    const right = `${statusSlot(this.statuses.get(pr.number))}  ${dec}${" ".repeat(DECISION_WIDTH - visibleWidth(dec))}  ${C.dim}${pr.author.padEnd(14).slice(0, 14)} ${age(pr.updatedAt, now).padStart(4)} `;
    const rightW = visibleWidth(right);
    const left = `${marker}${base}${req}${num}${C.dim}${row.guide}${pr.isDraft ? C.dim : C.text}${pr.title}`;
    const leftCell = fit(left, Math.max(0, width - rightW - 1));
    return `${base}${leftCell}${base} ${right}${RESET}`;
  }

  private renderPreview(width: number, height: number, now: number): string[] {
    const pr = this.selected();
    if (pr?.number !== this.previewFor) {
      this.previewFor = pr?.number;
      this.previewOffset = 0;
    }
    const lines = previewLines(pr, pr === undefined ? undefined : this.statuses.get(pr.number), now);
    const room = height - 1;
    this.previewOffset = Math.min(this.previewOffset, Math.max(0, lines.length - room));
    const shown = lines.slice(this.previewOffset, this.previewOffset + room).map((l) => fit(` ${l}`, width) + RESET);
    while (shown.length < room) shown.push("");
    const more = lines.length > room
      ? `  ${this.previewOffset + 1}-${Math.min(lines.length, this.previewOffset + room)}/${lines.length}`
      : "";
    return [C.fileBg + fit(` ${C.dim}review status${more}`, width) + RESET, ...shown];
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const previewH = total >= 20 ? Math.min(10, Math.floor(total / 3)) : 0;
    const bodyH = total - 3 - previewH;
    this.lastHeight = bodyH;
    const now = Date.now();
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}Pull requests`, width) + RESET);
    const reqCount = this.prs.filter((p) => this.me !== "" && p.requested.includes(this.me)).length;
    const meta = ` ${C.dim}${this.opts.repo}   ${C.text}${this.prs.length} open` +
      (this.me !== "" ? `  ${C.mod}● ${reqCount} requesting ${this.me}` : "") +
      (this.note !== "" ? `  ${C.dim}${this.note}` : "");
    out.push(C.barBg + fit(meta, width) + RESET);

    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + bodyH) this.offset = this.cursor - bodyH + 1;
    const body: string[] = [];
    for (let i = this.offset; i < this.rows.length && body.length < bodyH; i++) {
      body.push(this.renderPr(this.rows[i] as PrRow, i === this.cursor, width, now));
    }
    if (this.loaded && this.prs.length === 0) body.push(fit(`  ${C.dim}no open pull requests${RESET}`, width));
    while (body.length < bodyH) body.push("");
    out.push(...body);
    if (previewH > 0) out.push(...this.renderPreview(width, previewH, now));

    const keys = ` ${C.text}j/k${C.dim} move  ${C.text}enter${C.dim} review  ${C.text}y${C.dim} copy url  ${C.text}h${C.dim} copy md  ${C.text}c${C.dim} checkout  ${C.text}L${C.dim} launch  ${C.text}shift-↑/↓${C.dim} scroll status  ${C.text}s${C.dim} sort  ${C.text}t${C.dim} tree  ${C.text}R${C.dim} refresh  ${C.text}q${C.dim} quit`;
    const pos = `${this.layout === "tree" ? "tree  " : ""}sort: ${sortLabel(this.sort)}  ` +
      (this.rows.length > 0 ? `${this.cursor + 1}/${this.rows.length} ` : "");
    const room = Math.max(1, width - pos.length - 2);
    if (this.notice?.until !== undefined && this.notice.until <= now) this.notice = null;
    const left = this.notice === null
      ? keys
      : truncateToWidth(` ${this.notice.error ? C.del : C.add}${this.notice.text}`, room, "…");
    const gap = Math.max(1, width - visibleWidth(left) - pos.length);
    out.push(C.barBg + fit(`${left}${C.barBg}${" ".repeat(gap)}${C.dim}${pos}`, width) + RESET);
    return out;
  }
}
