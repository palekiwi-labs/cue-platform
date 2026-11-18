import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGhGraphql,
  ghGraphql,
  RateLimitError,
} from "../src/collector.js";

test("gh uses proxy credential per repository, explicit host, sanitized failures and cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-subprocess-"));
  const saved = {
    PATH: process.env.PATH,
    GH_TOKEN: process.env.GH_TOKEN,
    GH_HOST: process.env.GH_HOST,
  };
  const executable = join(dir, "gh");
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
const expected = args.includes("owner=spabreaks") || args.includes("id=spabreaks-node") ? "PLACEHOLDER-gh-spabreaks" : "fixture-token";
if (process.env.GH_TOKEN !== expected) process.exit(2);
if (args.some(a => a.startsWith("credentialOwner="))) process.exit(3);
if (args[args.indexOf("--hostname") + 1] !== "github.com") process.exit(4);
if (!args.includes("--include")) process.exit(6);
if (args.includes("number=7") && args[args.indexOf("number=7") - 1] !== "-F") process.exit(7);
const ok = "HTTP/2.0 200 OK\\nContent-Type: application/json\\n";
if (args.includes("query=primary")) { process.stdout.write(ok + "X-Ratelimit-Remaining: 0\\nX-Ratelimit-Reset: 2000\\n\\r\\n" + JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 1." }] })); process.stderr.write("gh: API rate limit already exceeded for user ID 1.\\n"); process.exit(1); }
if (args.includes("query=secondary")) { process.stdout.write("HTTP/2.0 403 Forbidden\\nRetry-After: 30\\n\\r\\n" + JSON.stringify({ message: "You have exceeded a secondary rate limit." })); process.stderr.write("gh: You have exceeded a secondary rate limit. (HTTP 403)\\n"); process.exit(1); }
if (args.includes("query=bare")) { process.stderr.write("gh: HTTP 429\\n"); process.exit(1); }
if (args.includes("query=forbidden")) { process.stdout.write("HTTP/2.0 403 Forbidden\\nX-Ratelimit-Remaining: 4000\\n\\r\\n" + JSON.stringify({ message: "Resource not accessible" })); process.stderr.write("gh: Resource not accessible (HTTP 403)\\n"); process.exit(1); }
if (args.includes("query=low")) { process.stdout.write(ok + "X-Ratelimit-Remaining: 5\\nX-Ratelimit-Reset: 3000\\n\\r\\n" + JSON.stringify({ data: {} })); process.exit(0); }
if (args.includes("query=failure")) { process.stderr.write("sensitive fixture diagnostics"); process.exit(5); }
process.stdout.write(ok + "X-Ratelimit-Remaining: 4000\\n\\r\\n" + JSON.stringify({ data: { viewer: { login: "viewer" } } }));
`;
  writeFileSync(executable, script, { mode: 0o700 });
  Object.assign(process.env, {
    PATH: `${dir}:${saved.PATH}`,
    GH_TOKEN: "fixture-token",
    GH_HOST: "not-github.invalid",
  });
  try {
    const result = { data: { viewer: { login: "viewer" } } };
    assert.deepEqual(
      await ghGraphql("fixture", { owner: "spabreaks", name: "spabreaks" }),
      result,
    );
    assert.deepEqual(
      await ghGraphql("fixture", {
        id: "spabreaks-node",
        credentialOwner: "spabreaks",
        cursor: "next",
      }),
      result,
    );
    assert.deepEqual(
      await ghGraphql("fixture", { owner: "example", name: "project" }),
      result,
    );
    assert.equal(process.env.GH_TOKEN, "fixture-token");
    await assert.rejects(ghGraphql("failure", { owner: "example" }), {
      message: "GitHub subprocess failed",
    });
    const lows: number[] = [];
    const gh = createGhGraphql(
      (until) => lows.push(until),
      () => 1_000_000,
    );
    assert.deepEqual(
      await gh("fixture", { owner: "example", number: 7 }),
      result,
    );
    await assert.rejects(gh("primary", { owner: "example" }), (e) => {
      assert.ok(e instanceof RateLimitError);
      assert.equal(e.until, 2_001_000);
      return true;
    });
    await assert.rejects(
      gh("secondary", { owner: "example" }),
      (e) => e instanceof RateLimitError && e.until === 1_030_000,
    );
    await assert.rejects(
      gh("bare", { owner: "example" }),
      (e) => e instanceof RateLimitError && e.until === 1_060_000,
    );
    await assert.rejects(
      gh("forbidden", { owner: "example" }),
      (e) => !(e instanceof RateLimitError),
    );
    assert.deepEqual(lows, []);
    assert.deepEqual(await gh("low", { owner: "example" }), { data: {} });
    assert.deepEqual(lows, [3_001_000]);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      ghGraphql("fixture", { owner: "example" }, abort.signal),
      { message: "GitHub subprocess failed" },
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
