import type { Component } from "@earendil-works/pi-tui";
import { C, fit, RESET } from "./changes.js";

export interface TabScreen extends Component {
  handleInput(data: string): void;
  handleEscape?(): boolean;
}

export interface Tab {
  label: string;
  screen: () => TabScreen;
}

export function tabStrip(labels: string[], active: number): string {
  const parts = labels.map((l, i) =>
    i === active ? `${C.accent}${i + 1} ${l}` : `${C.dim}${i + 1} ${l}`,
  );
  return ` ${parts.join(" ")}${C.faint} │${RESET}`;
}

export class TabsScreen implements TabScreen {
  private active = 0;
  private readonly built = new Map<number, TabScreen>();

  constructor(private readonly tabs: Tab[]) {}

  get index(): number {
    return this.active;
  }

  current(): TabScreen {
    let s = this.built.get(this.active);
    if (s === undefined) {
      s = this.tabs[this.active]!.screen();
      this.built.set(this.active, s);
    }
    return s;
  }

  select(index: number): void {
    if (index >= 0 && index < this.tabs.length) this.active = index;
  }

  invalidate(): void {
    this.current().invalidate?.();
  }

  handleInput(data: string): void {
    if (/^[1-9]$/.test(data) && Number(data) <= this.tabs.length) {
      this.select(Number(data) - 1);
      return;
    }
    this.current().handleInput(data);
  }

  handleEscape(): boolean {
    return this.current().handleEscape?.() === true;
  }

  render(width: number): string[] {
    const lines = this.current().render(width);
    if (lines.length === 0) return lines;
    const strip = tabStrip(this.tabs.map((t) => t.label), this.active);
    const last = lines.length - 1;
    const footer = `${C.barBg}${strip}${C.barBg}${lines[last]}`;
    lines[last] = fit(footer, width) + RESET;
    return lines;
  }
}

export interface NoticeOptions {
  title: string;
  subtitle: string;
  body: string[];
  hints?: string;
  onQuit: () => void;
}

export class NoticeView implements TabScreen {
  constructor(private readonly opts: NoticeOptions) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === "q") this.opts.onQuit();
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const out = [
      C.titleBg + fit(` ${C.text}${this.opts.title}`, width) + RESET,
      C.barBg + fit(` ${C.dim}${this.opts.subtitle}`, width) + RESET,
    ];
    const body = ["", ...this.opts.body.map((l) => `  ${C.dim}${l}${RESET}`)];
    for (let i = 0; i < total - 3; i++) out.push(fit(body[i] ?? "", width));
    out.push(C.barBg + fit(` ${C.text}${this.opts.hints === undefined ? "" : `${this.opts.hints}  `}q${C.dim} quit`, width) + RESET);
    return out;
  }
}
