import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import { localGit, parseHunk, requiredCommits, resolveThread, type Located } from "./feedback-location.js";
import { runAsync } from "./git.js";
import {
  type ConversationEntry,
  feedbackCachePath,
  type FeedbackSnapshot,
  fetchFeedback,
  ghGraphql,
  loadSnapshot,
  type ReviewThread,
  saveSnapshot,
} from "./github-feedback.js";
import { markdownRows } from "./markdown.js";
import { findingsWorktree, prContext } from "./pr-review.js";
import type { PrTabHost } from "./pr-tabs.js";
import { NoticeView, type TabScreen } from "./tabs.js";

const PROSE_WIDTH = 80;
const HUNK_TAIL = 12;

export type FeedbackItem = { kind: "thread"; thread: ReviewThread } | { kind: "entry"; entry: ConversationEntry };

export function feedbackItems(s: FeedbackSnapshot): FeedbackItem[] {
  return [
    ...s.threads.map((thread) => ({ kind: "thread" as const, thread })),
    ...s.conversation.map((entry) => ({ kind: "entry" as const, entry })),
  ];
}

function itemId(item: FeedbackItem): string {
  return item.kind === "thread" ? item.thread.id : item.entry.id;
}

export function when(iso: string | null): string {
  if (iso === null || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function login(a: { login: string | null }): string {
  return a.login ?? "ghost";
}

function threadLine(t: ReviewThread): number | null {
  return t.line ?? t.original_line;
}

export function threadLocation(t: ReviewThread): string {
  if (t.subject_type === "FILE") return `${t.path} (file)`;
  const end = threadLine(t);
  if (end === null) return t.path;
  const start = t.line !== null ? t.start_line : t.original_start_line;
  return start !== null && start !== end ? `${t.path}:${start}-${end}` : `${t.path}:${end}`;
}

function threadTags(t: ReviewThread): string[] {
  const tags: string[] = [];
  if (t.is_resolved) tags.push("resolved");
  if (t.is_outdated) tags.push("outdated");
  if (t.diff_side === "LEFT") tags.push("old side");
  return tags;
}

function firstLine(body: string): string {
  return body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

export interface FeedbackViewOptions {
  snapshot: FeedbackSnapshot;
  onQuit: () => void;
  onOpen: (thread: ReviewThread) => void;
  onGeneral: () => void;
  prHead?: string;
}

export class FeedbackView implements Component {
  private cursor = 0;
  private offset = 0;
  private listOffset = 0;
  private lastHeight = 20;
  private readonly items: FeedbackItem[];
  note = "";

  constructor(private readonly opts: FeedbackViewOptions) {
    this.items = feedbackItems(opts.snapshot);
  }

  invalidate(): void {}

  get snapshot(): FeedbackSnapshot {
    return this.opts.snapshot;
  }

  current(): FeedbackItem | undefined {
    return this.items[this.cursor];
  }

  restorePosition(previous: FeedbackView): void {
    const prev = previous.current();
    const index = prev === undefined ? -1 : this.items.findIndex((i) => itemId(i) === itemId(prev));
    this.cursor = index >= 0 ? index : Math.max(0, Math.min(previous.cursor, this.items.length - 1));
    if (index >= 0) this.offset = previous.offset;
    this.listOffset = previous.listOffset;
  }

  private move(delta: number): void {
    const n = this.items.length;
    if (n === 0) return;
    this.cursor = (this.cursor + delta + n) % n;
    this.offset = 0;
  }

  handleInput(data: string): void {
    const h = this.lastHeight;
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.offset += Math.floor(h / 2);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.offset -= Math.floor(h / 2);
    else if (matchesKey(data, "shift+down")) this.offset += 3;
    else if (matchesKey(data, "shift+up")) this.offset -= 3;
    else {
      switch (data) {
        case "q":
        case "\x03":
          this.opts.onQuit();
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
          this.cursor = 0;
          this.offset = 0;
          return;
        case "G":
          this.cursor = Math.max(0, this.items.length - 1);
          this.offset = 0;
          return;
        case "J":
          this.offset += 3;
          return;
        case "K":
          this.offset -= 3;
          return;
        case " ":
          this.offset += Math.floor(h / 2);
          return;
        case "e": {
          const item = this.current();
          if (item?.kind === "thread") this.opts.onOpen(item.thread);
          else if (item !== undefined) this.opts.onGeneral();
          return;
        }
        default:
          return;
      }
    }
  }

  private section(title: string): string[] {
    return ["", `${C.accent}${BOLD}${title}${RESET}`, ""];
  }

  private body(text: string, w: number): string[] {
    const rows = markdownRows(text, Math.min(w, PROSE_WIDTH));
    return rows.length === 0 ? [`${C.faint}(no text)`] : rows;
  }

  private hunkRows(t: ReviewThread, w: number): string[] {
    const hunk = t.comments[0]?.diff_hunk ?? null;
    const out = this.section("Captured diff");
    if (hunk === null || hunk === "") return [...out, `${C.faint}no diff captured for this thread`];
    const lines = parseHunk(hunk);
    if (lines === null) return [...out, ...hunk.split("\n").map((l) => `${C.dim}${l}`)];
    const left = t.diff_side === "LEFT";
    const end = t.original_line;
    const start = t.original_start_line ?? end;
    const shown = lines.slice(-HUNK_TAIL);
    if (lines.length > shown.length) out.push(`${C.faint}  … ${lines.length - shown.length} earlier lines`);
    for (const l of shown) {
      const n = left ? l.old : l.new;
      const on = n !== null && start !== null && end !== null && n >= Math.min(start, end) && n <= Math.max(start, end);
      const color = l.kind === "+" ? C.add : l.kind === "-" ? C.del : C.text;
      const bg = on ? C.selBg : l.kind === "+" ? C.addBg : l.kind === "-" ? C.delBg : "";
      const num = (v: number | null): string => (v === null ? "     " : String(v).padStart(5));
      const gutter = `${on ? C.accent : C.faint}${num(l.old)} ${num(l.new)} ${on ? "▎" : " "}`;
      out.push(gutter + RESET + bg + fit(`${color}${l.kind}${l.text.replace(/\t/g, "    ")}`, w - 14) + RESET);
    }
    return out;
  }

  private threadRows(t: ReviewThread, w: number): string[] {
    const out = wrapTextWithAnsi(`${C.text}${BOLD}${threadLocation(t)}`, Math.min(w, PROSE_WIDTH));
    out.push("");
    const tag = (label: string, value: string, color = C.text): string => `${C.dim}${label} ${color}${value}${RESET}   `;
    const sideName = t.diff_side === "LEFT" ? "old (base)" : t.diff_side === "RIGHT" ? "new (head)" : "unknown";
    out.push(
      tag("side", sideName, t.diff_side === "LEFT" ? C.del : C.add) +
        tag("state", t.is_resolved ? `resolved${t.resolved_by === null ? "" : ` by ${t.resolved_by}`}` : "unresolved", t.is_resolved ? C.dim : C.mod) +
        (t.is_outdated ? tag("", "outdated", C.mod) : "") +
        (t.subject_type === "FILE" ? tag("", "file comment") : ""),
    );
    const origin = t.comments[0]?.original_commit ?? null;
    const lines = [
      t.line === null ? null : `line ${t.line} at PR head`,
      t.original_line === null ? null : `line ${t.original_line} at ${origin === null ? "original commit" : origin.slice(0, 10)}`,
    ].filter((x) => x !== null);
    if (lines.length > 0) out.push(`${C.dim}${lines.join("   ")}`);
    if (t.comments_total > t.comments.length) out.push(`${C.mod}showing ${t.comments.length} of ${t.comments_total} comments`);
    out.push(...this.hunkRows(t, w));
    out.push(...this.section(`Conversation (${t.comments.length})`));
    t.comments.forEach((c, i) => {
      if (i > 0) out.push(`${C.faint}${"─".repeat(Math.min(w, PROSE_WIDTH))}`);
      const extra = [
        c.last_edited_at !== null ? "edited" : null,
        c.state === "PENDING" ? "pending" : null,
        c.is_minimized ? `hidden${c.minimized_reason === null ? "" : `: ${c.minimized_reason.toLowerCase()}`}` : null,
      ].filter((x) => x !== null);
      out.push(`${C.accent}${login(c.author)}${C.dim}  ${when(c.created_at)}${extra.length > 0 ? `  ${extra.join("  ")}` : ""}`);
      out.push(...this.body(c.body, w));
      out.push("");
    });
    const url = t.comments[0]?.url;
    if (url != null) out.push(`${C.faint}${url}`);
    return out;
  }

  private entryRows(e: ConversationEntry, w: number): string[] {
    const head = e.kind === "review" ? `review ${e.state?.toLowerCase().replace("_", " ") ?? ""}` : "comment";
    const out = wrapTextWithAnsi(`${C.text}${BOLD}${head}`, Math.min(w, PROSE_WIDTH));
    out.push("");
    const extra = [
      e.last_edited_at !== null ? "edited" : null,
      e.commit === null ? null : `at ${e.commit.slice(0, 10)}`,
      e.is_minimized ? `hidden${e.minimized_reason === null ? "" : `: ${e.minimized_reason.toLowerCase()}`}` : null,
    ].filter((x) => x !== null);
    out.push(`${C.accent}${login(e.author)}${C.dim}  ${when(e.created_at)}${extra.length > 0 ? `  ${extra.join("  ")}` : ""}`);
    out.push("");
    out.push(...this.body(e.body, w));
    out.push("");
    if (e.url !== null) out.push(`${C.faint}${e.url}`);
    out.push(`${C.faint}general comment: no code location to open`);
    return out;
  }

  private renderList(height: number, w: number): string[] {
    const s = this.opts.snapshot;
    type Row = { text: string; item: number | null };
    const rows: Row[] = [];
    const header = (label: string, count: number): void => {
      rows.push({ text: C.barBg + fit(` ${C.text}${BOLD}${label}${RESET}${C.barBg} ${C.dim}${count}`, w) + RESET, item: null });
    };
    const entry = (i: number, label: string, sub: string, dim: boolean): void => {
      const on = i === this.cursor;
      const base = on ? C.selBg : "";
      const marker = on ? `${C.accent}▎` : " ";
      rows.push({ text: base + fit(`${marker}${dim ? C.faint : on ? `${C.text}${BOLD}` : C.text}${label}`, w) + RESET, item: i });
      rows.push({ text: base + fit(`${marker}${sub}`, w) + RESET, item: i });
      rows.push({ text: " ".repeat(w), item: i });
    };
    header("Code threads", s.threads.length);
    if (s.threads.length === 0) rows.push({ text: ` ${C.faint}no review threads`, item: null });
    this.items.forEach((item, i) => {
      if (item.kind !== "thread") return;
      const t = item.thread;
      const first = t.comments[0];
      const tags = threadTags(t);
      const tagText = tags.length === 0 ? "" : `${C.mod}${tags.join(" ")}  `;
      const sub = `${tagText}${C.dim}${first === undefined ? "" : login(first.author)} · ${t.comments.length}  ${firstLine(first?.body ?? "")}`;
      entry(i, threadLocation(t), sub, t.is_resolved);
    });
    header("Conversation", s.conversation.length);
    if (s.conversation.length === 0) rows.push({ text: ` ${C.faint}no general comments`, item: null });
    this.items.forEach((item, i) => {
      if (item.kind !== "entry") return;
      const e = item.entry;
      const kind = e.kind === "review" ? `review ${e.state?.toLowerCase().replace("_", " ") ?? ""}` : "comment";
      entry(i, `${login(e.author)}  ${C.dim}${kind}`, `${C.dim}${when(e.created_at)}  ${firstLine(e.body)}`, e.is_minimized);
    });
    const first = rows.findIndex((r) => r.item === this.cursor);
    if (first >= 0) {
      const top = rows[first - 1]?.item === null ? first - 1 : first;
      if (top < this.listOffset) this.listOffset = top;
      if (first + 3 > this.listOffset + height) this.listOffset = first + 3 - height;
    }
    this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, rows.length - height)));
    const out = rows.slice(this.listOffset, this.listOffset + height).map((r) => r.text);
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const s = this.opts.snapshot;
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}github  #${s.pr.number}  ${s.pr.title}`, width) + RESET);
    const unresolved = s.threads.filter((t) => !t.is_resolved).length;
    const moved = this.opts.prHead !== undefined && this.opts.prHead !== s.pr.head_sha
      ? `   ${C.mod}PR head in station is ${this.opts.prHead.slice(0, 10)}` : "";
    const note = this.note === "" ? "" : `   ${C.mod}${this.note}`;
    out.push(
      C.barBg +
        fit(
          ` ${C.dim}fetched ${C.text}${when(s.fetched_at)}${C.dim}   head ${C.text}${s.pr.head_sha.slice(0, 10)}${C.dim}   ` +
            `${s.threads.length} threads (${unresolved} unresolved)   ${s.conversation.length} conversation${moved}${note}`,
          width,
        ) +
        RESET,
    );
    const sideW = Math.min(56, Math.max(28, Math.floor(width * 0.34)));
    const mainW = width - sideW - 1;
    const pad = 2;
    const item = this.current();
    const rows =
      item === undefined
        ? ["", `${C.faint}no review threads or general comments on this pull request`]
        : item.kind === "thread"
          ? this.threadRows(item.thread, mainW - pad)
          : this.entryRows(item.entry, mainW - pad);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - bodyH)));
    const side = this.renderList(bodyH, sideW);
    for (let i = 0; i < bodyH; i++) {
      const row = rows[this.offset + i] ?? "";
      out.push(`${fit(" ".repeat(pad) + truncateToWidth(row, mainW - pad, ""), mainW)}${RESET}${C.faint}│${RESET}${side[i] ?? ""}`);
    }
    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const keys = ` ${k("R", "fetch")}${k("↑/↓", "item")}${k("shift-↑/↓ pgup/pgdn", "scroll")}${k("e", "open")}${k("q", "quit")}`;
    const more = this.offset + bodyH < rows.length ? `${C.accent}more ↓  ` : "";
    const pos = this.items.length === 0 ? "" : `item ${this.cursor + 1}/${this.items.length} `;
    const right = `${more}${C.dim}${pos}`;
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(right));
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}

