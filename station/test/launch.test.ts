import assert from "node:assert/strict";
import { test } from "node:test";
import { LAUNCHES, launchPickerText, reviewArgs } from "../src/launch.js";

test("review runs the default manifest into review-pr-N", () => {
  assert.deepEqual(reviewArgs("/r", 7), ["pr", "7", "--manifest", "default", "--context", "review-pr-7", "-C", "/r"]);
});

test("picker lists one key per launch kind", () => {
  assert.deepEqual(LAUNCHES.map((l) => l.key), ["r", "w"]);
  assert.match(launchPickerText(), /^r {2}review.*\nw {2}walkthrough/);
});
