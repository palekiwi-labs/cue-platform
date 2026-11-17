import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Component,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import { excerpt, storeRoot } from "./findings.js";
import { highlightFile, highlightLines } from "./highlight.js";
import { prContext } from "./pr-review.js";

export interface WalkthroughFile {
  path: string;
  lines: [number, number] | null;
}

export interface WalkthroughSection {
  title: string;
  markdown: string;
  file: WalkthroughFile | null;
}

export interface WalkthroughChunk {
  id: string;
  title: string;
  summary: string;
  sections: WalkthroughSection[];
}

/** A guided walkthrough stored at <org>/<repo>/review-pr-N/review/walkthrough/<id>.json. */
export interface Walkthrough {
  address: string;
  pr: number | null;
  base: string;
  head: string;
  title: string;
  summary: string;
  chunks: WalkthroughChunk[];
}

export interface WalkthroughEntry {
  address: string;
  id: string;
  title: string;
  head: string;
}

export function walkthroughPath(address: string, store = storeRoot()): string {
  const clean = address.replace(/\/+$/, "");
  if (!/^[^/]+\/[^/]+\/[^/]+\/review\/walkthrough\/[^/]+\.json$/.test(clean) || clean.split("/").includes("..")) {
    throw new Error(`not a walkthrough address (<org>/<repo>/<context>/review/walkthrough/<id>.json): ${address}`);
  }
  return join(store, clean);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function line(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
}

function parseFile(v: unknown): WalkthroughFile | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const path = str(o.path);
  if (path === "") return null;
  const range = Array.isArray(o.lines) ? o.lines.map(line) : [];
  const start = range[0] ?? null;
  const end = range[1] ?? start;
  return { path, lines: start === null || end === null ? null : [Math.min(start, end), Math.max(start, end)] };
}

export function parseWalkthrough(address: string, data: Record<string, unknown>): Walkthrough {
  if (data.version !== 1) throw new Error(`unsupported walkthrough version ${String(data.version)}: ${address}`);
  return {
    address,
    pr: line(data.pr),
    base: str(data.base),
    head: str(data.head),
    title: str(data.title),
    summary: str(data.summary),
    chunks: list(data.chunks).map((c, i) => ({
      id: str(c.id) || `chunk-${i + 1}`,
      title: str(c.title) || `Chunk ${i + 1}`,
      summary: str(c.summary),
      sections: list(c.sections).map((s, j) => ({
        title: str(s.title) || `Section ${j + 1}`,
        markdown: str(s.markdown),
        file: parseFile(s.file),
      })),
    })),
  };
}

export function loadWalkthrough(address: string, store = storeRoot()): Walkthrough {
  const path = walkthroughPath(address, store);
  if (!existsSync(path)) throw new Error(`no walkthrough at ${address}`);
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`walkthrough is not a JSON object: ${address}`);
  }
  return parseWalkthrough(address, data as Record<string, unknown>);
}