export interface FeedbackTabDeps {
  load: () => FeedbackSnapshot | null;
  fetch: () => Promise<FeedbackSnapshot>;
  save: (snapshot: FeedbackSnapshot) => void;
  fetchCommits: (shas: string[]) => Promise<void>;
}

export function defaultFeedbackDeps(host: PrTabHost): FeedbackTabDeps {
  const path = feedbackCachePath(host.repoSlug, host.pr);
  return {
    load: () => loadSnapshot(path),
    fetch: () => fetchFeedback(ghGraphql(host.repo), host.repoSlug, host.pr),
    save: (s) => saveSnapshot(path, s),
    fetchCommits: async (shas) => {
      await runAsync(host.repo, ["fetch", "-q", "--no-tags", "origin", ...shas]);
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The github tab of a PR: shows the saved feedback snapshot and fetches from
 * GitHub only on R. Opening a thread resolves its revision and side-specific
 * line first and refuses locations it cannot verify.
 */
export class FeedbackTab implements TabScreen {
  private view: FeedbackView | null = null;
  private state: { kind: "none" } | { kind: "fetching" } | { kind: "error"; text: string } = { kind: "none" };
  private opening = false;

  constructor(
    private readonly host: PrTabHost,
    private readonly deps: FeedbackTabDeps = defaultFeedbackDeps(host),
  ) {
    try {
      const snapshot = deps.load();
      if (snapshot !== null) this.use(snapshot);
    } catch (e) {
      this.state = { kind: "error", text: `saved snapshot unreadable: ${errText(e)}` };
    }
  }

  private use(snapshot: FeedbackSnapshot): void {
    if (snapshot.pr.number !== this.host.pr) throw new Error(`snapshot is for #${snapshot.pr.number}, not #${this.host.pr}`);
    const next = new FeedbackView({
      snapshot,
      onQuit: this.host.onQuit,
      onOpen: (t) => void this.open(t, snapshot),
      onGeneral: () =>
        this.host.showPopup({ title: "open", text: "general PR comments have no code location to open", footer: "any key" }, true),
      prHead: this.host.prHead,
    });
    if (this.view !== null) next.restorePosition(this.view);
    this.view = next;
  }

  private notice(): TabScreen {
    const n = this.host.pr;
    const body =
      this.state.kind === "fetching"
        ? ["fetching review threads and comments from GitHub…"]
        : this.state.kind === "error"
          ? [this.state.text, "", "R fetch again from GitHub"]
          : [
              `no GitHub feedback fetched for #${n} yet`,
              "",
              "R fetch review threads and PR comments from GitHub (read-only)",
              `  or from a shell: station github-feedback ${n} --save`,
            ];
    return new NoticeView({ title: `github  #${n}`, subtitle: prContext(this.host.repoSlug, n), body, onQuit: this.host.onQuit, hints: "R fetch" });
  }

  private setNote(text: string): void {
    if (this.view !== null) this.view.note = text;
    this.host.requestRender?.();
  }

  async refresh(): Promise<void> {
    if (this.state.kind === "fetching") return;
    this.state = { kind: "fetching" };
    this.setNote("fetching from GitHub…");
    try {
      const snapshot = await this.deps.fetch();
      this.use(snapshot);
      this.state = { kind: "none" };
      try {
        this.deps.save(snapshot);
        this.setNote("");
      } catch (e) {
        this.setNote(`not saved: ${errText(e)}`);
      }
    } catch (e) {
      const text = `fetch failed: ${errText(e)}`;
      this.state = { kind: "error", text };
      this.setNote(this.view === null ? "" : "fetch failed, showing the previous snapshot");
      if (this.view !== null) this.host.showPopup({ title: "github", text, error: true, footer: "any key" }, true);
    }
    this.host.requestRender?.();
  }

  async open(thread: ReviewThread, snapshot: FeedbackSnapshot): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    const fail = (text: string): void =>
      this.host.showPopup({ title: "open", text: `${text}\n\nThe captured diff stays in the detail view.`, error: true, footer: "any key" }, true);
    try {
      const git = localGit(this.host.repo);
      const missing = [...new Set(requiredCommits(thread, snapshot))].filter((s) => !git.hasCommit(s));
      if (missing.length > 0) {
        this.setNote(`fetching ${missing.map((s) => s.slice(0, 10)).join(" ")} from origin…`);
        await this.deps.fetchCommits(missing).catch(() => undefined);
        this.setNote("");
      }
      const loc = resolveThread(thread, snapshot, git);
      if (!loc.ok) {
        fail(`cannot open ${threadLocation(thread)}: ${loc.reason}`);
        return;
      }
      await this.openAt(loc);
    } catch (e) {
      fail(errText(e));
    } finally {
      this.opening = false;
      this.host.requestRender?.();
    }
  }

  private async worktreeFor(rev: string): Promise<string> {
    if (rev === this.host.prHead) {
      const head = (await runAsync(this.host.prWorktree, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      if (head === rev) return this.host.prWorktree;
    }
    return findingsWorktree(this.host.repo, this.host.pr, rev);
  }

  private async openAt(loc: Extract<Located, { ok: true }>): Promise<void> {
    const cwd = await this.worktreeFor(loc.rev);
    const go = (): void => this.host.openPath(cwd, loc.path, loc.line, loc.base ?? undefined);
    const dirty = (await runAsync(cwd, ["status", "--porcelain", "--", loc.path])).trim() !== "";
    if (dirty) {
      this.host.showPopup(
        {
          title: "open",
          text: `${loc.path} has uncommitted changes in ${cwd}; line ${loc.line} refers to ${loc.rev.slice(0, 10)} and may have moved.`,
          footer: "y open anyway · any other key cancel",
        },
        true,
        { y: go },
      );
      return;
    }
    go();
  }

  invalidate(): void {
    this.view?.invalidate();
  }

  handleInput(data: string): void {
    if (data === "R") void this.refresh();
    else if (this.view !== null) this.view.handleInput(data);
    else if (data === "q") this.host.onQuit();
  }

  render(width: number): string[] {
    return (this.view ?? this.notice()).render(width);
  }
}

export function githubTab(host: PrTabHost): TabScreen {
  return new FeedbackTab(host);
}
