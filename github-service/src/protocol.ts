export const SUBJECTS = {
  list: "github.api.v1.list",
  refresh: "github.api.v1.refresh",
  operation: "github.api.v1.operation",
  changed: "github.evt.v1.changed",
  completed: "github.evt.v1.completed",
} as const;

export type Checks =
  | "SUCCESS"
  | "FAILURE"
  | "ERROR"
  | "PENDING"
  | "EXPECTED"
  | null;
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

export interface Pr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  reviewDecision: ReviewDecision;
  checks: Checks;
  baseRef: string;
  headRef: string;
  defaultBranch: string;
  reviewers: string[];
  labels: string[];
}

export interface RepositorySnapshot {
  repo: string;
  revision: number;
  viewer: string | null;
  fetchedAt: number | null;
  attemptedAt: number | null;
  failures: number;
  error: string | null;
}

export interface ListRequest {
  repo?: string;
  offset?: number;
  limit?: number;
  storeId?: string;
  revisions?: Record<string, number>;
}

export interface ListResult {
  storeId: string;
  repositories: RepositorySnapshot[];
  prs: Pr[];
  total: number;
  nextOffset: number | null;
}

export interface RefreshRequest {
  repo?: string;
}
export interface RefreshResult {
  operationId: string;
}
export interface OperationRequest {
  operationId: string;
}
export interface RefreshOperation {
  operationId: string;
  createdAt: number;
  completedAt: number | null;
  state: "pending" | "complete";
  repositories: Record<
    string,
    {
      state: "pending" | "success" | "error";
      revision?: number;
      changed?: boolean;
      error?: string;
    }
  >;
}

export type Reply<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code:
          | "invalid_request"
          | "not_found"
          | "conflict"
          | "busy"
          | "unavailable"
          | "response_too_large";
        message: string;
      };
    };
export interface ChangedEvent {
  storeId: string;
  repo: string;
  revision: number;
}
export interface CompletedEvent {
  operationId: string;
}
