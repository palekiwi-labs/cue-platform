import { randomUUID } from "node:crypto";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Packet, PacketChunk, PacketFile } from "./packet.js";
import type { Highlights } from "./highlight.js";
import type { RoundComment } from "./round.js";
import { chunkFingerprint, type CommentState, type DraftComment, type FoldState } from "./state.js";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;

export const C = {
  text: fg(220, 223, 228),
  dim: fg(125, 133, 144),
  faint: fg(85, 92, 102),
  accent: fg(88, 166, 255),
  add: fg(126, 231, 135),
  del: fg(255, 123, 114),
  mod: fg(227, 179, 65),
  ren: fg(121, 192, 255),
  addBg: bg(18, 52, 32),
  delBg: bg(66, 24, 28),
  addNumBg: bg(24, 70, 42),
  delNumBg: bg(90, 30, 34),
  barBg: bg(22, 27, 34),
  titleBg: bg(31, 51, 82),
  fileBg: bg(33, 38, 46),
  hunkBg: bg(22, 30, 44),
  selBg: bg(38, 50, 68),
  curBg: bg(58, 78, 112),
  noteBg: bg(38, 34, 24),
};

const GUTTER = 12;

type Row =
  | { kind: "file"; file: number }
  | { kind: "hunk"; chunk: number }
  | { kind: "folded"; chunk: number; lines: number; comments: number }
  | LineRow
  | { kind: "comment"; chunk: number; id: string; head: boolean; text: string }
  | { kind: "note"; file: number; text: string }
  | { kind: "blank" };

interface LineNumbers {
  oldNo: number | null;
  newNo: number | null;
  pos: number;
}

interface LineRow extends LineNumbers {
  kind: "line";
  chunk: number;
  index: number;
  sign: string;
  text: string;
}

interface Stop {
  file: number;
  chunk: number | null;
}

type Item = { chunk: number; line: number } | { chunk: number; comment: string };

interface CommentEntry {
  comment: DraftComment;
  chunk: number | null;
}

export interface ComposeRequest {
  title: string;
  text: string;
}

export interface ChangesOptions {
  title: string;
  subtitle: string;
  packet: Packet;
  folds: FoldState;
  comments: CommentState;
  highlights?: Highlights;
  headMatches: boolean;
  onQuit: () => void;
  quitLabel?: string;
  onFolds: (folds: FoldState) => void;
  onComments: (comments: CommentState) => void;
  onCompose: (request: ComposeRequest, done: (text: string | null) => void) => void;
  onOpen: (file: PacketFile, line: number) => void;
  onSubmit: (comments: RoundComment[], done: (ok: boolean) => void) => void;
}

function statusLetter(f: PacketFile): string {
  switch (f.status) {
    case "added":
      return `${C.add}A`;
    case "deleted":
      return `${C.del}D`;
    case "renamed":
      return `${C.ren}R`;
    default:
      return `${C.mod}M`;
  }
}

export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "", true);
}

function tailPath(path: string, width: number): string {
  if (visibleWidth(path) <= width) return path;
  return "…" + path.slice(path.length - Math.max(1, width - 1));
}

function num(n: number | null): string {
  return n === null ? "     " : String(n).padStart(5);
}

export class ChangesView implements Component {
  private readonly opts: ChangesOptions;
  private readonly packet: Packet;
  private readonly fileChunks: number[][];
  private readonly fingerprints: string[];
  private readonly chunkFile: number[];
  private folds: FoldState;
  private comments: CommentState;
  private item: Item | null = null;
  private anchor: number | null = null;
  private wrapW = 0;
  private rows: Row[] = [];
  private rowOfStop: number[] = [];
  private stops: Stop[] = [];
  private cursor = 0;
  private offset = 0;
  private sidebarOffset = 0;
  private sidebar = true;
  private sideFocus = false;
  private sideMode: "files" | "comments" = "files";
  private commentCursor = 0;
  private fileCursor = 0;
  private lastHeight = 20;

  constructor(opts: ChangesOptions) {
    this.opts = opts;
    this.packet = opts.packet;
    this.folds = opts.folds;
    this.comments = opts.comments;
    const fileIndex = new Map(this.packet.files.map((f, i) => [f.id, i]));
    this.fileChunks = this.packet.files.map(() => []);
    this.chunkFile = this.packet.chunks.map((c) => fileIndex.get(c.file_id) ?? 0);
    this.fingerprints = this.packet.chunks.map((c, i) => {
      const fi = fileIndex.get(c.file_id) ?? 0;
      this.fileChunks[fi]?.push(i);
      return chunkFingerprint(this.packet.files[fi]?.path ?? "", c.patch);
    });
    this.rebuild();
  }

  invalidate(): void {}

