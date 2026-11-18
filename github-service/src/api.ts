import type {
  FeedbackResult,
  ListRequest,
  ListResult,
  Reply,
} from "./protocol.js";
import { GithubService, ServiceError } from "./service.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ServiceError("invalid_request", "expected JSON object");
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new ServiceError("invalid_request", "invalid pagination integer");
  return value;
}
function repo(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ServiceError("invalid_request", "repo must be a string");
  return value;
}

export function list(service: GithubService, request: ListRequest): ListResult {
  const repos = service.select(repo(request.repo));
  const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(request.limit, 100, 1, 100);
  if (
    request.storeId !== undefined &&
    request.storeId !== service.store.storeId
  )
    throw new ServiceError("conflict", "snapshot store identity changed");
  const snapshots = repos.map((r) => service.store.read(r));
  if (request.revisions !== undefined) {
    const revisions = object(request.revisions);
    if (snapshots.some(({ snapshot: s }) => revisions[s.repo] !== s.revision))
      throw new ServiceError(
        "conflict",
        "snapshot revision changed; restart pagination",
      );
  }
  const prs = snapshots.flatMap((s) => s.prs);
  return {
    storeId: service.store.storeId,
    repositories: snapshots.map((s) => s.snapshot),
    prs: prs.slice(offset, offset + limit),
    total: prs.length,
    nextOffset: offset + limit < prs.length ? offset + limit : null,
    pausedUntil: service.paused(),
  };
}

function prNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ServiceError("invalid_request", "number must be a PR number");
  return value;
}

export function feedback(
  service: GithubService,
  request: Record<string, unknown>,
): FeedbackResult {
  const name = repo(request.repo);
  if (name === undefined)
    throw new ServiceError("invalid_request", "repo is required");
  const number = prNumber(request.number);
  service.tracked(name, number);
  return {
    storeId: service.store.storeId,
    repo: name,
    number,
    ...service.store.readFeedback(name, number),
    pausedUntil: service.paused(),
  };
}

export function apiReply(
  service: GithubService,
  operation: string,
  input: unknown,
): Reply<unknown> {
  try {
    const request = object(input);
    if (operation === "list") return { ok: true, data: list(service, request) };
    if (operation === "refresh")
      return {
        ok: true,
        data: service.refresh(
          repo(request.repo),
          request.number === undefined ? undefined : prNumber(request.number),
        ),
      };
    if (operation === "feedback")
      return { ok: true, data: feedback(service, request) };
    if (operation === "operation") {
      if (
        typeof request.operationId !== "string" ||
        request.operationId.length > 100
      )
        throw new ServiceError(
          "invalid_request",
          "operationId must be a string",
        );
      return { ok: true, data: service.operation(request.operationId) };
    }
    throw new ServiceError("invalid_request", "unknown operation");
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof ServiceError ? error.code : "unavailable",
        message:
          error instanceof ServiceError
            ? error.message
            : "snapshot service unavailable",
      },
    };
  }
}
