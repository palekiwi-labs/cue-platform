import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const FEEDBACK_SCHEMA = "station/github-feedback@1";

export type GraphqlVars = Record<string, string | number>;
export type Graphql = (query: string, vars: GraphqlVars) => Promise<unknown>;

export interface Author {
  login: string | null;
  type: string | null;
  association: string | null;
}

export interface ThreadComment {
  id: string;
  database_id: string | null;
  author: Author;
  body: string;
  state: string | null;
  created_at: string;
  updated_at: string | null;
  last_edited_at: string | null;
  url: string | null;
  is_minimized: boolean;
  minimized_reason: string | null;
  reply_to: string | null;
  review_id: string | null;
  review_state: string | null;
  path: string | null;
  commit: string | null;
  original_commit: string | null;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  original_start_line: number | null;
  outdated: boolean;
  diff_hunk: string | null;
}

export interface ReviewThread {
  id: string;
  path: string;
  subject_type: string | null;
  diff_side: string | null;
  start_diff_side: string | null;
  line: number | null;
  start_line: number | null;
  original_line: number | null;
  original_start_line: number | null;
  is_resolved: boolean;
  is_outdated: boolean;
  is_collapsed: boolean;
  resolved_by: string | null;
  comments_total: number;
  comments: ThreadComment[];
}

export interface ConversationEntry {
  kind: "comment" | "review";
  id: string;
  database_id: string | null;
  author: Author;
  body: string;
  state: string | null;
  created_at: string;
  updated_at: string | null;
  last_edited_at: string | null;
  url: string | null;
  commit: string | null;
  is_minimized: boolean;
  minimized_reason: string | null;
}

export interface PrMeta {
  number: number;
  title: string;
  url: string | null;
  state: string | null;
  is_draft: boolean;
  author: string | null;
  head_ref: string | null;
  base_ref: string | null;
  head_sha: string;
  base_sha: string;
}

export interface FeedbackSnapshot {
  schema: typeof FEEDBACK_SCHEMA;
  fetched_at: string;
  source: "github-graphql";
  repo: string;
  pr: PrMeta;
  threads: ReviewThread[];
  conversation: ConversationEntry[];
  omitted_reviews: number;
}

const PAGE_LIMIT = 200;

const AUTHOR = "author { login __typename } authorAssociation";

const COMMENT_FIELDS = `id fullDatabaseId ${AUTHOR} body state createdAt updatedAt lastEditedAt url
  isMinimized minimizedReason replyTo { id } pullRequestReview { id state }
  path commit { oid } originalCommit { oid } line originalLine startLine originalStartLine outdated diffHunk`;

const THREAD_FIELDS = `id path subjectType diffSide startDiffSide line startLine originalLine originalStartLine
  isResolved isOutdated isCollapsed resolvedBy { login }`;

const PR_ARGS = "query($owner: String!, $name: String!, $number: Int!, $after: String)";

function prQuery(body: string): string {
  return `${PR_ARGS} { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${body} } } }`;
}

const META_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    number title url state isDraft author { login } headRefName baseRefName headRefOid baseRefOid
  } } }`;

const THREADS_QUERY = prQuery(`reviewThreads(first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { ${THREAD_FIELDS} comments(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } } }
}`);

const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread {
  comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
} } }`;

const ISSUE_COMMENTS_QUERY = prQuery(`comments(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id fullDatabaseId ${AUTHOR} body createdAt updatedAt lastEditedAt url isMinimized minimizedReason }
}`);

const REVIEWS_QUERY = prQuery(`reviews(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id fullDatabaseId ${AUTHOR} body state createdAt submittedAt updatedAt lastEditedAt url commit { oid }
    isMinimized minimizedReason }
}`);

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function idString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function oid(v: unknown): string | null {
  return str(obj(v).oid);
}

function author(o: Obj): Author {
  const a = obj(o.author);
  return { login: str(a.login), type: str(a.__typename), association: str(o.authorAssociation) };
}

interface Connection {
  nodes: unknown[];
  hasNext: boolean;
  cursor: string | null;
  total: number | null;
}

function connection(v: unknown, what: string): Connection {
  const c = obj(v);
  if (!Array.isArray(c.nodes)) throw new Error(`GitHub response has no ${what} list`);
  const page = obj(c.pageInfo);
  return { nodes: c.nodes, hasNext: page.hasNextPage === true, cursor: str(page.endCursor), total: int(c.totalCount) };
}

