import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghGraphql } from "../src/collector.js";

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
if (args.includes("query=failure")) { process.stderr.write("sensitive fixture diagnostics"); process.exit(5); }
process.stdout.write(JSON.stringify({ data: { viewer: { login: "viewer" } } }));
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
