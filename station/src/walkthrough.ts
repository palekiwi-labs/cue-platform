import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Component,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import { excerpt, storeRoot } from "./findings.js";
import { markdownRows } from "./markdown.js";
import { catFiles } from "./git.js";
import { highlightFile } from "./highlight.js";
import { prContext } from "./pr-review.js";

export type RevKind = "base" | "head" | "commit";

export interface WalkthroughCode {
  path: string;
  lines: [number, number] | null;
  rev: string;
  revKind: RevKind;
}

export interface WalkthroughStep {
  markdown: string;
  code: WalkthroughCode | null;
}

export interface WalkthroughSection {
  title: string;
  steps: WalkthroughStep[];
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

const SHA = /^[0-9a-f]{40}$/;

function parseV1File(v: unknown, head: string): WalkthroughCode | null {
  if (!isObject(v)) return null;
  const path = str(v.path);
  if (path === "") return null;
  const range = Array.isArray(v.lines) ? v.lines.map(line) : [];
  const start = range[0] ?? null;
  const end = range[1] ?? start;
  const lines: [number, number] | null =
    start === null || end === null ? null : [Math.min(start, end), Math.max(start, end)];
  return { path, lines, rev: head, revKind: "head" };
}

function parseV1(address: string, data: Record<string, unknown>): Walkthrough {
  const head = str(data.head);
  return {
    address,
    pr: line(data.pr),
    base: str(data.base),
    head,
    title: str(data.title),
    summary: str(data.summary),
    chunks: list(data.chunks).map((c, i) => ({
      id: str(c.id) || `chunk-${i + 1}`,
      title: str(c.title) || `Chunk ${i + 1}`,
      summary: str(c.summary),
      sections: list(c.sections).map((s, j) => ({
        title: str(s.title) || `Section ${j + 1}`,
        steps: [{ markdown: str(s.markdown), code: parseV1File(s.file, head) }],
      })),
    })),
  };
}

class Checker {
  readonly errors: string[] = [];

  fail(at: string, message: string): void {
    this.errors.push(`${at}: ${message}`);
  }

  keys(o: Record<string, unknown>, at: string, allowed: string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.fail(at, `unknown field ${k}`);
  }

  text(o: Record<string, unknown>, key: string, at: string, required: boolean): string {
    const v = o[key];
    if (v === undefined && !required) return "";
    if (typeof v !== "string" || (required && v.trim() === "")) {
      this.fail(`${at}.${key}`, required ? "must be a non-empty string" : "must be a string");
      return "";
    }
    return v;
  }