/** Reads every page of a connection, failing on a missing or repeated cursor instead of looping. */
export async function paginate(
  gql: Graphql,
  query: string,
  vars: GraphqlVars,
  pick: (data: unknown) => unknown,
  what: string,
  first: Connection | null = null,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const seen = new Set<string>();
  let page = first ?? connection(pick(await gql(query, vars)), what);
  for (let n = 1; ; n++) {
    out.push(...page.nodes);
    if (!page.hasNext) return out;
    if (page.cursor === null || seen.has(page.cursor)) throw new Error(`GitHub pagination for ${what} returned no new cursor`);
    if (n >= PAGE_LIMIT) throw new Error(`GitHub pagination for ${what} exceeded ${PAGE_LIMIT} pages`);
    seen.add(page.cursor);
    page = connection(pick(await gql(query, { ...vars, after: page.cursor })), what);
  }
}

function pullRequest(data: unknown): Obj {
  const pr = obj(obj(obj(data).repository).pullRequest);
  if (Object.keys(pr).length === 0) throw new Error("GitHub response has no pull request");
  return pr;
}

export function normalizeComment(raw: unknown): ThreadComment {
  const o = obj(raw);
  const review = obj(o.pullRequestReview);
  return {
    id: str(o.id) ?? "",
    database_id: idString(o.fullDatabaseId),
    author: author(o),
    body: str(o.body) ?? "",
    state: str(o.state),
    created_at: str(o.createdAt) ?? "",
    updated_at: str(o.updatedAt),
    last_edited_at: str(o.lastEditedAt),
    url: str(o.url),
    is_minimized: o.isMinimized === true,
    minimized_reason: str(o.minimizedReason),
    reply_to: str(obj(o.replyTo).id),
    review_id: str(review.id),
    review_state: str(review.state),
    path: str(o.path),
    commit: oid(o.commit),
    original_commit: oid(o.originalCommit),
    line: int(o.line),
    original_line: int(o.originalLine),
    start_line: int(o.startLine),
    original_start_line: int(o.originalStartLine),
    outdated: o.outdated === true,
    diff_hunk: str(o.diffHunk),
  };
}

export function normalizeThread(raw: unknown, comments: unknown[]): ReviewThread {
  const o = obj(raw);
  const total = int(obj(o.comments).totalCount);
  return {
    id: str(o.id) ?? "",
    path: str(o.path) ?? "",
    subject_type: str(o.subjectType),
    diff_side: str(o.diffSide),
    start_diff_side: str(o.startDiffSide),
    line: int(o.line),
    start_line: int(o.startLine),
    original_line: int(o.originalLine),
    original_start_line: int(o.originalStartLine),
    is_resolved: o.isResolved === true,
    is_outdated: o.isOutdated === true,
    is_collapsed: o.isCollapsed === true,
    resolved_by: str(obj(o.resolvedBy).login),
    comments_total: total ?? comments.length,
    comments: comments.map(normalizeComment),
  };
}

const KEPT_EMPTY_REVIEWS = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * General conversation: issue comments and review bodies. Reviews without a
 * body are dropped unless their state carries a verdict; pending reviews are
 * dropped because only their author can see them.
 */
export function normalizeConversation(issueComments: unknown[], reviews: unknown[]): {
  entries: ConversationEntry[];
  omitted: number;
} {
  const entries: ConversationEntry[] = [];
  let omitted = 0;
  for (const raw of issueComments) {
    const o = obj(raw);
    entries.push({
      kind: "comment",
      id: str(o.id) ?? "",
      database_id: idString(o.fullDatabaseId),
      author: author(o),
      body: str(o.body) ?? "",
      state: null,
      created_at: str(o.createdAt) ?? "",
      updated_at: str(o.updatedAt),
      last_edited_at: str(o.lastEditedAt),
      url: str(o.url),
      commit: null,
      is_minimized: o.isMinimized === true,
      minimized_reason: str(o.minimizedReason),
    });
  }
  for (const raw of reviews) {
    const o = obj(raw);
    const state = str(o.state);
    const body = str(o.body) ?? "";
    if (state === "PENDING" || (body.trim() === "" && !KEPT_EMPTY_REVIEWS.has(state ?? ""))) {
      omitted++;
      continue;
    }
    entries.push({
      kind: "review",
      id: str(o.id) ?? "",
      database_id: idString(o.fullDatabaseId),
      author: author(o),
      body,
      state,
      created_at: str(o.submittedAt) ?? str(o.createdAt) ?? "",
      updated_at: str(o.updatedAt),
      last_edited_at: str(o.lastEditedAt),
      url: str(o.url),
      commit: oid(o.commit),
      is_minimized: o.isMinimized === true,
      minimized_reason: str(o.minimizedReason),
    });
  }
  entries.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return { entries, omitted };
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const m = repo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m === null) throw new Error(`repository must be <owner>/<name>, got: ${repo}`);
  return { owner: m[1]!, name: m[2]! };
}

