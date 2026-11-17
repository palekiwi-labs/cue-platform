import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  emptyWalkthroughComments,
  loadWalkthroughComments,
  parseWalkthroughComments,
  saveWalkthroughComments,
  stepFingerprint,
  type WalkthroughDraft,
} from "../src/state.js";

const draft: WalkthroughDraft = {
  id: "d1",
  chunk: "r",
  section: 0,
  section_title: "Room list price",
  step: 2,
  fingerprint: stepFingerprint("Now it is per person."),
  text: "why per person?",
  created_at: 5,
};

test("step fingerprints follow the markdown", () => {
  assert.equal(stepFingerprint("a"), stepFingerprint("a"));
  assert.notEqual(stepFingerprint("a"), stepFingerprint("b"));
  assert.match(stepFingerprint(""), /^[0-9a-f]{16}$/);
});

test("parseWalkthroughComments tolerates garbage and drops invalid entries", () => {
  assert.deepEqual(parseWalkthroughComments(null), emptyWalkthroughComments());
  assert.deepEqual(parseWalkthroughComments("nope"), emptyWalkthroughComments());
  assert.deepEqual(parseWalkthroughComments(JSON.stringify({ schema: "station/comments@1", comments: [draft] })), emptyWalkthroughComments());
  const parsed = parseWalkthroughComments(
    JSON.stringify({
      schema: "station/walkthrough-comments@1",
      comments: [draft, { ...draft, step: -1 }, { ...draft, section: "0" }, { id: "x" }],
    }),
  );
  assert.deepEqual(parsed.comments, [draft]);
});

test("walkthrough drafts round-trip through the cache per review key", () => {
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(`${tmpdir()}/station-home-`);
  try {
    assert.deepEqual(loadWalkthroughComments("k"), emptyWalkthroughComments());
    saveWalkthroughComments("k", { schema: "station/walkthrough-comments@1", comments: [draft] });
    assert.deepEqual(loadWalkthroughComments("k").comments, [draft]);
    assert.deepEqual(loadWalkthroughComments("other"), emptyWalkthroughComments());
  } finally {
    process.env.HOME = home;
  }
});
