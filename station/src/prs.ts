import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import type { PrSummary } from "./source.js";

export interface PrsOptions {
  repo: string;
  onQuit: () => void;
  onOpen: (pr: PrSummary) => void;
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

export function sortPrs(prs: readonly PrSummary[], sort: PrSort): PrSummary[] {
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
  return [...prs].sort((a, b) => compare(a, b) || b.number - a.number);
}

export function age(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

function decision(d: string): string {
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

export class PrsView implements Component {
  private readonly opts: PrsOptions;
  private prs: PrSummary[] = [];
  private me = "";
  private loaded = false;
  private note = "";
  private sort: PrSort = "updated";
  private cursor = 0;
  private offset = 0;
  private lastHeight = 20;
  private notice: { text: string; error: boolean } | null = null;

  constructor(opts: PrsOptions) {
    this.opts = opts;
  }

  invalidate(): void {}

  setNote(note: string): void {
    this.note = note;
  }

  setPrs(prs: PrSummary[], me: string): void {
    this.me = me;
    this.loaded = true;
    this.reorder(prs);
  }

  sortBy(): PrSort {
    return this.sort;
  }

  setSort(sort: PrSort): void {
    this.sort = sort;
    this.reorder(this.prs);
  }

  private reorder(prs: PrSummary[]): void {
    const selected = this.selected()?.number;
    this.prs = sortPrs(prs, this.sort);
    const index = this.prs.findIndex((pr) => pr.number === selected);
    this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.prs.length - 1));
  }

  selected(): PrSummary | undefined {
    return this.prs[this.cursor];
  }

  private move(to: number): void {
    this.cursor = Math.max(0, Math.min(to, this.prs.length - 1));
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
    switch (data) {
      case "y":
        this.copy("url");
        return;
      case "h":
        this.copy("markdown");
        return;
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      case "j":
      case "\x1b[B":
        this.move(this.cursor + 1);
        return;
      case "k":
      case "\x1b[A":
        this.move(this.cursor - 1);
        return;
      case "g":
        this.move(0);
        return;
      case "G":
        this.move(this.prs.length - 1);
        return;
      case "\x04":
      case "\x1b[6~":
        this.move(this.cursor + Math.floor(this.lastHeight / 2));
        return;
      case "\x15":
      case "\x1b[5~":
        this.move(this.cursor - Math.floor(this.lastHeight / 2));
        return;
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

  private renderPr(pr: PrSummary, selected: boolean, width: number, now: number): string {
    const mine = this.me !== "" && pr.requested.includes(this.me);
    const marker = selected ? `${C.accent}▌` : " ";
    const base = selected ? C.selBg : "";
    const num = `${C.dim}#${String(pr.number).padEnd(6)}`;
    const req = mine ? `${C.mod}● ` : "  ";
    const right = `${decision(pr.reviewDecision)}  ${C.dim}${pr.author.padEnd(14).slice(0, 14)} ${age(pr.updatedAt, now).padStart(4)} `;
    const rightW = visibleWidth(right);
    const left = `${marker}${base}${req}${num}${pr.isDraft ? C.dim : C.text}${pr.title}`;
    const leftCell = fit(left, Math.max(0, width - rightW - 1));
    return `${base}${leftCell}${base} ${right}${RESET}`;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
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
    for (let i = this.offset; i < this.prs.length && body.length < bodyH; i++) {
      body.push(this.renderPr(this.prs[i] as PrSummary, i === this.cursor, width, now));
    }
    if (this.loaded && this.prs.length === 0) body.push(fit(`  ${C.dim}no open pull requests${RESET}`, width));
    while (body.length < bodyH) body.push("");
    out.push(...body);

    const keys = ` ${C.text}j/k${C.dim} move  ${C.text}enter${C.dim} review  ${C.text}y${C.dim} copy url  ${C.text}h${C.dim} copy md  ${C.text}s${C.dim} sort  ${C.text}r${C.dim} refresh  ${C.text}q${C.dim} quit`;
    const pos = `sort: ${sortLabel(this.sort)}  ` + (this.prs.length > 0 ? `${this.cursor + 1}/${this.prs.length} ` : "");
    const room = Math.max(1, width - pos.length - 2);
    const left = this.notice === null
      ? keys
      : truncateToWidth(` ${this.notice.error ? C.del : C.add}${this.notice.text}`, room, "…");
    const gap = Math.max(1, width - visibleWidth(left) - pos.length);
    out.push(C.barBg + fit(`${left}${C.barBg}${" ".repeat(gap)}${C.dim}${pos}`, width) + RESET);
    return out;
  }
}
