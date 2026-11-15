import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRunDir, finalize, terminationFromEnv } from "./finalize";
import { ENV_ALLOWLIST, systemdRunArgv } from "./launch";
import { parseBatchSpec, SpecError } from "./spec";

const run = { cwd: "/tmp", context: "ctx", prompt: "hi" };

describe("parseBatchSpec", () => {
  test("accepts a minimal run and keeps optional fields", () => {
    const spec = parseBatchSpec({ runs: [run, { ...run, model: "m", timeoutSec: 5 }] });
    expect(spec.runs).toEqual([run, { ...run, model: "m", timeoutSec: 5 }]);
  });

  test("rejects the whole batch when any run is invalid", () => {
    expect(() => parseBatchSpec({ runs: [run, { ...run, cwd: "rel" }] })).toThrow(SpecError);
    expect(() => parseBatchSpec({ runs: [{ ...run, context: "" }] })).toThrow("context");
    expect(() => parseBatchSpec({ runs: [{ ...run, timeoutSec: 0 }] })).toThrow("timeoutSec");
    expect(() => parseBatchSpec({ runs: [{ ...run, extra: 1 }] })).toThrow("unknown field extra");
    expect(() => parseBatchSpec({ runs: [] })).toThrow(SpecError);
  });
});

describe("systemdRunArgv", () => {
  const argv = systemdRunArgv({
    runId: "r1",
    batchId: "b1",
    runDir: "/state/runs/r1",
    spec: { ...run, timeoutSec: 30 },
    sessionId: "sid",
    piPath: "/bin/pi",
    shPath: "/bin/sh",
    finalizeCommand: ["/bin/bun", "/src/cli.ts", "finalize", "/state/runs/r1"],
    env: { PATH: "/bin", GEMINI_API_KEY: "k", PI_SESSION_ID: "parent", SECRET: "x" },
  });

  test("names the unit and batch slice and runs in the run dir", () => {
    expect(argv).toContain("--unit=cue-run-r1.service");
    expect(argv).toContain("--slice=cue-runs-b1.slice");
    expect(argv).toContain("--working-directory=/state/runs/r1");
    expect(argv).toContain("--property=RuntimeMaxSec=30");
    expect(argv).toContain("--property=ExecStopPost=/bin/bun /src/cli.ts finalize /state/runs/r1");
  });

  test("forwards only allowlisted variables plus the run context", () => {
    const setenv = argv.filter((arg) => arg.startsWith("--setenv="));
    expect(setenv).toEqual(["--setenv=PATH", "--setenv=GEMINI_API_KEY", "--setenv=CUE_CONTEXT=ctx"]);
    expect(ENV_ALLOWLIST).not.toContain("PI_SESSION_ID");
  });

  test("execs pi in json mode with a per-run session after the caller cwd", () => {
    const tail = argv.slice(argv.indexOf("/bin/sh"));
    expect(tail[3]).toBe("/tmp");
    expect(tail.slice(4)).toEqual([
      "/bin/pi", "-p", "--mode", "json", "--model", "google/gemini-3.8-flash",
      "--session-dir", "/state/runs/r1/session", "--session-id", "sid", "hi",
    ]);
    expect(tail).not.toContain("-ne");
  });
});

describe("finalize", () => {
  const stop = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PONG" }] },
  });

  test("records termination evidence and derives the result", () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    writeFileSync(join(dir, "events.jsonl"), stop + "\n");
    finalize(dir, { SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }, 42);
    expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8"))).toEqual(
      terminationFromEnv({ SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }, 42),
    );
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    expect(result.outcome).toBe("succeeded");
    expect(result.text).toBe("PONG");
  });

  test("never overwrites a recorded outcome and reads the cancel intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    finalize(dir, { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "TERM" }, 100);
    finalize(dir, { SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" }, 200);
    writeFileSync(join(dir, "cancel"), JSON.stringify({ requestedAt: 50 }));
    expect(deriveRunDir(dir).outcome).toBe("cancelled");
    expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")).finalizedAt).toBe(100);
  });
});