  private file(i: number): PacketFile {
    return this.packet.files[i] as PacketFile;
  }

  private chunk(i: number): PacketChunk {
    return this.packet.chunks[i] as PacketChunk;
  }

  private fileFolded(i: number): boolean {
    return this.folds.files.includes(this.file(i).path);
  }

  private chunkFolded(i: number): boolean {
    return this.folds.chunks.includes(this.fingerprints[i] ?? "");
  }

  private current(): Stop {
    return this.stops[this.cursor] ?? { file: 0, chunk: null };
  }

  private rebuild(): void {
    const prev = this.stops[this.cursor];
    this.rows = [];
    this.stops = [];
    this.rowOfStop = [];
    this.packet.files.forEach((f, fi) => {
      if (fi > 0) this.rows.push({ kind: "blank" });
      const fileRow = this.rows.length;
      this.rows.push({ kind: "file", file: fi });
      const chunks = this.fileChunks[fi] ?? [];
      if (this.fileFolded(fi) || chunks.length === 0) {
        this.stops.push({ file: fi, chunk: null });
        this.rowOfStop.push(fileRow);
        if (!this.fileFolded(fi)) {
          const why = f.binary ? "binary file" : f.status === "renamed" ? "renamed without changes" : "no content changes";
          this.rows.push({ kind: "note", file: fi, text: why });
        }
        return;
      }
      for (const ci of chunks) {
        this.stops.push({ file: fi, chunk: ci });
        this.rowOfStop.push(this.rows.length);
        this.pushChunk(ci);
      }
    });
    if (prev !== undefined) {
      const same = this.stops.findIndex((s) => s.file === prev.file && s.chunk === prev.chunk);
      const sameFile = this.stops.findIndex((s) => s.file === prev.file);
      this.cursor = same !== -1 ? same : sameFile !== -1 ? sameFile : 0;
    }
    if (this.item !== null && this.rowOf(this.item) === -1) {
      this.item = this.firstItem(this.item.chunk);
      this.anchor = null;
    }
  }

  private chunkComments(ci: number): DraftComment[] {
    const fp = this.fingerprints[ci];
    return this.comments.comments.filter((c) => c.chunk === fp);
  }

  private lineNumbers(ci: number): LineNumbers[] {
    const c = this.chunk(ci);
    let oldNo = c.old_start;
    let newNo = c.new_start;
    return c.patch
      .split("\n")
      .slice(1)
      .map((raw) => {
        const sign = raw.slice(0, 1);
        if (sign === "+") return { oldNo: null, newNo, pos: newNo++ };
        if (sign === "-") return { oldNo: oldNo++, newNo: null, pos: newNo };
        if (sign === "\\") return { oldNo: null, newNo: null, pos: newNo };
        return { oldNo: oldNo++, newNo, pos: newNo++ };
      });
  }

  private lineLabel(ci: number, from: number, to: number): string {
    const nums = this.lineNumbers(ci);
    const at = (i: number): string => {
      const n = nums[i];
      if (n === undefined) return "?";
      return n.newNo !== null ? String(n.newNo) : `-${n.oldNo ?? "?"}`;
    };
    return from === to ? `line ${at(from)}` : `lines ${at(from)} to ${at(to)}`;
  }

  private commentLabel(ci: number, c: DraftComment): string {
    return c.from === null || c.to === null ? "whole chunk" : this.lineLabel(ci, c.from, c.to);
  }

  private pushComment(ci: number, c: DraftComment): void {
    this.rows.push({ kind: "comment", chunk: ci, id: c.id, head: true, text: this.commentLabel(ci, c) });
    const width = Math.max(20, (this.wrapW > 0 ? this.wrapW : 100) - GUTTER - 4);
    for (const line of wrapTextWithAnsi(c.text, width)) {
      this.rows.push({ kind: "comment", chunk: ci, id: c.id, head: false, text: line });
    }
  }

  private pushChunk(ci: number): void {
    const c = this.chunk(ci);
    const body = c.patch.split("\n").slice(1);
    const comments = this.chunkComments(ci);
    if (this.chunkFolded(ci)) {
      this.rows.push({ kind: "folded", chunk: ci, lines: body.length, comments: comments.length });
      return;
    }
    this.rows.push({ kind: "hunk", chunk: ci });
    for (const cm of comments) if (cm.from === null) this.pushComment(ci, cm);
    const nums = this.lineNumbers(ci);
    body.forEach((raw, index) => {
      const first = raw.slice(0, 1);
      const sign = first === "+" || first === "-" || first === "\\" ? first : " ";
      const text = sign === "\\" ? raw : raw.slice(1).replace(/\t/g, "    ");
      const n = nums[index] ?? { oldNo: null, newNo: null, pos: c.new_start };
      this.rows.push({ kind: "line", chunk: ci, index, sign, ...n, text });
      for (const cm of comments) if (cm.from !== null && cm.to === index) this.pushComment(ci, cm);
    });
  }

