export const SUBJECTS = {
  list: "github.api.v1.list",
  refresh: "github.api.v1.refresh",
  operation: "github.api.v1.operation",
  feedback: "github.api.v1.feedback",
  changed: "github.evt.v1.changed",
  completed: "github.evt.v1.completed",
  feedbackChanged: "github.evt.v1.feedback",
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
  pausedUntil: number | null;
}

export interface RefreshRequest {
  repo?: string;
  number?: number;
}
export interface RefreshResult {
  operationId: string;
}
export interface OperationRequest {
  operationId: string;
}
export interface RefreshOutcome {
  state: "pending" | "success" | "error";
  revision?: number;
  changed?: boolean;
  error?: string;
}
export interface RefreshOperation {
  operationId: string;
  createdAt: number;
  completedAt: number | null;
  state: "pending" | "complete";
  repositories: Record<string, RefreshOutcome>;
  feedback?: RefreshOutcome & { repo: string; number: number };
  pausedUntil: number | null;
}

export interface FeedbackAuthor {
  login: string | null;
  type: string | null;
  association: string | null;
}

export interface FeedbackThreadComment {
  id: string;
  databaseId: string | null;
  author: FeedbackAuthor;
  body: string;
  state: string | null;
  createdAt: string;
  updatedAt: string | null;
  lastEditedAt: string | null;
  url: string | null;
  isMinimized: boolean;
  minimizedReason: string | null;
  replyTo: string | null;
  reviewId: string | null;
  reviewState: string | null;
  path: string | null;
  commit: string | null;
  originalCommit: string | null;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  outdated: boolean;
  diffHunk?: string | null;
}

export interface FeedbackThread {
  id: string;
  path: string;
  subjectType: string | null;
  diffSide: string | null;
  startDiffSide: string | null;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  resolvedBy: string | null;
  commentsTotal: number;
  diffHunk: string | null;
  comments: FeedbackThreadComment[];
}

export interface FeedbackConversationEntry {
  kind: "comment" | "review";
  id: string;
  databaseId: string | null;
  author: FeedbackAuthor;
  body: string;
  state: string | null;
  createdAt: string;
  updatedAt: string | null;
  lastEditedAt: string | null;
  url: string | null;
  commit: string | null;
  isMinimized: boolean;
  minimizedReason: string | null;
}

export interface FeedbackPr {
  number: number;
  title: string;
  url: string | null;
  state: string | null;
  isDraft: boolean;
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string;
  baseSha: string;
}

export interface PrFeedback {
  repo: string;
  pr: FeedbackPr;
  threads: FeedbackThread[];
  conversation: FeedbackConversationEntry[];
  omittedReviews: number;
}

export interface FeedbackRequest {
  repo: string;
  number: number;
}
export interface FeedbackResult {
  storeId: string;
  repo: string;
  number: number;
  revision: number;
  fetchedAt: number | null;
  attemptedAt: number | null;
  sourceUpdatedAt: string | null;
  failures: number;
  error: string | null;
  pausedUntil: number | null;
  feedback: PrFeedback | null;
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
export interface NewComment {
  id: string;
  kind: "thread" | "comment" | "review";
  author: string | null;
  createdAt: string;
  threadId?: string;
}
export interface FeedbackEvent {
  storeId: string;
  repo: string;
  number: number;
  revision: number;
  newComments: NewComment[];
}
