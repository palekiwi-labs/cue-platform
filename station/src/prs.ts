import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import type { PrSummary } from "./source.js";

export interface PrsOptions {
  repo: string;
  onQuit: () => void;
  onOpen: (pr: PrSummary) => void;
  onRefresh: () => void;
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
  private status: string | null = "loading pull requests…";
  private error = false;
  private cursor = 0;
  private offset = 0;
  private lastHeight = 20;

  constructor(opts: PrsOptions) {
    this.opts = opts;
  }

  invalidate(): void {}

  setPrs(prs: PrSummary[], me: string): void {
    this.prs = prs;
    this.me = me;
    this.status = null;
    this.error = false;
    this.cursor = Math.min(this.cursor, Math.max(0, prs.length - 1));
  }

  setStatus(text: string | null, error = false): void {
    this.status = text;
    this.error = error;
  }

  selected(): PrSummary | undefined {
    return this.prs[this.cursor];
  }

  private move(to: number): void {
    this.cursor = Math.max(0, Math.min(to, this.prs.length - 1));
  }

  handleInput(data: string): void {
    switch (data) {
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
    const draft = pr.isDraft ? `${C.faint}draft ` : "";
    const req = mine ? `${C.mod}● ` : "  ";
    const right = `${decision(pr.reviewDecision)}  ${C.dim}${pr.author.padEnd(14).slice(0, 14)} ${age(pr.updatedAt, now).padStart(4)} `;
    const rightW = visibleWidth(right);
    const left = `${marker}${base}${req}${num}${draft}${pr.isDraft ? C.dim : C.text}${pr.title}`;
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
      (this.me !== "" ? `  ${C.mod}● ${reqCount} requesting ${this.me}` : "");
    out.push(C.barBg + fit(meta, width) + RESET);

    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + bodyH) this.offset = this.cursor - bodyH + 1;
    const body: string[] = [];
    if (this.status !== null) {
      body.push("");
      body.push(fit(`  ${this.error ? C.del : C.dim}${this.status}${RESET}`, width));
    }
    const listH = bodyH - body.length;
    for (let i = this.offset; i < this.prs.length && body.length < bodyH && i < this.offset + listH; i++) {
      body.push(this.renderPr(this.prs[i] as PrSummary, i === this.cursor, width, now));
    }
    if (this.status === null && this.prs.length === 0) body.push(fit(`  ${C.dim}no open pull requests${RESET}`, width));
    while (body.length < bodyH) body.push("");
    out.push(...body);

    const keys = ` ${C.text}j/k${C.dim} move  ${C.text}enter${C.dim} review  ${C.text}r${C.dim} refresh  ${C.text}q${C.dim} quit`;
    const pos = this.prs.length > 0 ? `${this.cursor + 1}/${this.prs.length} ` : "";
    const gap = Math.max(1, width - visibleWidth(keys) - pos.length);
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${C.dim}${pos}`, width) + RESET);
    return out;
  }
}