  private stopEndRow(i: number): number {
    const next = this.rowOfStop[i + 1];
    return (next ?? this.rows.length) - 1;
  }

  private reveal(): void {
    const start = this.rowOfStop[this.cursor] ?? 0;
    const end = this.stopEndRow(this.cursor);
    const h = this.lastHeight;
    if (start >= this.offset && end < this.offset + h) return;
    if (start >= this.offset && start < this.offset + h && end - start >= h) return;
    const before = this.rows[start - 1]?.kind === "file" ? 2 : 1;
    this.offset = Math.max(0, start - before);
  }

  private moveTo(i: number): void {
    this.cursor = Math.min(Math.max(i, 0), this.stops.length - 1);
    this.reveal();
  }

  private moveFile(delta: number): void {
    this.jumpFile(this.current().file + delta);
  }

  private jumpFile(target: number): void {
    const i = this.stops.findIndex((s) => s.file === target);
    if (i === -1) return;
    this.cursor = i;
    const start = this.rowOfStop[i] ?? 0;
    this.offset = this.rows[start]?.kind === "file" ? start : Math.max(0, start - 1);
  }

  private toggle(list: string[], key: string): string[] {
    return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  }

  private foldChunk(): void {
    const s = this.current();
    if (s.chunk === null) {
      this.foldFile();
      return;
    }
    this.folds = { ...this.folds, chunks: this.toggle(this.folds.chunks, this.fingerprints[s.chunk] ?? "") };
    this.afterFold();
  }

  private foldFile(): void {
    const path = this.file(this.current().file).path;
    this.folds = { ...this.folds, files: this.toggle(this.folds.files, path) };
    this.afterFold();
  }

  private afterFold(): void {
    this.opts.onFolds(this.folds);
    this.rebuild();
    this.reveal();
  }

  private itemAt(r: number): Item | null {
    const row = this.rows[r];
    if (row?.kind === "line" && row.sign !== "\\") return { chunk: row.chunk, line: row.index };
    if (row?.kind === "comment" && row.head) return { chunk: row.chunk, comment: row.id };
    return null;
  }

  private rowOf(item: Item): number {
    return this.rows.findIndex((row) =>
      "line" in item
        ? row.kind === "line" && row.chunk === item.chunk && row.index === item.line
        : row.kind === "comment" && row.head && row.id === item.comment,
    );
  }

  private firstItem(ci: number): Item | null {
    const start = this.rows.findIndex((row) => row.kind === "hunk" && row.chunk === ci);
    if (start === -1) return null;
    for (let r = start + 1; r < this.rows.length; r++) {
      const it = this.itemAt(r);
      if (it === null) continue;
      return it.chunk === ci ? it : null;
    }
    return null;
  }

  private itemEndRow(r: number): number {
    const row = this.rows[r];
    if (row?.kind !== "comment") return r;
    let end = r;
    while (this.rows[end + 1]?.kind === "comment" && !(this.rows[end + 1] as { head: boolean }).head) end++;
    return end;
  }

  private setItem(item: Item): void {
    this.item = item;
    const stop = this.stops.findIndex((s) => s.chunk === item.chunk);
    if (stop !== -1) this.cursor = stop;
    const r = this.rowOf(item);
    if (r === -1) return;
    const top = r - 2;
    const bottom = this.itemEndRow(r) + 2;
    const h = this.lastHeight;
    if (top < this.offset) this.offset = Math.max(0, top);
    else if (bottom >= this.offset + h) this.offset = Math.min(Math.max(0, top), bottom - h + 1);
  }

  private moveItem(delta: number): void {
    if (this.item === null) return;
    const from = this.item;
    for (let r = this.rowOf(from) + delta; r >= 0 && r < this.rows.length; r += delta) {
      const it = this.itemAt(r);
      if (it === null) continue;
      if (this.anchor !== null) {
        if (it.chunk !== from.chunk) return;
        if (!("line" in it)) continue;
      }
      this.setItem(it);
      return;
    }
  }

  private enterLines(): void {
    const s = this.current();
    if (s.chunk === null) {
      this.open();
      return;
    }
    if (this.chunkFolded(s.chunk)) this.foldChunk();
    const first = this.firstItem(s.chunk);
    if (first !== null) this.setItem(first);
  }

  private exitLines(): void {
    this.item = null;
    this.anchor = null;
    this.reveal();
  }

  private commentById(id: string): DraftComment | undefined {
    return this.comments.comments.find((c) => c.id === id);
  }

