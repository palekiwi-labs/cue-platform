import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET, tailPath } from "./changes.js";
import type { RoundComment } from "./round.js";

export type DraftTab = "changes" | "walkthrough";

/** One draft comment as listed in the comments pane. */
export interface PaneEntry {
  tab: DraftTab;
  id: string;
  title: string;
  where: string;
  text: string;
  outdated: boolean;
}

/** The drafts one tab owns: listed, edited, removed and submitted through the hub. */
export interface DraftGroup {
  entries(): PaneEntry[];
  edit(id: string): void;
  remove(ids: string[]): void;
  round(): { id: string; comment: RoundComment }[];
}

const GROUPS: { tab: DraftTab; label: string }[] = [
  { tab: "changes", label: "Changes" },
  { tab: "walkthrough", label: "Walkthrough" },
];

/** Draft comments of one review across its tabs, submitted together as one round. */
export class Drafts {
  private readonly groups = new Map<DraftTab, DraftGroup>();

  constructor(private readonly onSubmit: (comments: RoundComment[], done: (ok: boolean) => void) => void) {}

  register(tab: DraftTab, group: DraftGroup): void {
    this.groups.set(tab, group);
  }

  entries(tab?: DraftTab): PaneEntry[] {
    return GROUPS.flatMap((g) => (tab === undefined || g.tab === tab ? (this.groups.get(g.tab)?.entries() ?? []) : []));
  }

  edit(e: PaneEntry): void {
    this.groups.get(e.tab)?.edit(e.id);
  }

  remove(e: PaneEntry): void {
    this.groups.get(e.tab)?.remove([e.id]);
  }

  submit(): void {
    const parts = GROUPS.flatMap((g) => {
      const group = this.groups.get(g.tab);
      return group === undefined ? [] : [{ group, items: group.round() }];
    });
    const comments = parts.flatMap((p) => p.items.map((i) => i.comment));
    if (comments.length === 0) return;
    this.onSubmit(comments, (ok) => {
      if (!ok) return;
      for (const p of parts) p.group.remove(p.items.map((i) => i.id));
    });
  }
}

export type PaneAction = { jump: PaneEntry } | { hint: string } | null;

/** The comments pane of one tab: lists every draft grouped per tab. */
export class CommentsPane {
  private cursor = 0;
  private offset = 0;

  constructor(
    private readonly drafts: Drafts,
    private readonly tab: DraftTab,
  ) {}

  select(id: string | null): void {
    const entries = this.drafts.entries();
    const at = id === null ? -1 : entries.findIndex((e) => e.tab === this.tab && e.id === id);
    if (at !== -1) this.cursor = at;
    this.cursor = Math.max(0, Math.min(this.cursor, entries.length - 1));
  }

  /** Handles pane keys; returns null for keys the pane does not own. */
  handleInput(data: string): PaneAction | "handled" {
    const entries = this.drafts.entries();
    const n = entries.length;
    const e = entries[this.cursor];
    switch (data) {
      case "j":
      case "\x1b[B":
        this.cursor = Math.max(0, Math.min(n - 1, this.cursor + 1));
        return "handled";
      case "k":
      case "\x1b[A":
        this.cursor = Math.max(0, this.cursor - 1);
        return "handled";
      case "g":
        this.cursor = 0;
        return "handled";
      case "G":
        this.cursor = Math.max(0, n - 1);
        return "handled";
      case "\r":
      case "l":
        if (e === undefined) return "handled";
        if (e.tab === this.tab) return { jump: e };
        return { hint: `open the ${e.tab} tab to jump to this comment` };
      case "E":
        if (e !== undefined) this.drafts.edit(e);
        return "handled";
      case "d":
        if (e === undefined) return "handled";
        this.drafts.remove(e);
        this.cursor = Math.max(0, Math.min(this.cursor, n - 2));
        return "handled";
      case "S":
        this.drafts.submit();
        return "handled";
      default:
        return null;
    }
  }

  render(height: number, w: number, focused: boolean): string[] {
    const entries = this.drafts.entries();
    this.cursor = Math.max(0, Math.min(this.cursor, entries.length - 1));
    const head = C.barBg + fit(` ${focused ? C.accent : C.text}${BOLD}Comments${RESET}${C.barBg} ${C.dim}${entries.length}`, w) + RESET;
    const lines: { text: string; entry: number | null }[] = [];
    if (entries.length === 0) lines.push({ text: fit(` ${C.faint}no draft comments`, w) + RESET, entry: null });
    for (const g of GROUPS) {
      const count = entries.filter((e) => e.tab === g.tab).length;
      if (count === 0) continue;
      lines.push({ text: fit(` ${C.dim}${BOLD}${g.label}${RESET} ${C.faint}${count}`, w) + RESET, entry: null });
      entries.forEach((e, i) => {
        if (e.tab !== g.tab) return;
        const on = i === this.cursor;
        const base = on ? C.selBg : "";
        const marker = on ? `${focused ? C.accent : C.dim}▎` : " ";
        const where = e.outdated ? "outdated" : e.where;
        const room = Math.max(4, w - 3 - visibleWidth(where));
        const title = e.tab === "changes" ? tailPath(e.title, room) : truncateToWidth(e.title, room, "…");
        const titleStyle = e.outdated ? C.faint : on ? `${C.text}${BOLD}` : C.text;
        const whereStyle = e.outdated ? C.del : C.dim;
        lines.push({ text: base + fit(`${marker}${titleStyle}${title}${RESET}${base} ${whereStyle}${where}`, w) + RESET, entry: i });
        const first = e.text.split("\n")[0] ?? "";
        lines.push({ text: base + fit(`${marker} ${e.outdated ? C.faint : C.mod}${first}`, w) + RESET, entry: i });
      });
    }
    const listH = Math.max(1, height - 1);
    const first = lines.findIndex((l) => l.entry === this.cursor);
    if (first !== -1) {
      const top = lines[first - 1]?.entry === null ? first - 1 : first;
      if (top < this.offset) this.offset = top;
      if (first + 2 > this.offset + listH) this.offset = first + 2 - listH;
    }
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, lines.length - listH)));
    const out = [head, ...lines.slice(this.offset, this.offset + listH).map((l) => l.text)];
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }
}