  array(o: Record<string, unknown>, key: string, at: string): Record<string, unknown>[] {
    const v = o[key];
    if (!Array.isArray(v) || v.length === 0) {
      this.fail(`${at}.${key}`, "must be a non-empty array");
      return [];
    }
    return v.flatMap((x, i) => {
      if (isObject(x)) return [x];
      this.fail(`${at}.${key}[${i}]`, "must be an object");
      return [];
    });
  }
}

function parseCode(c: Checker, v: unknown, at: string, base: string, head: string): WalkthroughCode | null {
  if (!isObject(v)) {
    c.fail(at, "must be an object");
    return null;
  }
  c.keys(v, at, ["path", "lines", "rev"]);
  const path = c.text(v, "path", at, true);
  if (path.startsWith("/") || path.split("/").includes("..")) c.fail(`${at}.path`, "must be repository-relative");
  let lines: [number, number] | null = null;
  const l = v.lines;
  if (!Array.isArray(l) || l.length !== 2 || line(l[0]) === null || line(l[1]) === null) {
    c.fail(`${at}.lines`, "must be [start, end] with positive integers");
  } else if ((l[0] as number) > (l[1] as number)) {
    c.fail(`${at}.lines`, `start ${l[0]} is after end ${l[1]}`);
  } else {
    lines = [l[0] as number, l[1] as number];
  }
  if (v.rev === undefined) return { path, lines, rev: head, revKind: "head" };
  if (v.rev === "base") return { path, lines, rev: base, revKind: "base" };
  if (typeof v.rev === "string" && SHA.test(v.rev)) {
    const revKind: RevKind = v.rev === head ? "head" : v.rev === base ? "base" : "commit";
    return { path, lines, rev: v.rev, revKind };
  }
  c.fail(`${at}.rev`, `must be "base" or a full 40-character commit sha; omit it for the head`);
  return { path, lines, rev: head, revKind: "head" };
}

/** Checks a version 2 walkthrough and returns every problem found, located by JSON path. */
export function checkWalkthroughV2(
  address: string,
  data: Record<string, unknown>,
): { walkthrough: Walkthrough; errors: string[] } {
  const c = new Checker();
  c.keys(data, "$", ["version", "pr", "base", "head", "title", "summary", "chunks"]);
  if (data.pr !== undefined && line(data.pr) === null) c.fail("$.pr", "must be a positive integer");
  const base = c.text(data, "base", "$", true);
  const head = c.text(data, "head", "$", true);
  if (base !== "" && !SHA.test(base)) c.fail("$.base", "must be the full 40-character merge-base sha");
  if (head !== "" && !SHA.test(head)) c.fail("$.head", "must be the full 40-character head sha");
  const walkthrough: Walkthrough = {
    address,
    pr: line(data.pr),
    base,
    head,
    title: c.text(data, "title", "$", true),
    summary: c.text(data, "summary", "$", false),
    chunks: c.array(data, "chunks", "$").map((ch, i) => {
      const at = `$.chunks[${i}]`;
      c.keys(ch, at, ["id", "title", "summary", "sections"]);
      return {
        id: c.text(ch, "id", at, false) || `chunk-${i + 1}`,
        title: c.text(ch, "title", at, true),
        summary: c.text(ch, "summary", at, false),
        sections: c.array(ch, "sections", at).map((s, j) => {
          const sat = `${at}.sections[${j}]`;
          c.keys(s, sat, ["title", "steps"]);
          return {
            title: c.text(s, "title", sat, true),
            steps: c.array(s, "steps", sat).map((st, k) => {
              const kat = `${sat}.steps[${k}]`;
              c.keys(st, kat, ["markdown", "code"]);
              const markdown = c.text(st, "markdown", kat, false);
              if (markdown.trim() === "" && st.code === undefined) c.fail(kat, "needs markdown, code or both");
              const code = st.code === undefined ? null : parseCode(c, st.code, `${kat}.code`, base, head);
              return { markdown, code };
            }),
          };
        }),
      };
    }),
  };
  return { walkthrough, errors: c.errors };
}

export function parseWalkthrough(address: string, data: Record<string, unknown>): Walkthrough {
  if (data.version === 1) return parseV1(address, data);
  if (data.version !== 2) throw new Error(`unsupported walkthrough version ${String(data.version)}: ${address}`);
  const { walkthrough, errors } = checkWalkthroughV2(address, data);
  if (errors.length > 0) throw new Error(`invalid walkthrough ${address}:\n${errors.join("\n")}`);
  return walkthrough;
}

export function loadWalkthrough(address: string, store = storeRoot()): Walkthrough {
  const path = walkthroughPath(address, store);
  if (!existsSync(path)) throw new Error(`no walkthrough at ${address}`);
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isObject(data)) throw new Error(`walkthrough is not a JSON object: ${address}`);
  return parseWalkthrough(address, data);
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

export function sourceKey(code: WalkthroughCode): string {
  return `${code.rev}:${code.path}`;
}

export function codeRefs(w: Walkthrough): WalkthroughCode[] {
  return w.chunks.flatMap((c) => c.sections.flatMap((s) => s.steps.flatMap((st) => (st.code === null ? [] : [st.code]))));
}

/** Reads every referenced blob at its own revision, keyed by sourceKey. */
export function loadWalkthroughSources(repoPath: string, w: Walkthrough): Map<string, string | null> {
  const keys = [...new Set(codeRefs(w).map(sourceKey))];
  const blobs = catFiles(repoPath, keys);
  return new Map(keys.map((k, i) => [k, blobs[i] ?? null]));
}

const PROSE_WIDTH = 80;

function where(f: WalkthroughCode): string {
  return f.lines === null ? f.path : `${f.path}:${f.lines[0]}-${f.lines[1]}`;
}

function revLabel(f: WalkthroughCode): string {
  return `${f.revKind} · ${f.rev.slice(0, 10)}`;
}

export interface WalkthroughOptions {
  walkthrough: Walkthrough;
  sources: Map<string, string | null>;
  subtitle: string;
  onQuit: () => void;
  onOpen: (rev: string, file: string, line: number) => void;
}

interface MainPane {
  rows: string[];
  steps: Array<[number, number]>;
}

export class WalkthroughView implements Component {
  private readonly rows: WalkRow[];
  private cursor = 0;
  private step = 0;
  private sideCursor = 0;
  private sideFocus = false;
  private sidebar = true;
  private offset = 0;
  private listOffset = 0;
  private lastHeight = 20;
  private reveal = false;
  private readonly highlighted = new Map<string, string[] | null>();