  private setComments(comments: DraftComment[]): void {
    this.comments = { ...this.comments, comments };
    this.opts.onComments(this.comments);
    this.rebuild();
  }

  private composeTitle(ci: number, label: string): string {
    return `${this.file(this.chunkFile[ci] ?? 0).path} · ${label}`;
  }

  private addComment(ci: number, from: number | null, to: number | null): void {
    const fp = this.fingerprints[ci] ?? "";
    const path = this.file(this.chunkFile[ci] ?? 0).path;
    const label = from === null || to === null ? "whole chunk" : this.lineLabel(ci, from, to);
    this.opts.onCompose({ title: this.composeTitle(ci, label), text: "" }, (text) => {
      if (text === null) return;
      const id = randomUUID().slice(0, 8);
      this.anchor = null;
      this.setComments([
        ...this.comments.comments,
        { id, path, chunk: fp, from, to, text, created_at: Math.floor(Date.now() / 1000) },
      ]);
      if (this.item !== null) this.setItem({ chunk: ci, comment: id });
    });
  }

  private commentChunk(): void {
    const s = this.current();
    if (s.chunk !== null) this.addComment(s.chunk, null, null);
  }

  private commentLines(): void {
    const it = this.item;
    if (it === null || !("line" in it)) return;
    const a = this.anchor ?? it.line;
    this.addComment(it.chunk, Math.min(a, it.line), Math.max(a, it.line));
  }

  private editComment(): void {
    const it = this.item;
    if (it === null || !("comment" in it)) return;
    const c = this.commentById(it.comment);
    if (c !== undefined) this.edit({ comment: c, chunk: it.chunk });
  }

  private entryLabel(e: CommentEntry): string {
    return e.chunk === null ? "outdated" : this.commentLabel(e.chunk, e.comment);
  }

  private edit(e: CommentEntry): void {
    const c = e.comment;
    this.opts.onCompose({ title: `${c.path} · ${this.entryLabel(e)}`, text: c.text }, (text) => {
      if (text === null) return;
      this.setComments(this.comments.comments.map((x) => (x.id === c.id ? { ...x, text } : x)));
    });
  }

  private commentEntries(): CommentEntry[] {
    const chunkOf = new Map(this.fingerprints.map((fp, i) => [fp, i]));
    const live: CommentEntry[] = [];
    const outdated: CommentEntry[] = [];
    for (const c of this.comments.comments) {
      const chunk = chunkOf.get(c.chunk);
      if (chunk === undefined) outdated.push({ comment: c, chunk: null });
      else live.push({ comment: c, chunk });
    }
    live.sort((a, b) => (a.chunk ?? 0) - (b.chunk ?? 0) || (a.comment.to ?? -1) - (b.comment.to ?? -1));
    outdated.sort((a, b) => a.comment.path.localeCompare(b.comment.path) || a.comment.created_at - b.comment.created_at);
    return [...live, ...outdated];
  }

  private jumpToComment(e: CommentEntry): void {
    const ci = e.chunk;
    if (ci === null) return;
    const path = this.file(this.chunkFile[ci] ?? 0).path;
    const fp = this.fingerprints[ci] ?? "";
    if (this.folds.files.includes(path) || this.folds.chunks.includes(fp)) {
      this.folds = {
        ...this.folds,
        files: this.folds.files.filter((p) => p !== path),
        chunks: this.folds.chunks.filter((f) => f !== fp),
      };
      this.opts.onFolds(this.folds);
      this.rebuild();
    }
    this.anchor = null;
    this.setItem({ chunk: ci, comment: e.comment.id });
    this.sideFocus = false;
  }

  private roundComment(e: CommentEntry): RoundComment {
    const c = e.comment;
    const base = { path: c.path, chunk: c.chunk, text: c.text, created_at: c.created_at };
    const ci = e.chunk;
    if (ci === null) {
      const anchor = c.from === null ? "chunk" : "lines";
      return { ...base, outdated: true, anchor, sides: [], old_lines: null, new_lines: null, snippet: null };
    }
    const body = this.chunk(ci).patch.split("\n").slice(1);
    const from = c.from ?? 0;
    const to = c.to ?? body.length - 1;
    const nums = this.lineNumbers(ci).slice(from, to + 1);
    const span = (xs: (number | null)[]): [number, number] | null => {
      const ns = xs.filter((n): n is number => n !== null);
      return ns.length === 0 ? null : [Math.min(...ns), Math.max(...ns)];
    };
    const old_lines = span(nums.map((n) => n.oldNo));
    const new_lines = span(nums.map((n) => n.newNo));
    const sides: ("old" | "new")[] = [];
    if (old_lines !== null) sides.push("old");
    if (new_lines !== null) sides.push("new");
    return {
      ...base,
      outdated: false,
      anchor: c.from === null ? "chunk" : "lines",
      sides,
      old_lines,
      new_lines,
      snippet: body.slice(from, to + 1).join("\n"),
    };
  }

