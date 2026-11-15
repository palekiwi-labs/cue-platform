import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { highlightLines, languageFor } from "../src/highlight.js";

test("language detection", () => {
  assert.equal(languageFor("app/models/a.rb"), "rb");
  assert.equal(languageFor("Gemfile"), "ruby");
  assert.equal(languageFor("x.tsx"), "typescript");
  assert.equal(languageFor("a.html.erb"), "erb");
  assert.equal(languageFor("flake.nix"), "nix");
  assert.equal(languageFor("Gemfile.lock"), null);
  assert.equal(languageFor("README"), null);
});

test("lines keep text, use foreground-only colour, survive multi-line tokens", () => {
  const code = 'def a(x) # hi\n  "two\nlines" && x < 1\nend';
  const lines = highlightLines(code, "ruby");
  assert.deepEqual(lines.map(stripTerminalSequences), code.split("\n"));
  assert.ok(lines.every((l) => !l.includes("\x1b[0m") && !/\x1b\[4\d/.test(l)));
  assert.ok(lines[2]?.startsWith("\x1b[38;2;165;214;255m"));
});