  constructor(private readonly opts: WalkthroughOptions) {
    this.rows = walkRows(opts.walkthrough);
  }

  invalidate(): void {}

  get position(): number {
    return this.cursor;
  }

  get focusedStep(): number {
    return this.step;
  }

  get focusedSidebar(): boolean {
    return this.sideFocus;
  }

  private go(index: number): void {
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, index));
    this.offset = 0;
    this.step = 0;
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

  private moveStep(delta: number): void {
    const count = this.current().section?.steps.length ?? 0;
    if (count === 0) return;
    this.step = Math.max(0, Math.min(count - 1, this.step + delta));
    this.reveal = true;
  }

  private mainInput(data: string): void {
    const h = this.lastHeight;
    if (matchesKey(data, "ctrl+down")) {
      this.go(this.cursor + 1);
      return;
    }
    if (matchesKey(data, "ctrl+up")) {
      this.go(this.cursor - 1);
      return;
    }
    if (matchesKey(data, "shift+down")) {
      this.offset += 1;
      return;
    }
    if (matchesKey(data, "shift+up")) {
      this.offset -= 1;
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveStep(1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveStep(-1);
      return;
    }
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
        this.offset += 1;
        return;
      case "k":
        this.offset -= 1;
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
        const code = this.current().section?.steps[this.step]?.code;
        if (code != null) this.opts.onOpen(code.rev, code.path, code.lines?.[0] ?? 1);
        return;
      }
    }
  }

  private highlightedSource(code: WalkthroughCode): string[] | null {
    const key = sourceKey(code);
    if (this.highlighted.has(key)) return this.highlighted.get(key) ?? null;
    const src = this.opts.sources.get(key) ?? null;
    const lines = src === null ? null : (highlightFile(code.path, { old: null, new: src })?.new ?? null);
    this.highlighted.set(key, lines);
    return lines;
  }

  private codeRows(f: WalkthroughCode, w: number): string[] {
    const head = `${C.accent}${BOLD}${where(f)}${RESET} ${C.dim}${revLabel(f)}`;
    const src = this.opts.sources.get(sourceKey(f)) ?? null;
    if (src === null) return ["", head, "", `${C.del}${f.path} not found at ${f.revKind} ${f.rev.slice(0, 10)}`];
    if (f.lines === null) return ["", head, "", `${C.faint}whole file, e to open`];
    const [start, end] = f.lines;
    const total = src.endsWith("\n") ? src.split("\n").length - 1 : src.split("\n").length;
    if (end > total) {
      return ["", head, "", `${C.del}lines ${start}-${end} are outside ${f.path} (${total} lines at ${f.revKind})`];
    }
    const ex = excerpt(src, start, end);
    const hl = this.highlightedSource(f);
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

  private mainPane(w: number): MainPane {
    const wt = this.opts.walkthrough;
    const pw = Math.min(w, PROSE_WIDTH);
    const { chunk, section } = this.current();
    const out: string[] = [];
    const steps: Array<[number, number]> = [];
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
      heading(chunk.title, `chunk ${wt.chunks.indexOf(chunk) + 1}/${wt.chunks.length}`);
      out.push(...markdownRows(chunk.summary, pw));
      out.push("", `${C.dim}${chunk.sections.length} sections`);
      chunk.sections.forEach((s) => {
        const snippets = s.steps.filter((st) => st.code !== null).length;
        const loc = snippets === 0 ? "" : `  ${C.faint}${snippets} snippet${snippets === 1 ? "" : "s"}`;
        out.push(`${C.dim}  - ${C.text}${s.title}${loc}`);
      });
    } else {
      heading(section.title, chunk.title);
      section.steps.forEach((st, i) => {
        if (i > 0) out.push("");
        const start = out.length;
        out.push(...markdownRows(st.markdown, pw));
        if (st.code !== null) {
          const code = this.codeRows(st.code, w);
          out.push(...(start === out.length ? code.slice(1) : code));
        }
        steps.push([start, out.length]);
      });
    }
    out.push("");
    return { rows: out, steps };
  }

  private settle(steps: Array<[number, number]>, height: number, total: number): void {
    const max = Math.max(0, total - height);
    const span = steps[this.step];
    if (this.reveal && span !== undefined) {
      const [start, end] = span;
      if (start < this.offset) this.offset = start;
      else if (end > this.offset + height) this.offset = end - start <= height ? end - height : start;
    }
    this.reveal = false;
    this.offset = Math.max(0, Math.min(this.offset, max));
    const visible = (s: [number, number]): boolean => s[1] > this.offset && s[0] < this.offset + height;
    const cur = steps[this.step];
    if (cur !== undefined && !visible(cur)) {
      const first = steps.findIndex(visible);
      if (first !== -1) this.step = first;
    }
  }

  private sideLabel(row: WalkRow): string {
    const w = this.opts.walkthrough;
    if (row.kind === "overview") return `${C.accent}overview`;
    const chunk = w.chunks[row.chunk];
    if (row.kind === "chunk") return `${C.text}${BOLD}${row.chunk + 1} ${chunk?.title ?? ""}`;
    const s = chunk?.sections[row.section];
    const mark = s?.steps.some((st) => st.code !== null) ? `${C.faint}·` : " ";
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

  private stepStatus(): string {
    const section = this.current().section;
    if (section === null) return "";
    const code = section.steps[this.step]?.code;
    const loc = code == null ? "" : `${C.dim}${code.path} ${C.faint}${code.revKind}  `;
    return `${loc}${C.dim}step ${this.step + 1}/${section.steps.length}  `;
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
    const { rows, steps } = this.mainPane(mainW - pad);
    this.settle(steps, bodyH, rows.length);
    const focus = steps.length > 1 ? steps[this.step] : undefined;
    const side = this.sidebar ? this.renderSide(bodyH, sideW) : [];
    for (let i = 0; i < bodyH; i++) {
      const n = this.offset + i;
      const row = rows[n] ?? "";
      const marked = focus !== undefined && n >= focus[0] && n < focus[1];
      const lead = marked ? `${C.accent}▎ ${RESET}` : " ".repeat(pad);
      const main = fit(lead + truncateToWidth(row, mainW - pad, ""), mainW);
      out.push(this.sidebar ? `${main}${RESET}${C.faint}│${RESET}${side[i] ?? ""}` : `${main}${RESET}`);
    }

    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const keys = this.sideFocus
      ? ` ${k("j/k", "move")}${k("enter", "read")}${k("tab/esc", "back")}`
      : ` ${k("↑/↓", "step")}${k("^↑/^↓", "section")}${k("j/k ⇧↑/⇧↓", "scroll")}${k("tab", "outline")}${k("t", "hide")}${k("e", "open")}${k("q", "quit")}`;
    const more = this.offset + bodyH < rows.length ? `${C.accent}more ↓  ` : "";
    const right = `${more}${this.stepStatus()}${C.dim}${this.cursor + 1}/${this.rows.length} `;
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(right));
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}
