import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("config requires explicit repositories, defaults to 120s, rejects invalid schedules", () => {
  const config = parseConfig('repositories = ["spabreaks/spabreaks"]');
  assert.equal(config.scheduling.pollMs, 120_000);
  assert.equal(config.natsUrl, "nats://127.0.0.1:4222");
  assert.deepEqual(config.repositories, ["spabreaks/spabreaks"]);
  for (const input of [
    "",
    "repositories = []",
    'repositories = ["bad"]',
    'repositories = ["a/b", "A/B"]',
    'repositories = ["a/b"]\nconcurrency = 0',
    'repositories = ["a/b"]\npoll_seconds = 5',
    'repositories = ["a/b"]\nunknown = true',
    'repositories = ["a/b"]\ncooldown_seconds = 121',
  ])
    assert.throws(() => parseConfig(input));
});
