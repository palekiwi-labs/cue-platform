import { describe, expect, test } from "bun:test";
import { deriveResult, type TerminationEvidence } from "./result";

const FINALIZED_AT = 1_000;

function termination(
  exitCode: string,
  exitStatus: string,
  serviceResult = "success",
): TerminationEvidence {
  return { serviceResult, exitCode, exitStatus, finalizedAt: FINALIZED_AT };
}

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

const preamble = [
  { type: "session", id: "s1", cwd: "/tmp", timestamp: "t", version: 3 },
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
];

function assistant(message: Record<string, unknown>) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "google",
      model: "gemini-3.8-flash",
      usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 115, cost: { total: 0.25 } },
      ...message,
    },
  };
}

const success = jsonl(
  ...preamble,
  assistant({ stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] }),
  assistant({ stopReason: "stop", content: [{ type: "text", text: "PO" }, { type: "text", text: "NG" }] }),
  { type: "agent_end", messages: [assistant({ stopReason: "stop" }).message], willRetry: false },
  { type: "agent_settled", aborted: false },
);

const modelError = jsonl(
  ...preamble,
  assistant({
    stopReason: "error",
    errorMessage: "400 invalid_request_error",
    content: [],
    usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
  }),
  { type: "agent_settled", aborted: false },
);

const interruptedTool = jsonl(
  ...preamble,
  assistant({ stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "" }] }),
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} },
);

describe("deriveResult", () => {
  test("clean exit with final stop is succeeded with summed usage", () => {
    const result = deriveResult({ termination: termination("exited", "0"), cancel: null, events: success });
    expect(result.outcome).toBe("succeeded");
    expect(result.partial).toBe(false);
    expect(result.text).toBe("PONG");
    expect(result.stopReason).toBe("stop");
    expect(result.model).toBe("google/gemini-3.8-flash");
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({ input: 200, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 230, cost: 0.5 });
  });

  test("exit 0 with every model call failing is failed, keeping the error", () => {
    const result = deriveResult({ termination: termination("exited", "0"), cancel: null, events: modelError });
    expect(result.outcome).toBe("failed");
    expect(result.partial).toBe(true);
    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("400 invalid_request_error");
    expect(result.text).toBeNull();
  });

  test("cancel intent before termination is cancelled and partial", () => {
    const result = deriveResult({
      termination: termination("exited", "143"),
      cancel: { requestedAt: FINALIZED_AT - 5 },
      events: interruptedTool,
    });
    expect(result.outcome).toBe("cancelled");
    expect(result.partial).toBe(true);
    expect(result.stopReason).toBe("toolUse");
    expect(result.text).toBeNull();
  });

  test("cancel escalated to SIGKILL by stop timeout is still cancelled", () => {
    const result = deriveResult({
      termination: termination("killed", "KILL", "timeout"),
      cancel: { requestedAt: FINALIZED_AT },
      events: interruptedTool,
    });
    expect(result.outcome).toBe("cancelled");
  });

  test("natural completion wins over a racing cancel intent", () => {
    const result = deriveResult({
      termination: termination("exited", "0"),
      cancel: { requestedAt: FINALIZED_AT - 1 },
      events: success,
    });
    expect(result.outcome).toBe("succeeded");
  });

  test("cancel intent recorded after termination does not relabel a failure", () => {
    const result = deriveResult({
      termination: termination("exited", "1", "exit-code"),
      cancel: { requestedAt: FINALIZED_AT + 1 },
      events: modelError,
    });
    expect(result.outcome).toBe("failed");
  });

  test("runtime timeout is timed_out", () => {
    const result = deriveResult({
      termination: termination("killed", "TERM", "timeout"),
      cancel: null,
      events: interruptedTool,
    });
    expect(result.outcome).toBe("timed_out");
  });

  test("runner chdir failure and missing executable are launch_failed", () => {
    for (const status of ["200", "127"]) {
      const result = deriveResult({ termination: termination("exited", status, "exit-code"), cancel: null, events: "" });
      expect(result.outcome).toBe("launch_failed");
    }
  });

  test("signal death without cancel intent is failed", () => {
    const result = deriveResult({ termination: termination("killed", "SEGV", "signal"), cancel: null, events: "" });
    expect(result.outcome).toBe("failed");
  });

  test("missing termination evidence is unknown even with a plausible answer", () => {
    const result = deriveResult({ termination: null, cancel: null, events: success });
    expect(result.outcome).toBe("unknown");
    expect(result.partial).toBe(true);
    expect(result.text).toBe("PONG");
  });

  test("a truncated last line is ignored and counted", () => {
    const truncated = success + '{"type":"message_end","message":{"role":"assis';
    const result = deriveResult({ termination: termination("exited", "0"), cancel: null, events: truncated });
    expect(result.outcome).toBe("succeeded");
    expect(result.ignoredLines).toBe(1);
  });

  test("empty output yields an empty summary", () => {
    const result = deriveResult({ termination: termination("exited", "0"), cancel: null, events: "" });
    expect(result.outcome).toBe("failed");
    expect(result.turns).toBe(0);
    expect(result.text).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });

  test("an empty trailing assistant message keeps the last non-empty text", () => {
    const events = jsonl(
      ...preamble,
      assistant({ stopReason: "toolUse", content: [{ type: "text", text: "checking" }] }),
      assistant({ stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] }),
    );
    const result = deriveResult({ termination: termination("exited", "143"), cancel: { requestedAt: 0 }, events });
    expect(result.text).toBe("checking");
  });
});
