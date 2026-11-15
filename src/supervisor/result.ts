export type RunOutcomeKind =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "launch_failed"
  | "unknown";

/** Termination evidence recorded by the unit's ExecStopPost finalizer. */
export interface TerminationEvidence {
  serviceResult: string;
  exitCode: string;
  exitStatus: string;
  finalizedAt: number;
}

/** Cancellation intent persisted by the supervisor before stopping a unit. */
export interface CancelIntent {
  requestedAt: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface RunResult {
  outcome: RunOutcomeKind;
  partial: boolean;
  text: string | null;
  stopReason: string | null;
  error: string | null;
  model: string | null;
  turns: number;
  usage: Usage;
  ignoredLines: number;
  termination: TerminationEvidence | null;
  cancel: CancelIntent | null;
}

export interface DeriveInput {
  termination: TerminationEvidence | null;
  cancel: CancelIntent | null;
  events: string;
}

interface AssistantSummary {
  text: string | null;
  stopReason: string | null;
  error: string | null;
  model: string | null;
  turns: number;
  usage: Usage;
  ignoredLines: number;
}

const LAUNCH_FAILURE_STATUSES = new Set(["127", "200"]);

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
  const text = parts.join("");
  return text.length > 0 ? text : null;
}

function summarizeEvents(events: string): AssistantSummary {
  const summary: AssistantSummary = {
    text: null,
    stopReason: null,
    error: null,
    model: null,
    turns: 0,
    usage: emptyUsage(),
    ignoredLines: 0,
  };
  for (const line of events.split("\n")) {
    if (line.trim() === "") continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      summary.ignoredLines++;
      continue;
    }
    if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
    const message = event.message;
    summary.turns++;
    summary.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
    summary.error = typeof message.errorMessage === "string" ? message.errorMessage : null;
    if (typeof message.model === "string") summary.model = message.model;
    const text = messageText(message.content);
    if (text !== null) summary.text = text;
    const usage = message.usage ?? {};
    summary.usage.input += num(usage.input);
    summary.usage.output += num(usage.output);
    summary.usage.cacheRead += num(usage.cacheRead);
    summary.usage.cacheWrite += num(usage.cacheWrite);
    summary.usage.totalTokens += num(usage.totalTokens);
    summary.usage.cost += num(usage.cost?.total);
  }
  return summary;
}

function classify(
  termination: TerminationEvidence | null,
  cancel: CancelIntent | null,
  summary: AssistantSummary,
): RunOutcomeKind {
  if (termination === null) return "unknown";
  const exited = termination.exitCode === "exited";
  if (exited && LAUNCH_FAILURE_STATUSES.has(termination.exitStatus)) return "launch_failed";
  if (exited && termination.exitStatus === "0" && summary.stopReason === "stop") return "succeeded";
  if (cancel !== null && cancel.requestedAt <= termination.finalizedAt) return "cancelled";
  if (termination.serviceResult === "timeout") return "timed_out";
  return "failed";
}

/**
 * Derives the caller-facing result of a run from its termination evidence,
 * cancellation intent and pi JSON-mode stdout. Pure and idempotent.
 */
export function deriveResult(input: DeriveInput): RunResult {
  const summary = summarizeEvents(input.events);
  const outcome = classify(input.termination, input.cancel, summary);
  return {
    outcome,
    partial: outcome !== "succeeded",
    text: summary.text,
    stopReason: summary.stopReason,
    error: summary.error,
    model: summary.model,
    turns: summary.turns,
    usage: summary.usage,
    ignoredLines: summary.ignoredLines,
    termination: input.termination,
    cancel: input.cancel,
  };
}
