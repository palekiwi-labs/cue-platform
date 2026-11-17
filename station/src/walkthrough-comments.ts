import { randomUUID } from "node:crypto";
import type { ComposeRequest } from "./changes.js";
import { stepFingerprint, type WalkthroughCommentState, type WalkthroughDraft } from "./state.js";
import type { Walkthrough, WalkthroughStep } from "./walkthrough.js";

export type Compose = (request: ComposeRequest, done: (text: string | null) => void) => void;

/** A step of the current walkthrough by chunk, section and step index. */
export interface StepRef {
  chunk: number;
  section: number;
  step: number;
}

/**
 * Walkthrough draft comments of one review, one per step. A draft whose step
 * markdown no longer matches the current walkthrough is outdated.
 */
export class WalkthroughDrafts {
  private loaded: Walkthrough | null | undefined;

  constructor(
    private state: WalkthroughCommentState,
    private readonly save: (state: WalkthroughCommentState) => void,
    private readonly resolve: () => Walkthrough | null,
    private readonly compose: Compose,
  ) {}

  use(walkthrough: Walkthrough): void {
    this.loaded = walkthrough;
  }

  current(): Walkthrough | null {
    if (this.loaded === undefined) this.loaded = this.resolve();
    return this.loaded;
  }

  all(): WalkthroughDraft[] {
    return this.state.comments;
  }

  private step(ref: StepRef): { chunk: string; title: string; steps: WalkthroughStep[]; step: WalkthroughStep } | null {
    const chunk = this.current()?.chunks[ref.chunk];
    const section = chunk?.sections[ref.section];
    const step = section?.steps[ref.step];
    if (chunk === undefined || section === undefined || step === undefined) return null;
    return { chunk: chunk.id, title: section.title, steps: section.steps, step };
  }

  /** The step a draft is anchored to, or null when the draft is outdated. */
  locate(d: WalkthroughDraft): StepRef | null {
    const w = this.current();
    const chunk = w?.chunks.findIndex((c) => c.id === d.chunk) ?? -1;
    if (chunk === -1) return null;
    const ref = { chunk, section: d.section, step: d.step };
    const s = this.step(ref);
    return s !== null && stepFingerprint(s.step.markdown) === d.fingerprint ? ref : null;
  }

  at(ref: StepRef): WalkthroughDraft | undefined {
    const s = this.step(ref);
    if (s === null) return undefined;
    const fp = stepFingerprint(s.step.markdown);
    return this.state.comments.find(
      (d) => d.chunk === s.chunk && d.section === ref.section && d.step === ref.step && d.fingerprint === fp,
    );
  }

  title(d: WalkthroughDraft): string {
    const ref = this.locate(d);
    const count = ref === null ? null : this.step(ref)?.steps.length;
    return `${d.section_title} · ${count == null ? "outdated" : `step ${d.step + 1}/${count}`}`;
  }

  private set(comments: WalkthroughDraft[]): void {
    this.state = { ...this.state, comments };
    this.save(this.state);
  }

  /** Opens the compose box on the step: edits its draft or starts a new one. */
  write(ref: StepRef): void {
    const s = this.step(ref);
    if (s === null) return;
    const existing = this.at(ref);
    if (existing !== undefined) {
      this.edit(existing.id);
      return;
    }
    this.compose({ title: `${s.title} · step ${ref.step + 1}/${s.steps.length}`, text: "" }, (text) => {
      if (text === null) return;
      const draft: WalkthroughDraft = {
        id: randomUUID().slice(0, 8),
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
