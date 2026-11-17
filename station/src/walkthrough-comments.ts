import { randomUUID } from "node:crypto";
import type { ComposeRequest } from "./changes.js";
import type { DraftGroup, PaneEntry } from "./drafts.js";
import type { RoundComment, WalkthroughRoundComment } from "./round.js";
import { stepFingerprint, type WalkthroughCommentState, type WalkthroughDraft } from "./state.js";
import { loadWalkthrough, type Walkthrough, type WalkthroughStep } from "./walkthrough.js";

export type Compose = (request: ComposeRequest, done: (text: string | null) => void) => void;

/** A step within a walkthrough by chunk, section and step index. */
export interface StepRef {
  chunk: number;
  section: number;
  step: number;
}

/**
 * Walkthrough draft comments of one review, one per step. A draft whose step
 * markdown no longer matches its own walkthrough is outdated.
 */
export class WalkthroughDrafts implements DraftGroup {
  private loaded: Walkthrough | null | undefined;
  private readonly cache = new Map<string, Walkthrough | null>();

  constructor(
    private state: WalkthroughCommentState,
    private readonly save: (state: WalkthroughCommentState) => void,
    private readonly resolveCurrent: () => Walkthrough | null,
    private readonly compose: Compose,
    private readonly load: (address: string) => Walkthrough = loadWalkthrough,
  ) {}

  use(walkthrough: Walkthrough): void {
    this.loaded = walkthrough;
    this.cache.set(walkthrough.address, walkthrough);
    if (this.state.comments.some((d) => d.walkthrough === undefined)) {
      this.set(this.state.comments.map((d) => d.walkthrough === undefined ? { ...d, walkthrough: walkthrough.address } : d));
    }
  }

  current(): Walkthrough | null {
    if (this.loaded === undefined) {
      this.loaded = this.resolveCurrent();
      if (this.loaded !== null) this.use(this.loaded);
    }
    return this.loaded;
  }

  private resolve(d: WalkthroughDraft): Walkthrough | null {
    this.current();
    if (d.walkthrough === undefined) return this.loaded ?? null;
    if (!this.cache.has(d.walkthrough)) {
      try {
        this.cache.set(d.walkthrough, this.load(d.walkthrough));
      } catch {
        this.cache.set(d.walkthrough, null);
      }
    }
    return this.cache.get(d.walkthrough) ?? null;
  }

  all(): WalkthroughDraft[] {
    return this.state.comments;
  }

  private step(
    ref: StepRef,
    walkthrough = this.current(),
  ): { chunk: string; title: string; steps: WalkthroughStep[]; step: WalkthroughStep } | null {
    const chunk = walkthrough?.chunks[ref.chunk];
    const section = chunk?.sections[ref.section];
    const step = section?.steps[ref.step];
    if (chunk === undefined || section === undefined || step === undefined) return null;
    return { chunk: chunk.id, title: section.title, steps: section.steps, step };
  }

  /** The step a draft is anchored to, or null when the draft is outdated. */
  locate(d: WalkthroughDraft): StepRef | null {
    const w = this.resolve(d);
    const chunk = w?.chunks.findIndex((c) => c.id === d.chunk) ?? -1;
    if (chunk === -1) return null;
    const ref = { chunk, section: d.section, step: d.step };
    const s = this.step(ref, w);
    return s !== null && stepFingerprint(s.step.markdown) === d.fingerprint ? ref : null;
  }

  at(ref: StepRef): WalkthroughDraft | undefined {
    const s = this.step(ref);
    if (s === null) return undefined;
    const fp = stepFingerprint(s.step.markdown);
    const address = this.current()?.address;
    return this.state.comments.find(
      (d) => d.walkthrough === address && d.chunk === s.chunk &&
        d.section === ref.section && d.step === ref.step && d.fingerprint === fp,
    );
  }

  private where(d: WalkthroughDraft): string {
    const ref = this.locate(d);
    const count = ref === null ? null : this.step(ref, this.resolve(d))?.steps.length;
    return count == null ? "outdated" : `step ${d.step + 1}/${count}`;
  }

  title(d: WalkthroughDraft): string {
    return `${d.section_title} · ${this.where(d)}`;
  }

  private ordered(): { draft: WalkthroughDraft; ref: StepRef | null }[] {
    this.current();
    const items = this.state.comments.map((draft) => ({ draft, ref: this.locate(draft) }));
    const live = items.filter((i) => i.ref !== null);
    const outdated = items.filter((i) => i.ref === null);
    const key = (r: StepRef | null): number[] => (r === null ? [] : [r.chunk, r.section, r.step]);
    live.sort((a, b) => {
      const [x, y] = [key(a.ref), key(b.ref)];
      return (x[0]! - y[0]!) || (x[1]! - y[1]!) || (x[2]! - y[2]!);
    });
    outdated.sort((a, b) => a.draft.created_at - b.draft.created_at);
    return [...live, ...outdated];
  }

  entries(): PaneEntry[] {
    return this.ordered().map(({ draft, ref }) => ({
      tab: "walkthrough" as const,
      id: draft.id,
      title: draft.section_title,
      where: this.where(draft),
      text: draft.text,
      outdated: ref === null,
    }));
  }

  round(): { id: string; comment: RoundComment }[] {
    return this.ordered().map(({ draft, ref }) => {
      const step = ref === null ? null : (this.step(ref, this.resolve(draft))?.step ?? null);
      const first = step?.markdown.split("\n").find((l) => l.trim() !== "")?.trim() ?? null;
      const comment: WalkthroughRoundComment = {
        target: "walkthrough",
        walkthrough: draft.walkthrough ?? this.current()?.address ?? null,
        chunk: draft.chunk,
        section: draft.section_title,
        step: draft.step,
        first_line: first,
        path: step?.code?.path ?? null,
        lines: step?.code?.lines ?? null,
        outdated: ref === null,
        text: draft.text,
        created_at: draft.created_at,
      };
      return { id: draft.id, comment };
    });
  }

  private set(comments: WalkthroughDraft[]): void {
    this.state = { ...this.state, comments };
    this.save(this.state);
  }

  /** Opens the compose box on the step: edits its draft or starts a new one. */
  write(ref: StepRef): void {
    const current = this.current();
    const s = this.step(ref, current);
    if (s === null || current === null) return;
    const walkthrough = current.address;
    const existing = this.at(ref);
    if (existing !== undefined) {
      this.edit(existing.id);
      return;
    }
    this.compose({ title: `${s.title} · step ${ref.step + 1}/${s.steps.length}`, text: "" }, (text) => {
      if (text === null) return;
      const draft: WalkthroughDraft = {
        id: randomUUID().slice(0, 8),
        walkthrough,
        chunk: s.chunk,
        section: ref.section,
        section_title: s.title,
        step: ref.step,
        fingerprint: stepFingerprint(s.step.markdown),
        text,
        created_at: Math.floor(Date.now() / 1000),
      };
      this.set([...this.state.comments, draft]);
    });
  }

  edit(id: string): void {
    const d = this.state.comments.find((c) => c.id === id);
    if (d === undefined) return;
    this.compose({ title: this.title(d), text: d.text }, (text) => {
      if (text === null) return;
      this.set(this.state.comments.map((c) => (c.id === id ? { ...c, text } : c)));
    });
  }

  remove(ids: string[]): void {
    this.set(this.state.comments.filter((c) => !ids.includes(c.id)));
  }
}