  private submit(): void {
    const entries = this.commentEntries();
    if (entries.length === 0) return;
    const ids = new Set(entries.map((e) => e.comment.id));
    this.opts.onSubmit(entries.map((e) => this.roundComment(e)), (ok) => {
      if (!ok) return;
      this.setComments(this.comments.comments.filter((c) => !ids.has(c.id)));
      this.commentCursor = 0;
    });
  }

  private showComments(): void {
    this.sidebar = true;
    this.sideFocus = true;
    if (this.sideMode !== "comments") this.sidebarOffset = 0;
    this.sideMode = "comments";
    const it = this.item;
    const entries = this.commentEntries();
    const at = it !== null && "comment" in it ? entries.findIndex((e) => e.comment.id === it.comment) : -1;
    if (at !== -1) this.commentCursor = at;
    this.commentCursor = Math.max(0, Math.min(this.commentCursor, entries.length - 1));
  }

  private showFiles(): void {
    if (this.sideMode !== "files") this.sidebarOffset = 0;
    this.sideMode = "files";
    this.fileCursor = this.current().file;
  }

  private deleteComment(): void {
    const it = this.item;
    if (it === null || !("comment" in it)) return;
    const c = this.commentById(it.comment);
    if (c === undefined) return;
    this.setComments(this.comments.comments.filter((x) => x.id !== c.id));
    const back = c.to !== null ? { chunk: it.chunk, line: c.to } : this.firstItem(it.chunk);
    if (back !== null && this.rowOf(back) !== -1) this.setItem(back);
  }

  private openItem(): void {
    const it = this.item;
    if (it === null) return;
    const f = this.file(this.chunkFile[it.chunk] ?? 0);
    const index: number | null = "line" in it ? it.line : (this.commentById(it.comment)?.to ?? null);
    if (index === null) {
      this.open();
      return;
    }
    const n = this.lineNumbers(it.chunk)[index];
    this.opts.onOpen(f, Math.max(1, n?.pos ?? 1));
  }

  private open(): void {
    const s = this.current();
    const f = this.file(s.file);
    if (s.chunk === null) {
      this.opts.onOpen(f, 1);
      return;
    }
    const c = this.chunk(s.chunk);
    let line = c.new_start;
    for (const raw of c.patch.split("\n").slice(1)) {
      if (raw.startsWith("+") || raw.startsWith("-")) break;
      if (raw.startsWith(" ")) line++;
    }
    this.opts.onOpen(f, Math.max(1, line));
  }

  handleEscape(): boolean {
    if (this.sideFocus) {
      this.sideFocus = false;
      return true;
    }
    if (this.item === null) return false;
    if (this.anchor !== null) this.anchor = null;
    else this.exitLines();
    return true;
  }

  private handleLineInput(data: string): void {
    const h = this.lastHeight;
    switch (data) {
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      case "j":
      case "\x1b[B":
        this.moveItem(1);
        return;
      case "k":
      case "\x1b[A":
        this.moveItem(-1);
        return;
      case "V":
      case "v":
        if (this.anchor !== null) this.anchor = null;
        else if (this.item !== null && "line" in this.item) this.anchor = this.item.line;
        return;
      case "c":
        this.commentLines();
        return;
      case "e":
        this.editComment();
        return;
      case "d":
        this.deleteComment();
        return;
      case "o":
        this.openItem();
        return;
      case "\x04":
      case "\x1b[6~":
      case "J":
        this.offset += Math.floor(h / 2);
        return;
      case "\x15":
      case "\x1b[5~":
      case "K":
        this.offset -= Math.floor(h / 2);
        return;
      default:
        return;
    }
  }

  private handleFilesInput(data: string): void {
    const n = this.packet.files.length;
    switch (data) {
      case "j":
      case "\x1b[B":
        this.fileCursor = Math.min(n - 1, this.fileCursor + 1);
        return;
      case "k":
      case "\x1b[A":
        this.fileCursor = Math.max(0, this.fileCursor - 1);
        return;
      case "g":
        this.fileCursor = 0;
        return;
      case "G":
        this.fileCursor = n - 1;
        return;
      case "\r":
      case "l":
        this.jumpFile(this.fileCursor);
        this.sideFocus = false;
        return;
      case "\t":
        this.sideFocus = false;
        return;
      case "C":
        this.showComments();
        return;
      case "t":
        this.sideFocus = false;
        this.sidebar = false;
        return;
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      default:
        return;
    }
  }

