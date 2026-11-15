import { type Component } from "@earendil-works/pi-tui";
import type { Packet, PacketChunk, PacketState } from "./packet.js";
import { colorHunkLine, plainHunkLine } from "./render.js";

interface DocLine {
  text: string;
  chunkId: string | null;
}

export interface ChunkNavOptions {
  packet: Packet;
  state: PacketState;
  headMatches: boolean;
  onQuit: () => void;
  onPersist: (state: PacketState) => void;
  onOpen: (chunk: PacketChunk) => void;
}

export class ChunkNavView implements Component {
  private readonly packet: Packet;
  private state: PacketState;
  private readonly headMatches: boolean;
  private readonly onQuit: () => void;
  private readonly onPersist: (state: PacketState) => void;
  private readonly onOpen: (chunk: PacketChunk) => void;

  private order: string[] = [];
  private offset = 0;
  private doc: DocLine[] = [];
  private chunkFirstLine: Record<string, number> = {};

  constructor(opts: ChunkNavOptions) {
    this.packet = opts.packet;
    this.state = opts.state;
    this.headMatches = opts.headMatches;
    this.onQuit = opts.onQuit;
    this.onPersist = opts.onPersist;
    this.onOpen = opts.onOpen;
    this.rebuild();
    const cursor = this.state.cursor.chunk_id;
    this.select(cursor !== null && this.order.includes(cursor) ? cursor : this.order[0] ?? "");
  }

  invalidate(): void {
    this.rebuild();
  }

  private chunk(id: string): PacketChunk | undefined {
    return this.packet.chunks.find((c) => c.id === id);
  }

  private selectedId(): string {
    return this.order[this.selectedIndex()] ?? "";
  }

  private selectedIndex(): number {
    const id = this.state.cursor.chunk_id;
    if (id === null) return 0;
    const i = this.order.indexOf(id);
    return i === -1 ? 0 : i;
  }

  private rebuild(): void {
    this.order = [];
    for (const g of this.packet.groups) {
      for (const cid of g.chunks) {
        if (this.chunk(cid) !== undefined) this.order.push(cid);
      }
    }
    this.buildDoc();
  }

  private buildDoc(): void {
    const selected = this.selectedId();
    this.doc = [];
    this.chunkFirstLine = {};
    for (const g of this.packet.groups) {
      this.doc.push({ text: `\x1b[1m${g.intent}\x1b[0m`, chunkId: null });
      for (const cid of g.chunks) {
        const c = this.chunk(cid);
        if (c === undefined) continue;
        this.chunkFirstLine[cid] = this.doc.length;
        const read = this.state.read[cid] !== undefined;
        const isSel = cid === selected;
        const bar = `── ${cid} ${c.section !== "" ? `@ ${c.section} ` : ""}L${c.new_start} +${c.new_lines} -${c.old_lines} ──`;
        const barStyled = isSel ? `\x1b[7m${bar}\x1b[0m` : read ? `\x1b[2m${bar}\x1b[0m` : bar;
        this.doc.push({ text: barStyled, chunkId: cid });
        if (read) continue;
        for (const line of c.patch.split("\n").slice(1)) {
          this.doc.push({ text: colorHunkLine(plainHunkLine(line), isSel), chunkId: cid });
        }
      }
    }
  }

  private select(id: string): void {
    this.state.cursor.chunk_id = id;
    this.buildDoc();
    const first = this.chunkFirstLine[id];
    if (first !== undefined && first < this.offset) this.offset = first;
  }

  private move(delta: number): void {
    const next = Math.min(Math.max(this.selectedIndex() + delta, 0), this.order.length - 1);
    this.select(this.order[next] ?? "");
  }

  private toggleRead(): void {
    const id = this.selectedId();
    if (id === "") return;
    if (this.state.read[id] !== undefined) delete this.state.read[id];
    else this.state.read[id] = { at: Math.floor(Date.now() / 1000) };
    this.state.updated_at = Math.floor(Date.now() / 1000);
    this.onPersist(this.state);
    this.buildDoc();
    const first = this.chunkFirstLine[id];
    if (first !== undefined && first < this.offset) this.offset = first;
  }

  private clampOffset(height: number): void {
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.doc.length - height)));
  }

  render(width: number): string[] {
    const rows = Math.max(10, (process.stdout.rows ?? 40) - 2);
    const headerHeight = 2;
    const height = rows - headerHeight;
    this.clampOffset(height);
    const p = this.packet;
    const readCount = this.order.filter((id) => this.state.read[id] !== undefined).length;
    const sel = this.chunk(this.selectedId());
    const where =
      sel !== undefined
        ? `${sel.id} ${this.packet.files.find((f) => f.id === sel.file_id)?.path ?? ""} ${sel.section}`
        : "";
    const sticky2 = `read ${readCount}/${this.order.length}  chunk ${this.selectedIndex() + 1}/${this.order.length}  ${where}`.slice(0, width - 1);
    const headWarn = this.headMatches ? "" : "  \x1b[33m[HEAD != packet head]\x1b[0m";
    const line1 = `${p.briefing.title}${headWarn}`.slice(0, width - 1);
    const line2 = `${p.repo_path} ${p.branch} ${p.base_sha.slice(0, 7)}..${p.head_sha.slice(0, 7)}  ${sticky2}`;
    const out = [line1, line2.slice(0, width - 1)];
    const slice = this.doc.slice(this.offset, this.offset + height);
    for (const l of slice) out.push(l.text.length > width ? l.text.slice(0, width) : l.text);
    return out;
  }

  handleInput(data: string): void {
    switch (data) {
      case "q":
      case "\x03":
        this.onQuit();
        return;
      case "j":
      case "\x1b[B":
        this.move(1);
        return;
      case "k":
      case "\x1b[A":
        this.move(-1);
        return;
      case "g":
        this.offset = 0;
        return;
      case "G":
        this.offset = this.doc.length;
        return;
      case "J":
      case "\x1b[6~":
        this.offset += 10;
        return;
      case "K":
      case "\x1b[5~":
        this.offset -= 10;
        return;
      case "r":
        this.toggleRead();
        return;
      case "o": {
        const sel = this.chunk(this.selectedId());
        if (sel !== undefined) this.onOpen(sel);
        return;
      }
      default:
        return;
    }
  }
}
