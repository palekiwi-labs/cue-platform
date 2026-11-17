import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeRoot } from "./findings.js";
import { NoticeView } from "./tabs.js";

export interface WalkthroughCard {
  markdown: string;
}

/** A guided walkthrough stored at <org>/<repo>/review-pr-N/review/walkthrough/<id>.json. */
export interface Walkthrough {
  address: string;
  base: string;
  head: string;
  title: string;
  chunks: WalkthroughCard[];
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

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
}

export function loadWalkthrough(address: string, store = storeRoot()): Walkthrough {
  const path = walkthroughPath(address, store);
  if (!existsSync(path)) throw new Error(`no walkthrough at ${address}`);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    address,
    base: str(data.base),
    head: str(data.head),
    title: str(data.title),
    chunks: list(data.chunks).map((c) => ({ markdown: str(c.markdown) })),
  };
}

export function walkthroughView(walkthrough: Walkthrough | null, subtitle: string, onQuit: () => void): NoticeView {
  const body = ["walkthrough not implemented yet"];
  if (walkthrough !== null) {
    body.push("", `${walkthrough.chunks.length} cards  head ${walkthrough.head.slice(0, 10)}`);
  }
  return new NoticeView({ title: `walkthrough  ${walkthrough?.title ?? ""}`, subtitle, body, onQuit });
}