export function listWalkthroughs(repoSlug: string, pr: number, store = storeRoot()): WalkthroughEntry[] {
  const base = `${prContext(repoSlug, pr)}/review/walkthrough`;
  const dir = join(store, base);
  if (!existsSync(dir)) return [];
  const out: WalkthroughEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({ address: `${base}/${name}`, id: name.slice(0, -5), title: str(data.title), head: str(data.head) });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export type WalkRow =
  | { kind: "overview" }
  | { kind: "chunk"; chunk: number }
  | { kind: "section"; chunk: number; section: number };

export function walkRows(w: Walkthrough): WalkRow[] {
  const rows: WalkRow[] = [{ kind: "overview" }];
  w.chunks.forEach((c, i) => {
    rows.push({ kind: "chunk", chunk: i });
    c.sections.forEach((_, j) => rows.push({ kind: "section", chunk: i, section: j }));
  });
  return rows;
}

export function sectionFiles(w: Walkthrough): string[] {
  return w.chunks.flatMap((c) => c.sections.flatMap((s) => (s.file === null ? [] : [s.file.path])));
}

const PROSE_WIDTH = 80;

const paint = (color: string) => (t: string): string => `${color}${t}${C.text}`;

const theme: MarkdownTheme = {
  heading: (t) => `${C.accent}${BOLD}${t}${RESET}${C.text}`,
  link: paint(C.accent),
  linkUrl: paint(C.dim),
  code: paint(C.mod),
  codeBlock: paint(C.text),
  codeBlockBorder: paint(C.faint),
  quote: paint(C.dim),
  quoteBorder: paint(C.faint),
  hr: paint(C.faint),
  listBullet: paint(C.accent),
  bold: (t) => `${BOLD}${t}\x1b[22m`,
  italic: (t) => `\x1b[3m${t}\x1b[23m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  highlightCode: (code, lang) => {
    if (lang === undefined || lang === "") return code.split("\n").map((l) => `${C.text}${l}`);
    try {
      return highlightLines(code, lang);
    } catch {
      return code.split("\n").map((l) => `${C.text}${l}`);
    }
  },
};

function markdownRows(text: string, width: number): string[] {
  if (text.trim() === "") return [];
  return new Markdown(text, 0, 0, theme, { color: (t) => `${C.text}${t}` }).render(width);
}

function where(f: WalkthroughFile): string {
  return f.lines === null ? f.path : `${f.path}:${f.lines[0]}-${f.lines[1]}`;
}

export interface WalkthroughOptions {
  walkthrough: Walkthrough;
  sources: Map<string, string | null>;
  subtitle: string;
  onQuit: () => void;
  onOpen: (file: string, line: number) => void;
}

export class WalkthroughView implements Component {
  private readonly rows: WalkRow[];
  private cursor = 0;
  private sideCursor = 0;
  private sideFocus = false;
  private sidebar = true;
  private offset = 0;
  private listOffset = 0;
  private lastHeight = 20;
  private readonly highlighted = new Map<string, string[] | null>();

  constructor(private readonly opts: WalkthroughOptions) {
    this.rows = walkRows(opts.walkthrough);
  }

  invalidate(): void {}

  get position(): number {
    return this.cursor;
  }

  get focusedSidebar(): boolean {
    return this.sideFocus;
  }

  private go(index: number): void {
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, index));
    this.offset = 0;
  }

  private current(): { chunk: WalkthroughChunk | null; section: WalkthroughSection | null } {
    const row = this.rows[this.cursor];
    const w = this.opts.walkthrough;
    if (row === undefined || row.kind === "overview") return { chunk: null, section: null };
    const chunk = w.chunks[row.chunk] ?? null;
    return { chunk, section: row.kind === "section" ? (chunk?.sections[row.section] ?? null) : null };
  }

  handleEscape(): boolean {
    if (!this.sideFocus) return false;
    this.sideFocus = false;
    return true;
  }

  handleInput(data: string): void {
    if (data === "q" || data === "\x03") {
      this.opts.onQuit();
      return;
    }
    if (this.sideFocus) this.sideInput(data);
    else this.mainInput(data);
  }

  private sideInput(data: string): void {
    switch (data) {
      case "j":
      case "\x1b[B":
        this.sideCursor = Math.min(this.rows.length - 1, this.sideCursor + 1);
        return;
      case "k":
      case "\x1b[A":
        this.sideCursor = Math.max(0, this.sideCursor - 1);
        return;
      case "g":
        this.sideCursor = 0;
        return;
      case "G":
        this.sideCursor = this.rows.length - 1;
        return;
      case "\r":
        this.go(this.sideCursor);
        this.sideFocus = false;
        return;
      case "\t":
      case "\x1b":
        this.sideFocus = false;
        return;
    }
  }

  private mainInput(data: string): void {
    const h = this.lastHeight;
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d") || data === " ") {
      this.offset += Math.floor(h / 2);
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.offset -= Math.floor(h / 2);
      return;
    }
    switch (data) {
      case "j":
      case "\x1b[B":
        this.offset += 1;
        return;
      case "k":
      case "\x1b[A":
        this.offset -= 1;
        return;
      case "n":
        this.go(this.cursor + 1);
        return;
      case "p":
        this.go(this.cursor - 1);
        return;
      case "g":
        this.offset = 0;
        return;
      case "G":
        this.offset = Number.MAX_SAFE_INTEGER;
        return;
      case "t":
        this.sidebar = !this.sidebar;
        return;
      case "\t":
        this.sidebar = true;
        this.sideFocus = true;
        this.sideCursor = this.cursor;
        return;
      case "e": {
        const f = this.current().section?.file;
        if (f != null) this.opts.onOpen(f.path, f.lines?.[0] ?? 1);
        return;
      }
    }
  }

  private highlightedSource(path: string): string[] | null {
    if (this.highlighted.has(path)) return this.highlighted.get(path) ?? null;
    const src = this.opts.sources.get(path) ?? null;
    const lines = src === null ? null : (highlightFile(path, { old: null, new: src })?.new ?? null);
    this.highlighted.set(path, lines);
    return lines;
  }

  private codeRows(f: WalkthroughFile, w: number): string[] {
    const head = `${C.accent}${BOLD}${where(f)}${RESET} ${C.dim}at ${this.opts.walkthrough.head.slice(0, 10)}`;
    const src = this.opts.sources.get(f.path) ?? null;
    if (src === null) return ["", head, "", `${C.del}${f.path} not found at head`];
    if (f.lines === null) return ["", head, "", `${C.faint}whole file, e to open`];
    const [start, end] = f.lines;
    const ex = excerpt(src, start, end);
    const hl = this.highlightedSource(f.path);
    const out = ["", head, ""];
    ex.lines.forEach((text, i) => {
      const n = ex.start + i;
      const inRange = n >= start && n <= end;
      const code = (hl?.[n - 1] ?? text).replaceAll("\x1b[39m", C.text);
      const gutter = inRange ? `${C.selBg}${C.accent}${String(n).padStart(5)} ▎` : `${C.faint}${String(n).padStart(5)}  `;
      out.push(gutter + RESET + (inRange ? C.selBg : "") + fit(`${C.text}${code}`, w - 7) + RESET);
    });
    return out;
  }

  private mainRows(w: number): string[] {
    const wt = this.opts.walkthrough;
    const pw = Math.min(w, PROSE_WIDTH);
    const { chunk, section } = this.current();
    const out: string[] = [];
    const heading = (title: string, crumb: string): void => {
      if (crumb !== "") out.push(`${C.dim}${crumb}`);
      out.push(`${C.text}${BOLD}${title}${RESET}`, "");
    };
    if (chunk === null) {
      heading(wt.title || "Overview", "overview");
      out.push(...markdownRows(wt.summary, pw));
      out.push("", `${C.dim}${wt.chunks.length} chunks`);
      wt.chunks.forEach((c, i) => out.push(`${C.dim}${String(i + 1).padStart(3)}  ${C.text}${c.title}`));
    } else if (section === null) {
      heading(chunk.title, `chunk ${this.opts.walkthrough.chunks.indexOf(chunk) + 1}/${wt.chunks.length}`);
      out.push(...markdownRows(chunk.summary, pw));
      out.push("", `${C.dim}${chunk.sections.length} sections`);
      chunk.sections.forEach((s) => {
        const loc = s.file === null ? "" : `  ${C.faint}${where(s.file)}`;
        out.push(`${C.dim}  - ${C.text}${s.title}${loc}`);
      });
    } else {
      heading(section.title, chunk.title);
      out.push(...markdownRows(section.markdown, pw));
      if (section.file !== null) out.push(...this.codeRows(section.file, w));
    }
    out.push("");
    return out;
  }

  private sideLabel(row: WalkRow): string {
    const w = this.opts.walkthrough;
    if (row.kind === "overview") return `${C.accent}overview`;
    const chunk = w.chunks[row.chunk];
    if (row.kind === "chunk") return `${C.text}${BOLD}${row.chunk + 1} ${chunk?.title ?? ""}`;
    const s = chunk?.sections[row.section];
    const mark = s?.file != null ? `${C.faint}·` : " ";
    return `   ${mark} ${C.text}${s?.title ?? ""}`;
  }

  private renderSide(height: number, w: number): string[] {
    const out: string[] = [];
    const label = this.sideFocus ? C.accent : C.text;
    out.push(C.barBg + fit(` ${label}${BOLD}Walkthrough${RESET}${C.barBg} ${C.dim}${this.opts.walkthrough.chunks.length} chunks`, w) + RESET);
    const listH = height - 1;
    const cur = this.sideFocus ? this.sideCursor : this.cursor;
    if (cur < this.listOffset) this.listOffset = cur;
    if (cur >= this.listOffset + listH) this.listOffset = cur - listH + 1;
    for (let i = this.listOffset; i < this.rows.length && out.length < height; i++) {
      const row = this.rows[i] as WalkRow;
      const on = i === cur;
      const read = i === this.cursor;
      const marker = on ? `${this.sideFocus ? C.accent : C.dim}▎` : read ? `${C.faint}▎` : " ";
      out.push((on ? C.selBg : "") + fit(`${marker}${this.sideLabel(row)}`, w) + RESET);
    }
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const wt = this.opts.walkthrough;
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}walkthrough  ${wt.title}`, width) + RESET);
    out.push(C.barBg + fit(` ${C.dim}${this.opts.subtitle}   head ${C.text}${wt.head.slice(0, 10)}`, width) + RESET);

    const sideW = this.sidebar ? Math.min(56, Math.max(28, Math.floor(width * 0.34))) : 0;
    const mainW = this.sidebar ? width - sideW - 1 : width;
    const pad = 2;
    const rows = this.mainRows(mainW - pad);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - bodyH)));
    const side = this.sidebar ? this.renderSide(bodyH, sideW) : [];
    for (let i = 0; i < bodyH; i++) {
      const row = rows[this.offset + i] ?? "";
      const main = fit(" ".repeat(pad) + truncateToWidth(row, mainW - pad, ""), mainW);
      out.push(this.sidebar ? `${side[i] ?? ""}${C.faint}│${RESET}${main}${RESET}` : `${main}${RESET}`);
    }

    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const keys = this.sideFocus
      ? ` ${k("j/k", "move")}${k("enter", "read")}${k("tab/esc", "back")}`
      : ` ${k("n/p", "section")}${k("j/k", "scroll")}${k("tab", "outline")}${k("t", "hide")}${k("e", "open")}${k("q", "quit")}`;
    const more = this.offset + bodyH < rows.length ? `${C.accent}more ↓  ` : "";
    const right = `${more}${C.dim}${this.cursor + 1}/${this.rows.length} `;
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(right));
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}
