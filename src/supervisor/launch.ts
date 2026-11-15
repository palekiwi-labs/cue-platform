import { join } from "node:path";
import type { RunSpec } from "./spec";

export const DEFAULT_MODEL = "google/gemini-3.8-flash";

export const ENV_ALLOWLIST = [
  "PATH",
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "NIX_SSL_CERT_FILE",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "GH_TOKEN",
  "TYPESAFE_API_KEY",
  "CUE_NATS_URL",
  "CUE_NATS_JS_DOMAIN",
  "NIX_PATH",
  "NIX_PROFILES",
  "NIX_USER_PROFILE_DIR",
  "NIXPKGS_CONFIG",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "CUE_STORE",
];

const RUNNER_SCRIPT =
  'printf \'{"pid":%s,"startedAt":%s}\\n\' "$$" "$(date +%s%3N)" > started.json.tmp' +
  " && mv started.json.tmp started.json; " +
  'cd "$0" || { echo "runner: cannot chdir to $0" >&2; exit 200; }; exec "$@"';

export interface UnitParams {
  runId: string;
  batchId: string;
  runDir: string;
  spec: RunSpec;
  sessionId: string;
  piPath: string;
  shPath: string;
  finalizeCommand: string[];
  env: NodeJS.ProcessEnv;
}

export function unitName(runId: string): string {
  return `cue-run-${runId}.service`;
}

export function sliceName(batchId: string): string {
  return `cue-runs-${batchId}.slice`;
}

export function piArgv(params: Pick<UnitParams, "piPath" | "runDir" | "sessionId" | "spec">): string[] {
  return [
    params.piPath,
    "-p",
    "--mode",
    "json",
    "--model",
    params.spec.model ?? DEFAULT_MODEL,
    "--session-dir",
    join(params.runDir, "session"),
    "--session-id",
    params.sessionId,
    params.spec.prompt,
  ];
}

/** Builds the systemd-run argv launching one run as a transient user unit. */
export function systemdRunArgv(params: UnitParams): string[] {
  const forwarded = ENV_ALLOWLIST.filter((name) => params.env[name] !== undefined).map(
    (name) => `--setenv=${name}`,
  );
  return [
    "systemd-run",
    "--user",
    "--quiet",
    "--collect",
    "--expand-environment=no",
    `--unit=${unitName(params.runId)}`,
    `--slice=${sliceName(params.batchId)}`,
    `--working-directory=${params.runDir}`,
    ...forwarded,
    `--setenv=CUE_CONTEXT=${params.spec.context}`,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=10",
    ...(params.spec.timeoutSec !== undefined ? [`--property=RuntimeMaxSec=${params.spec.timeoutSec}`] : []),
    `--property=StandardOutput=file:${join(params.runDir, "events.jsonl")}`,
    `--property=StandardError=file:${join(params.runDir, "diagnostics.log")}`,
    `--property=ExecStopPost=${params.finalizeCommand.join(" ")}`,
    params.shPath,
    "-c",
    RUNNER_SCRIPT,
    params.spec.cwd,
    ...piArgv(params),
  ];
}
