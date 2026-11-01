#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "src", "pi");
const target = join(here, "..", "src", "picker");

const FILES = [
  "prs/ui.ts",
  "prs/model.ts",
  "prs/preview.ts",
  "prs/browser.ts",
  "prs/context-picker.ts",
  "browser/model.ts",
  "browser/context-list.ts",
];

const RELATIVE_IMPORT = /(from\s+|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

function withJsExtensions(text) {
  return text.replace(RELATIVE_IMPORT, (match, lead, quote, spec) =>
    spec.endsWith(".js") ? match : `${lead}${quote}${spec}.js${quote}`,
  );
}

rmSync(target, { recursive: true, force: true });
for (const file of FILES) {
  const text = readFileSync(join(source, file), "utf8");
  const out = join(target, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, withJsExtensions(text));
}
