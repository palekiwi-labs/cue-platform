import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sourceBlocks } from "./blocks.js";
import { BOLD, C, fit, RESET } from "./changes.js";
import type { ComposeRequest } from "./changes.js";
import { markdownRows } from "./markdown.js";
import { locate, type ReaderComments, type ReaderDoc } from "./reader-comments.js";
import type { ReaderComment } from "./state.js";

const PROSE_WIDTH = 80;
const PAD = 2;
const FAINT = "\x1b[2m";
const NORMAL = "\x1b[22m";

function faint(line: string): string {
  return FAINT + line.replace(/\x1b\[[0-9;]*m/g, (sgr) => sgr + FAINT) + NORMAL;
}

interface Block {
  section: string;
  index: number;
  quote: string;
  start: number;
  end: number;
}

export interface ReaderOptions {
  doc: ReaderDoc;
  comments: ReaderComments | null;
  onClose: () => void;
  onCompose: (request: ComposeRequest, done: (text: string | null) => void) => void;
  onCopy: (text: string) => void;
}

/**
 * Full-screen reader over one finding or walkthrough step. Its Markdown is
 * split into blocks; one block is focused at a time and the others are
 * dimmed. Each block may carry draft comments, shown under it.
 */
export class ReaderView implements Component {
  private focus = 0;
  private offset = 0;
  private lastHeight = 20;
  private blocks: Block[] = [];
  private flash: string | null = null;

  constructor(private readonly opts: ReaderOptions) {}

  invalidate(): void {}

  get focused(): number {
    return this.focus;
  }

  private comments(): ReaderComment[] {
    return this.opts.comments?.forTarget(this.opts.doc.target) ?? [];
  }

  private placed(): { at: Map<string, ReaderComment[]>; outdated: ReaderComment[] } {
    const at = new Map<string, ReaderComment[]>();
    const outdated: ReaderComment[] = [];
    for (const c of this.comments()) {
      const i = locate(this.opts.doc, c);
      if (i === null) outdated.push(c);
      else {
        const k = `${c.section}\n${i}`;
        at.set(k, [...(at.get(k) ?? []), c]);
      }
    }
    return { at, outdated };
  }

  private body(w: number): string[] {
    const pw = Math.min(w, PROSE_WIDTH);
    const { at, outdated } = this.placed();
    const out: string[] = [];
    const doc = this.opts.doc;
    out.push(...wrapTextWithAnsi(`${C.text}${BOLD}${doc.title}`, pw));
    for (const m of doc.meta) out.push(`${C.dim}${m}`);
    const blocks: Block[] = [];
    for (const s of doc.sections) {
      out.push("", `${C.accent}${BOLD}${s.heading}${RESET}`, "");
      sourceBlocks(s.markdown).forEach((b, index) => {
        if (index > 0) out.push("");
        const n = blocks.length;
        const on = n === this.focus;
        const start = out.length;
        const pad = " ".repeat(Math.min(b.indent, Math.max(0, pw - 1)));
        for (const row of markdownRows(b.text, pw - pad.length)) out.push(on ? pad + row : faint(pad + row));
        for (const c of at.get(`${s.heading}\n${index}`) ?? []) out.push(...this.callout(c, pw, on));
        blocks.push({ section: s.heading, index, quote: b.text, start, end: out.length });
      });
    }
    if (outdated.length > 0) {
      out.push("", `${C.del}${BOLD}Outdated comments${RESET}`, "");
      for (const c of outdated) {
        for (const l of c.quote.split("\n").slice(0, 3)) out.push(faint(`${C.dim}> ${l}`));
        out.push(...this.callout(c, pw, false), "");
      }
    }
    this.blocks = blocks;
    this.focus = Math.max(0, Math.min(this.focus, blocks.length - 1));
    return out;
  }

  private callout(c: ReaderComment, w: number, on: boolean): string[] {
    const bar = `${on ? C.accent : C.mod}┃ `;
    const rows = [`${bar}${C.mod}${BOLD}comment${RESET}`];
    for (const l of c.text.split("\n")) {
      for (const r of wrapTextWithAnsi(l, Math.max(1, w - 2))) rows.push(`${bar}${C.text}${r}`);
    }
    return rows.map((r) => C.noteBg + fit(r, w) + RESET);
  }

  private current(): Block | undefined {
    return this.blocks[this.focus];
  }

  private move(delta: number): void {
    if (this.blocks.length === 0) return;
    this.focus = Math.max(0, Math.min(this.blocks.length - 1, this.focus + delta));
    this.reveal();
  }

  private reveal(): void {
    const b = this.current();
    if (b === undefined) return;
    const h = this.lastHeight;
    if (b.start < this.offset) this.offset = Math.max(0, b.start - 1);
    else if (b.end > this.offset + h) this.offset = Math.max(0, Math.min(b.start - 1, b.end - h));
  }

  private commented(): number[] {
    const { at } = this.placed();
    return this.blocks.flatMap((b, i) => (at.has(`${b.section}\n${b.index}`) ? [i] : []));
  }

  private jumpComment(dir: 1 | -1): void {
    const marked = this.commented();
    if (marked.length === 0) {
      this.flash = "no comments on this item";
      return;
    }
    const ahead = dir === 1 ? marked.filter((i) => i > this.focus) : marked.filter((i) => i < this.focus).reverse();
    this.focus = ahead[0] ?? (dir === 1 ? marked[0]! : marked[marked.length - 1]!);
    this.reveal();
    this.flash = `comment ${marked.indexOf(this.focus) + 1}/${marked.length}${ahead.length === 0 ? " · wrapped" : ""}`;
  }

  private blockComments(b: Block): ReaderComment[] {
    return this.comments().filter((c) => locate(this.opts.doc, c) === b.index && c.section === b.section);
  }

  private compose(): void {
    const store = this.opts.comments;
    const b = this.current();
    if (store === null || b === undefined) return;
    const existing = this.blockComments(b)[0];
    const title = `${this.opts.doc.target.item_title} · ${b.section} ¶${b.index + 1}`;
    this.opts.onCompose({ title, text: existing?.text ?? "" }, (text) => {
      if (text === null) return;
      if (existing !== undefined) store.update(existing.id, text);
      else store.add(this.opts.doc.target, b.section, b.index, b.quote, text);
    });
  }

  private remove(): void {
    const store = this.opts.comments;
    const b = this.current();
    if (store === null || b === undefined) return;
    const ids = this.blockComments(b).map((c) => c.id);
    if (ids.length > 0) store.remove(ids);
  }

  handleEscape(): boolean {
    this.opts.onClose();
    return true;
  }

  handleInput(data: string): void {
    this.flash = null;
    const h = this.lastHeight;
    if (matchesKey(data, "ctrl+down")) return this.jumpComment(1);
    if (matchesKey(data, "ctrl+up")) return this.jumpComment(-1);
    if (matchesKey(data, "shift+down")) {
      this.offset += 3;
      return;
    }
    if (matchesKey(data, "shift+up")) {
      this.offset -= 3;
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.offset += Math.floor(h / 2);
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.offset -= Math.floor(h / 2);
      return;
    }
    switch (data) {
      case "q":
        this.opts.onClose();
        return;
      case "j":
      case "\x1b[B":
        return this.move(1);
      case "k":
      case "\x1b[A":
        return this.move(-1);
      case "g":
        this.focus = 0;
        this.offset = 0;
        return;
      case "G":
        this.focus = Math.max(0, this.blocks.length - 1);
        this.offset = Number.MAX_SAFE_INTEGER;
        return;
      case "n":
        return this.jumpComment(1);
      case "N":
        return this.jumpComment(-1);
      case "c":
        return this.compose();
      case "d":
        return this.remove();
      case "y": {
        const b = this.current();
        if (b !== undefined) {
          this.opts.onCopy(b.quote);
          this.flash = "copied block";
        }
        return;
      }
    }
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const doc = this.opts.doc;
    const out: string[] = [];
    const kind = doc.target.kind === "finding" ? "finding" : "walkthrough step";
    out.push(C.titleBg + fit(` ${C.text}${BOLD}read ${kind}  ${C.dim}${doc.target.item_title}`, width) + RESET);
    out.push(C.barBg + fit(` ${C.dim}${doc.subtitle}`, width) + RESET);
    const rows = this.body(width - PAD);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - bodyH)));
    const b = this.current();
    for (let i = 0; i < bodyH; i++) {
      const n = this.offset + i;
      const marked = b !== undefined && n >= b.start && n < b.end;
      const lead = marked ? `${C.accent}▎ ${RESET}` : " ".repeat(PAD);
      out.push(fit(lead + truncateToWidth(rows[n] ?? "", width - PAD, ""), width) + RESET);
    }
    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const editable = this.opts.comments !== null;
    const keys =
      ` ${k("j/k", "block")}${editable ? k("c", "comment") : ""}` +
      `${editable && b !== undefined && this.blockComments(b).length > 0 ? k("d", "delete") : ""}` +
      `${k("n/N", "next/prev comment")}${k("y", "copy")}${k("q/esc", "close")}`;
    const count = this.comments().length;
    const status = this.flash ?? (count > 0 ? `${count} comment${count === 1 ? "" : "s"}` : "");
    const right = `${this.offset + bodyH < rows.length ? `${C.accent}more ↓  ` : ""}${C.dim}${status} `;
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(right));
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}