  private handleCommentsInput(data: string): void {
    const entries = this.commentEntries();
    const n = entries.length;
    const e = entries[this.commentCursor];
    switch (data) {
      case "j":
      case "\x1b[B":
        this.commentCursor = Math.max(0, Math.min(n - 1, this.commentCursor + 1));
        return;
      case "k":
      case "\x1b[A":
        this.commentCursor = Math.max(0, this.commentCursor - 1);
        return;
      case "g":
        this.commentCursor = 0;
        return;
      case "G":
        this.commentCursor = Math.max(0, n - 1);
        return;
      case "\r":
      case "l":
        if (e !== undefined) this.jumpToComment(e);
        return;
      case "e":
        if (e !== undefined) this.edit(e);
        return;
      case "d":
        if (e === undefined) return;
        this.setComments(this.comments.comments.filter((x) => x.id !== e.comment.id));
        this.commentCursor = Math.max(0, Math.min(this.commentCursor, n - 2));
        return;
      case "C":
        this.showFiles();
        return;
      case "S":
        this.submit();
        return;
      case "\t":
        this.sideFocus = false;
        return;
      case "t":
        this.sideFocus = false;
        this.sidebar = false;
        return;
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      default:
        return;
    }
  }

  handleInput(data: string): void {
    if (this.sideFocus) {
      if (this.sideMode === "comments") this.handleCommentsInput(data);
      else this.handleFilesInput(data);
      return;
    }
    if (data === "C") {
      this.showComments();
      return;
    }
    if (this.item !== null) {
      this.handleLineInput(data);
      return;
    }
    const h = this.lastHeight;
    switch (data) {
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      case "j":
      case "\x1b[B":
        this.moveTo(this.cursor + 1);
        return;
      case "k":
      case "\x1b[A":
        this.moveTo(this.cursor - 1);
        return;
      case "n":
      case "]":
        this.moveFile(1);
        return;
      case "p":
      case "[":
        this.moveFile(-1);
        return;
      case "g":
        this.moveTo(0);
        this.offset = 0;
        return;
      case "G":
        this.moveTo(this.stops.length - 1);
        return;
      case "\x04":
      case "\x1b[6~":
      case "J":
        this.offset += Math.floor(h / 2);
        return;
      case "\x15":
      case "\x1b[5~":
      case "K":
        this.offset -= Math.floor(h / 2);
        return;
      case " ":
      case "z":
        this.foldChunk();
        return;
      case "f":
      case "Z":
        this.foldFile();
        return;
      case "t":
        this.sidebar = !this.sidebar;
        return;
      case "\t":
        this.sidebar = true;
        this.sideFocus = true;
        this.fileCursor = this.current().file;
        return;
      case "e":
        this.open();
        return;
      case "\r":
        this.enterLines();
        return;
      case "c":
        this.commentChunk();
        return;
      default:
        return;
    }
  }

  private code(row: { chunk: number; sign: string; oldNo: number | null; newNo: number | null; text: string }): string {
    const path = this.file(this.chunkFile[row.chunk] ?? 0).path;
    const h = this.opts.highlights?.get(path);
    const lines = row.sign === "-" ? h?.old : h?.new;
    const n = row.sign === "-" ? row.oldNo : row.newNo;
    const line = n === null ? undefined : lines?.[n - 1];
    return line === undefined ? row.text : line.replaceAll("\x1b[39m", C.text);
  }

