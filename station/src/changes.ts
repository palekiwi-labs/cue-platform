import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Packet, PacketChunk, PacketFile } from "./packet.js";
import { chunkFingerprint, type FoldState } from "./state.js";

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
};

type Row =
  | { kind: "file"; file: number }
  | { kind: "hunk"; chunk: number }
  | { kind: "folded"; chunk: number; lines: number }
  | { kind: "line"; chunk: number; sign: string; oldNo: number | null; newNo: number | null; text: string }
  | { kind: "note"; file: number; text: string }
  | { kind: "blank" };

interface Stop {
  file: number;
  chunk: number | null;
}

export interface ChangesOptions {
  title: string;
  subtitle: string;
  packet: Packet;
  folds: FoldState;
  headMatches: boolean;
  onQuit: () => void;
  quitLabel?: string;
  onFolds: (folds: FoldState) => void;
  onOpen: (file: PacketFile, line: number) => void;
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
  private folds: FoldState;
  private rows: Row[] = [];
  private rowOfStop: number[] = [];
  private stops: Stop[] = [];
  private cursor = 0;
  private offset = 0;
  private sidebarOffset = 0;
  private sidebar = true;
  private filesFocus = false;
  private fileCursor = 0;
  private lastHeight = 20;

  constructor(opts: ChangesOptions) {
    this.opts = opts;
    this.packet = opts.packet;
    this.folds = opts.folds;
    const fileIndex = new Map(this.packet.files.map((f, i) => [f.id, i]));
    this.fileChunks = this.packet.files.map(() => []);
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
  }

  private pushChunk(ci: number): void {
    const c = this.chunk(ci);
    const body = c.patch.split("\n").slice(1);
    if (this.chunkFolded(ci)) {
      this.rows.push({ kind: "folded", chunk: ci, lines: body.length });
      return;
    }
    this.rows.push({ kind: "hunk", chunk: ci });
    let oldNo = c.old_start;
    let newNo = c.new_start;
    for (const raw of body) {
      const sign = raw.slice(0, 1);
      const text = raw.slice(1).replace(/\t/g, "    ");
      if (sign === "+") {
        this.rows.push({ kind: "line", chunk: ci, sign, oldNo: null, newNo: newNo++, text });
      } else if (sign === "-") {
        this.rows.push({ kind: "line", chunk: ci, sign, oldNo: oldNo++, newNo: null, text });
      } else if (sign === "\\") {
        this.rows.push({ kind: "line", chunk: ci, sign, oldNo: null, newNo: null, text: raw });
      } else {
        this.rows.push({ kind: "line", chunk: ci, sign: " ", oldNo: oldNo++, newNo: newNo++, text });
      }
    }
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
    if (!this.filesFocus) return false;
    this.filesFocus = false;
    return true;
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
        this.filesFocus = false;
        return;
      case "\t":
        this.filesFocus = false;
        return;
      case "t":
        this.filesFocus = false;
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
    if (this.filesFocus) {
      this.handleFilesInput(data);
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
        this.filesFocus = true;
        this.fileCursor = this.current().file;
        return;
      case "o":
      case "\r":
        this.open();
        return;
      default:
        return;
    }
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
        const text = `${C.dim}  ▸ line ${c.new_start}${label}  ${C.faint}(${row.lines} lines folded)`;
        return mark(on) + C.hunkBg + fit(text, w - 1) + RESET;
      }
      case "note":
        return ` ${C.faint}${fit(`   ${row.text}`, w - 1)}${RESET}`;
      case "line": {
        const on = row.chunk === activeChunk;
        if (row.sign === "\\") return mark(on) + C.faint + fit(`            ${row.text}`, w - 1) + RESET;
        const nums = `${num(row.oldNo)} ${num(row.newNo)} `;
        if (row.sign === "+") {
          return mark(on) + C.addNumBg + C.add + nums + C.addBg + fit(`+ ${C.text}${row.text}`, w - 1 - 12) + RESET;
        }
        if (row.sign === "-") {
          return mark(on) + C.delNumBg + C.del + nums + C.delBg + fit(`- ${C.text}${row.text}`, w - 1 - 12) + RESET;
        }
        return mark(on) + C.faint + nums + C.text + fit(`  ${row.text}`, w - 1 - 12) + RESET;
      }
    }
  }

  private renderSidebar(height: number, w: number): string[] {
    const files = this.packet.files;
    const out: string[] = [];
    const label = this.filesFocus ? C.accent : C.text;
    out.push(C.barBg + fit(` ${label}${BOLD}Files${RESET}${C.barBg} ${C.dim}${files.length}`, w) + RESET);
    const listH = height - 1;
    const cur = this.filesFocus ? this.fileCursor : this.current().file;
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
    const meta = ` ${C.dim}${this.opts.subtitle}   ${C.text}${p.files.length} files  ${C.add}+${adds} ${C.del}-${dels}${warn}`;
    out.push(C.barBg + fit(meta, width) + RESET);

    const sideW = this.sidebar && width >= 80 ? Math.min(48, Math.max(26, Math.floor(width * 0.28))) : 0;
    const diffW = sideW > 0 ? width - sideW - 1 : width;
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
    const keys = this.filesFocus
      ? ` ${C.text}j/k${C.dim} file  ${C.text}enter${C.dim} jump  ${C.text}tab/esc${C.dim} back to diff`
      : ` ${C.text}j/k${C.dim} chunk  ${C.text}n/p${C.dim} file  ${C.text}space${C.dim} fold  ${C.text}f${C.dim} fold file  ${C.text}tab${C.dim} files  ${C.text}t${C.dim} hide  ${C.text}o${C.dim} open  ${C.text}q${C.dim} ${this.opts.quitLabel ?? "quit"}`;
    const gap = Math.max(1, width - visibleWidth(keys) - pos.length);
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${C.dim}${pos}`, width) + RESET);
    return out;
  }
}
