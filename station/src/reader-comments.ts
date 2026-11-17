import { randomUUID } from "node:crypto";
import { sourceBlocks } from "./blocks.js";
import { type Finding, type FindingsRun, loadRun } from "./findings.js";
import type { ReaderRoundComment } from "./round.js";
import type { ReaderComment, ReaderCommentState, ReaderKind } from "./state.js";
import { loadWalkthrough, type Walkthrough } from "./walkthrough.js";

export interface ReaderTarget {
  kind: ReaderKind;
  source: string;
  item: string;
  item_title: string;
}

export interface ReaderSection {
  heading: string;
  markdown: string;
}

/** Content the reader shows: one finding or one walkthrough step. */
export interface ReaderDoc {
  target: ReaderTarget;
  title: string;
  subtitle: string;
  meta: string[];
  sections: ReaderSection[];
}

export function findingDoc(run: FindingsRun, f: Finding): ReaderDoc {
  const sections: ReaderSection[] = [{ heading: "Message", markdown: f.message }];
  if (f.suggested_fix !== null) sections.push({ heading: "Suggested fix", markdown: f.suggested_fix });
  if (f.verification !== null) sections.push({ heading: "Verification", markdown: f.verification.reasoning });
  const loc = f.file === null ? "(no file)" : `${f.file}${f.line_start === null ? "" : `:${f.line_start}`}`;
  const meta = [`severity ${f.severity}${f.verification === null ? "" : `   verdict ${f.verification.verdict}`}`, `${f.id}  ${loc}`];
  return {
    target: { kind: "finding", source: run.address, item: f.id, item_title: f.title },
    title: f.title,
    subtitle: `${run.context}   run ${run.runId}`,
    meta,
    sections: sections.filter((s) => s.markdown.trim() !== ""),
  };
}

export function walkthroughItem(chunkId: string, section: number, step: number): string {
  return `${chunkId}/${section}/${step}`;
}

export function walkthroughDoc(w: Walkthrough, chunk: number, section: number, step: number): ReaderDoc | null {
  const c = w.chunks[chunk];
  const s = c?.sections[section];
  const t = s?.steps[step];
  if (c === undefined || s === undefined || t === undefined) return null;
  const title = s.steps.length > 1 ? `${s.title} (step ${step + 1}/${s.steps.length})` : s.title;
  const meta = t.code === null ? [] : [`${t.code.path}${t.code.lines === null ? "" : `:${t.code.lines[0]}-${t.code.lines[1]}`}  ${t.code.revKind}`];
  return {
    target: { kind: "walkthrough", source: w.address, item: walkthroughItem(c.id, section, step), item_title: `${c.title} / ${title}` },
    title,
    subtitle: `walkthrough  ${c.title}`,
    meta,
    sections: [{ heading: s.title, markdown: t.markdown }],
  };
}

/** Index of the block `c` anchors to in `doc`, or null when its quote is gone. */
export function locate(doc: ReaderDoc, c: Pick<ReaderComment, "section" | "block" | "quote">): number | null {
  const section = doc.sections.find((s) => s.heading === c.section);
  if (section === undefined) return null;
  const blocks = sourceBlocks(section.markdown).map((b) => b.text);
  if (blocks[c.block] === c.quote) return c.block;
  const hits = blocks.flatMap((b, i) => (b === c.quote ? [i] : []));
  return hits.length === 1 ? hits[0]! : null;
}

export function sameTarget(c: ReaderComment, t: ReaderTarget): boolean {
  return c.kind === t.kind && c.source === t.source && c.item === t.item;
}

/** Draft reader comments of one review, persisted through `persist` on every change. */
export class ReaderComments {
  version = 0;

  constructor(
    private state: ReaderCommentState,
    private readonly persist: (state: ReaderCommentState) => void,
  ) {}

  all(): ReaderComment[] {
    return this.state.comments;
  }

  get size(): number {
    return this.state.comments.length;
  }

  forTarget(t: ReaderTarget): ReaderComment[] {
    return this.state.comments.filter((c) => sameTarget(c, t));
  }

  get(id: string): ReaderComment | undefined {
    return this.state.comments.find((c) => c.id === id);
  }

  private set(comments: ReaderComment[]): void {
    this.state = { ...this.state, comments };
    this.version++;
    this.persist(this.state);
  }

  add(t: ReaderTarget, section: string, block: number, quote: string, text: string, now = Math.floor(Date.now() / 1000)): ReaderComment {
    const c: ReaderComment = { id: randomUUID(), ...t, section, block, quote, text, created_at: now };
    this.set([...this.state.comments, c]);
    return c;
  }

  update(id: string, text: string): void {
    this.set(this.state.comments.map((c) => (c.id === id ? { ...c, text } : c)));
  }

  remove(ids: Iterable<string>): void {
    const drop = new Set(ids);
    this.set(this.state.comments.filter((c) => !drop.has(c.id)));
  }
}

export function readerRoundComment(c: ReaderComment, doc: ReaderDoc | null): ReaderRoundComment {
  return {
    target: c.kind,
    source: c.source,
    item: c.item,
    item_title: c.item_title,
    section: c.section,
    quote: c.quote,
    outdated: doc === null || locate(doc, c) === null,
    text: c.text,
    created_at: c.created_at,
  };
}

export interface DocLoaders {
  run: (address: string) => FindingsRun;
  walkthrough: (address: string) => Walkthrough;
}

const defaultLoaders: DocLoaders = { run: (a) => loadRun(a), walkthrough: (a) => loadWalkthrough(a) };

/** The document a comment was written on, loaded from the store, or null when it is gone. */
export function docFor(c: ReaderComment, loaders: DocLoaders = defaultLoaders): ReaderDoc | null {
  try {
    if (c.kind === "finding") {
      const run = loaders.run(c.source);
      const f = run.findings.find((x) => x.id === c.item);
      return f === undefined ? null : findingDoc(run, f);
    }
    const w = loaders.walkthrough(c.source);
    const m = /^(.*)\/(\d+)\/(\d+)$/.exec(c.item);
    if (m === null) return null;
    const chunk = w.chunks.findIndex((x) => x.id === m[1]);
    return chunk === -1 ? null : walkthroughDoc(w, chunk, Number(m[2]), Number(m[3]));
  } catch {
    return null;
  }
}

/** `comments` in round order: findings, then walkthrough steps, each by creation. */
export function roundOrder(comments: ReaderComment[]): ReaderComment[] {
  return [...comments].sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === "finding" ? -1 : 1) || a.created_at - b.created_at,
  );
}

/** Round entries for `comments`, in `roundOrder`. */
export function readerRound(comments: ReaderComment[], loaders: DocLoaders = defaultLoaders): ReaderRoundComment[] {
  const cache = new Map<string, ReaderDoc | null>();
  return roundOrder(comments).map((c) => {
    const key = `${c.kind}\n${c.source}\n${c.item}`;
    if (!cache.has(key)) cache.set(key, docFor(c, loaders));
    return readerRoundComment(c, cache.get(key) ?? null);
  });
}