  private renderRow(row: Row, w: number): string {
    const cur = this.current();
    const activeChunk = cur.chunk;
    const mark = (on: boolean): string => (on ? `${C.accent}▎${RESET}` : " ");
    switch (row.kind) {
      case "blank":
        return "";
      case "file": {
        const f = this.file(row.file);
        const on = cur.file === row.file && cur.chunk === null;
        const arrow = this.fileFolded(row.file) ? "▸" : "▾";
        const name = f.status === "renamed" && f.old_path !== null ? `${f.old_path} → ${f.path}` : f.path;
        const counts = f.binary ? "" : `${C.add}+${f.additions} ${C.del}-${f.deletions}`;
        const left = `${C.dim}${arrow} ${statusLetter(f)} ${C.text}${BOLD}${name}${RESET}${C.fileBg}  ${counts}`;
        return mark(on) + C.fileBg + fit(` ${left}`, w - 1) + RESET;
      }
      case "hunk": {
        const c = this.chunk(row.chunk);
        const on = row.chunk === activeChunk;
        const label = c.section !== "" ? c.section.trim() : "";
        const text = `${C.faint}  ⋯ ${C.dim}line ${c.new_start}${label !== "" ? `  ${C.text}${label}` : ""}`;
        return mark(on) + C.hunkBg + fit(text, w - 1) + RESET;
      }
      case "folded": {
        const c = this.chunk(row.chunk);
        const on = row.chunk === activeChunk;
        const label = c.section !== "" ? `  ${c.section.trim()}` : "";
        const notes = row.comments > 0 ? `  ${C.mod}${row.comments} comment${row.comments === 1 ? "" : "s"}` : "";
        const text = `${C.dim}  ▸ line ${c.new_start}${label}  ${C.faint}(${row.lines} lines folded)${notes}`;
        return mark(on) + C.hunkBg + fit(text, w - 1) + RESET;
      }
      case "note":
        return ` ${C.faint}${fit(`   ${row.text}`, w - 1)}${RESET}`;
      case "line": {
        const on = row.chunk === activeChunk;
        if (row.sign === "\\") return mark(on) + C.faint + fit(`            ${row.text}`, w - 1) + RESET;
        const nums = `${num(row.oldNo)} ${num(row.newNo)} `;
        const sel = this.lineSelection(row);
        const lead = sel === "cursor" ? `${C.accent}▶${RESET}` : mark(on);
        const gutterBg = sel === "cursor" ? C.curBg : sel === "range" ? C.selBg : null;
        const code = `${C.text}${this.code(row)}`;
        if (row.sign === "+") {
          return lead + (gutterBg ?? C.addNumBg) + C.add + nums + C.addBg + fit(`+ ${code}`, w - 1 - GUTTER) + RESET;
        }
        if (row.sign === "-") {
          return lead + (gutterBg ?? C.delNumBg) + C.del + nums + C.delBg + fit(`- ${code}`, w - 1 - GUTTER) + RESET;
        }
        return lead + (gutterBg ?? "") + C.faint + nums + RESET + fit(`  ${code}`, w - 1 - GUTTER) + RESET;
      }
      case "comment": {
        const on = this.item !== null && "comment" in this.item && this.item.comment === row.id;
        const lead = on && row.head ? `${C.accent}▶${RESET}` : mark(row.chunk === activeChunk);
        const bar = `${on ? C.accent : C.mod}┃ `;
        const body = row.head ? `${C.mod}${BOLD}comment${RESET}${C.noteBg}  ${C.dim}${row.text}` : `${C.text}${row.text}`;
        return lead + " ".repeat(GUTTER - 2) + C.noteBg + fit(`${bar}${body}`, w - 1 - (GUTTER - 2)) + RESET;
      }
    }
  }

  private draftSummary(): string {
    const all = this.comments.comments;
    if (all.length === 0) return "";
    const known = new Set(this.fingerprints);
    const detached = all.filter((c) => !known.has(c.chunk)).length;
    const extra = detached > 0 ? ` (${detached} on outdated code)` : "";
    return `   ${C.mod}${all.length} draft comment${all.length === 1 ? "" : "s"}${extra}${C.dim} (C list)`;
  }

  private lineSelection(row: LineRow): "cursor" | "range" | null {
    const it = this.item;
    if (it === null || !("line" in it) || it.chunk !== row.chunk) return null;
    if (it.line === row.index) return "cursor";
    if (this.anchor === null) return null;
    const lo = Math.min(this.anchor, it.line);
    const hi = Math.max(this.anchor, it.line);
    return row.index >= lo && row.index <= hi ? "range" : null;
  }

