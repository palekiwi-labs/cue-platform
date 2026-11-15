import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiReply, handleRequest } from "./api";
import type { LaunchEnvironment } from "./run";
import { readJsonIfExists, writeJsonAtomic } from "./store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function environment(): LaunchEnvironment {
  const root = mkdtempSync(join(tmpdir(), "sup-api-"));
  roots.push(root);
  return { root, piPath: "/bin/true", shPath: "/bin/sh", finalizeCommand: () => ["/bin/true"], env: {} };
}
const request = { requestId: "test-1", spec: { runs: [{ cwd: "/tmp", context: "supervisor-design", prompt: "test" }] } };

test("acceptance and dedup persist before launch, including restart and conflict", () => {
  const env = environment();
  let launches = 0;
  const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => {
    launches++;
    const files = readdirSync(join(env.root, "batches"));
    const accepted = readJsonIfExists<any>(join(env.root, "batches", files[0]!));
    expect(accepted.requestId).toBe(request.requestId);
    expect(accepted.runIds).toHaveLength(1);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }) as any);
  try {
    const first = handleRequest("submit", request, env);
    expect(handleRequest("submit", JSON.parse(JSON.stringify(request)), { ...env })).toEqual(first);
    expect(launches).toBe(1);
    expect(apiReply("submit", { ...request, spec: { runs: [{ ...request.spec.runs[0], prompt: "changed" }] } }, env))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(launches).toBe(1);
    const { runIds, batchId } = first as { runIds: string[]; batchId: string };
    writeJsonAtomic(join(env.root, "runs", runIds[0]!, "result.json"), { outcome: "succeeded", text: "done" });
    for (const operation of ["status", "result"]) {
      expect(handleRequest(operation, { kind: "batch", batchId }, env)).toMatchObject({
        runs: [{ runId: runIds[0], state: "finished", result: { outcome: "succeeded" } }],
      });
    }
    expect(handleRequest("cancel", { kind: "run", runId: runIds[0] }, env)).toMatchObject({ alreadyFinished: runIds });
  } finally { spawn.mockRestore(); }
});

test("invalid requests and traversal are rejected without acceptance", () => {
  const env = environment();
  for (const input of [null, [], {}, { ...request, requestId: "../bad" },
    { ...request, spec: { runs: [{ cwd: "relative", context: "x", prompt: "x" }] } }]) {
    expect(apiReply("submit", input, env)).toMatchObject({ ok: false });
  }
  expect(apiReply("result", { kind: "run", runId: "../bad" }, env)).toMatchObject({ ok: false });
  expect(apiReply("status", { kind: "batch", batchId: "missing" }, env)).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(readdirSync(env.root)).toEqual([]);
});