export async function fetchFeedback(
  gql: Graphql,
  repo: string,
  number: number,
  now: () => Date = () => new Date(),
): Promise<FeedbackSnapshot> {
  const vars = { ...splitRepo(repo), number };
  const meta = pullRequest(await gql(META_QUERY, vars));
  const head = str(meta.headRefOid);
  const base = str(meta.baseRefOid);
  if (head === null || base === null) throw new Error(`pull request #${number} has no head or base commit`);

  const threadNodes = await paginate(gql, THREADS_QUERY, vars, (d) => pullRequest(d).reviewThreads, "review threads");
  const threads: ReviewThread[] = [];
  for (const raw of threadNodes) {
    const o = obj(raw);
    const id = str(o.id);
    const first = connection(o.comments, "thread comments");
    const comments =
      first.hasNext && id !== null
        ? await paginate(gql, THREAD_COMMENTS_QUERY, { id }, (d) => obj(obj(d).node).comments, "thread comments", first)
        : first.nodes;
    threads.push(normalizeThread(raw, comments));
  }

  const issueComments = await paginate(gql, ISSUE_COMMENTS_QUERY, vars, (d) => pullRequest(d).comments, "comments");
  const reviews = await paginate(gql, REVIEWS_QUERY, vars, (d) => pullRequest(d).reviews, "reviews");
  const { entries, omitted } = normalizeConversation(issueComments, reviews);

  return {
    schema: FEEDBACK_SCHEMA,
    fetched_at: now().toISOString(),
    source: "github-graphql",
    repo,
    pr: {
      number: int(meta.number) ?? number,
      title: str(meta.title) ?? "",
      url: str(meta.url),
      state: str(meta.state),
      is_draft: meta.isDraft === true,
      author: str(obj(meta.author).login),
      head_ref: str(meta.headRefName),
      base_ref: str(meta.baseRefName),
      head_sha: head,
      base_sha: base,
    },
    threads,
    conversation: entries,
    omitted_reviews: omitted,
  };
}

/** Runs GraphQL through `gh api graphql`, so authentication and host follow the gh configuration. */
export function ghGraphql(cwd?: string): Graphql {
  return (query, vars) =>
    new Promise((resolve, reject) => {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
      const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
      child.on("error", (e) => reject(new Error(`gh: ${e.message}`)));
      child.on("close", (code) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          reject(new Error(`gh api graphql failed${code === 0 ? "" : ` (exit ${code})`}: ${err.trim() || "unreadable response"}`));
          return;
        }
        const errors = obj(parsed).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          const messages = errors.map((e) => str(obj(e).message) ?? JSON.stringify(e));
          reject(new Error(`GitHub GraphQL: ${messages.join("; ")}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`gh api graphql failed (exit ${code}): ${err.trim()}`));
          return;
        }
        resolve(obj(parsed).data);
      });
    });
}

export function feedbackCachePath(repo: string, pr: number): string {
  return join(homedir(), ".cache", "station", "github-feedback", `${repo.toLowerCase().replace(/\//g, "-")}-pr-${pr}.json`);
}

export function saveSnapshot(path: string, snapshot: FeedbackSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Null when no snapshot was saved; throws when one exists but is unreadable. */
export function loadSnapshot(path: string): FeedbackSnapshot | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const raw = obj(JSON.parse(text));
  if (raw.schema !== FEEDBACK_SCHEMA) throw new Error(`${path} is not a ${FEEDBACK_SCHEMA} snapshot`);
  if (!Array.isArray(raw.threads) || !Array.isArray(raw.conversation) || typeof obj(raw.pr).head_sha !== "string") {
    throw new Error(`${path} is a malformed ${FEEDBACK_SCHEMA} snapshot`);
  }
  return raw as unknown as FeedbackSnapshot;
}