  private renderCommentsSidebar(height: number, w: number): string[] {
    const entries = this.commentEntries();
    const out: string[] = [];
    const label = this.sideFocus ? C.accent : C.text;
    out.push(C.barBg + fit(` ${label}${BOLD}Comments${RESET}${C.barBg} ${C.dim}${entries.length}`, w) + RESET);
    if (entries.length === 0) out.push(fit(` ${C.faint}no draft comments`, w) + RESET);
    const listH = Math.max(1, Math.floor((height - 1) / 2));
    const cur = this.commentCursor;
    if (cur < this.sidebarOffset) this.sidebarOffset = cur;
    if (cur >= this.sidebarOffset + listH) this.sidebarOffset = cur - listH + 1;
    for (let i = this.sidebarOffset; i < entries.length && out.length + 2 <= height; i++) {
      const e = entries[i] as CommentEntry;
      const outdated = e.chunk === null;
      const on = i === cur;
      const base = on ? C.selBg : "";
      const marker = on ? `${this.sideFocus ? C.accent : C.dim}▎` : " ";
      const where = this.entryLabel(e);
      const path = tailPath(e.comment.path, Math.max(4, w - 3 - visibleWidth(where)));
      const pathStyle = outdated ? C.faint : on ? `${C.text}${BOLD}` : C.text;
      const whereStyle = outdated ? C.del : C.dim;
      out.push(base + fit(`${marker}${pathStyle}${path}${RESET}${base} ${whereStyle}${where}`, w) + RESET);
      const first = e.comment.text.split("\n")[0] ?? "";
      out.push(base + fit(`${marker} ${outdated ? C.faint : C.mod}${first}`, w) + RESET);
    }
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  private renderSidebar(height: number, w: number): string[] {
    if (this.sideMode === "comments") return this.renderCommentsSidebar(height, w);
    const files = this.packet.files;
    const out: string[] = [];
    const label = this.sideFocus ? C.accent : C.text;
    out.push(C.barBg + fit(` ${label}${BOLD}Files${RESET}${C.barBg} ${C.dim}${files.length}`, w) + RESET);
    const listH = height - 1;
    const cur = this.sideFocus ? this.fileCursor : this.current().file;
    if (cur < this.sidebarOffset) this.sidebarOffset = cur;
    if (cur >= this.sidebarOffset + listH) this.sidebarOffset = cur - listH + 1;
    for (let i = this.sidebarOffset; i < files.length && out.length < height; i++) {
      const f = files[i] as PacketFile;
      const on = i === cur;
      const counts = f.binary ? "bin" : `+${f.additions} -${f.deletions}`;
      const pathW = Math.max(4, w - 5 - counts.length);
      const path = tailPath(f.path, pathW);
      const pad = " ".repeat(Math.max(1, w - 4 - visibleWidth(path) - counts.length));
      const base = on ? C.selBg : "";
      const marker = on ? `${C.accent}▎` : " ";
      const pathStyle = on ? `${C.text}${BOLD}` : this.fileFolded(i) ? C.faint : C.text;
      const line = `${marker}${statusLetter(f)} ${pathStyle}${path}${RESET}${base}${pad}${C.dim}${counts}`;
      out.push(base + fit(line, w) + RESET);
    }
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const p = this.packet;
    const adds = p.files.reduce((n, f) => n + f.additions, 0);
    const dels = p.files.reduce((n, f) => n + f.deletions, 0);

    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}${this.opts.title}`, width) + RESET);
    const warn = this.opts.headMatches ? "" : `   ${C.mod}worktree HEAD differs from reviewed head`;
    const meta = ` ${C.dim}${this.opts.subtitle}   ${C.text}${p.files.length} files  ${C.add}+${adds} ${C.del}-${dels}${this.draftSummary()}${warn}`;
    out.push(C.barBg + fit(meta, width) + RESET);

    const sideW = this.sidebar && width >= 80 ? Math.min(48, Math.max(26, Math.floor(width * 0.28))) : 0;
    const diffW = sideW > 0 ? width - sideW - 1 : width;
    if (diffW !== this.wrapW) {
      this.wrapW = diffW;
      this.rebuild();
    }
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - bodyH)));
    const side = sideW > 0 ? this.renderSidebar(bodyH, sideW) : [];
    for (let r = 0; r < bodyH; r++) {
      const row = this.rows[this.offset + r];
      const diff = row === undefined ? "" : this.renderRow(row, diffW);
      const diffCell = fit(diff, diffW);
      out.push(sideW > 0 ? `${side[r] ?? ""}${C.faint}│${RESET}${diffCell}` : diffCell);
    }

    const cur = this.current();
    const pos = `file ${cur.file + 1}/${p.files.length}  stop ${this.cursor + 1}/${this.stops.length} `;
    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const keys = this.sideFocus && this.sideMode === "comments"
      ? ` ${k("j/k", "comment")}${k("enter", "jump")}${k("e/d", "edit/delete")}${k("S", "submit all")}${k("C", "files")}${k("tab/esc", "back to diff")}`
      : this.sideFocus
      ? ` ${C.text}j/k${C.dim} file  ${C.text}enter${C.dim} jump  ${C.text}C${C.dim} comments  ${C.text}tab/esc${C.dim} back to diff`
      : this.item !== null
      ? ` ${k("j/k", "line")}${k("V", this.anchor === null ? "range" : "end range")}${k("c", "comment")}${k("e/d", "edit/delete")}${k("o", "open")}${k("esc", this.anchor === null ? "chunks" : "clear range")}`
      : ` ${C.text}j/k${C.dim} chunk  ${C.text}enter${C.dim} lines  ${C.text}c${C.dim} comment  ${C.text}C${C.dim} comments  ${C.text}n/p${C.dim} file  ${C.text}space${C.dim} fold  ${C.text}f${C.dim} fold file  ${C.text}tab${C.dim} files  ${C.text}t${C.dim} hide  ${C.text}e${C.dim} open  ${C.text}q${C.dim} ${this.opts.quitLabel ?? "quit"}`;
    const gap = Math.max(1, width - visibleWidth(keys) - pos.length);
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${C.dim}${pos}`, width) + RESET);
    return out;
  }
}
