import { data, ghGraphql, object, text, type Graphql } from "./collector.js";
import type {
  FeedbackAuthor,
  FeedbackConversationEntry,
  FeedbackThread,
  FeedbackThreadComment,
  PrFeedback,
} from "./protocol.js";

type Obj = Record<string, unknown>;
type Vars = Record<string, string | number>;

const PAGE_LIMIT = 200;
const AUTHOR = "author { login __typename } authorAssociation";
const COMMENT_FIELDS = `id fullDatabaseId ${AUTHOR} body state createdAt updatedAt lastEditedAt url
  isMinimized minimizedReason replyTo { id } pullRequestReview { id state }
  path commit { oid } originalCommit { oid } line originalLine startLine originalStartLine outdated diffHunk`;
const THREAD_FIELDS = `id path subjectType diffSide startDiffSide line startLine originalLine originalStartLine
  isResolved isOutdated isCollapsed resolvedBy { login }`;
const PR_ARGS =
  "query($owner:String!,$name:String!,$number:Int!,$after:String)";

function prQuery(body: string): string {
  return `${PR_ARGS} { repository(owner:$owner,name:$name) { pullRequest(number:$number) { ${body} } } }`;
}

export const META_QUERY = `query($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    number title url state isDraft author { login } headRefName baseRefName headRefOid baseRefOid
  } } }`;
export const THREADS_QUERY = prQuery(`reviewThreads(first:50,after:$after) {
  pageInfo { hasNextPage endCursor }
  nodes { ${THREAD_FIELDS} comments(first:100) { totalCount pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } } }
}`);
export const THREAD_COMMENTS_QUERY = `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequestReviewThread {
  comments(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
} } }`;
export const COMMENTS_QUERY = prQuery(`comments(first:100,after:$after) {
  pageInfo { hasNextPage endCursor }
  nodes { id fullDatabaseId ${AUTHOR} body createdAt updatedAt lastEditedAt url isMinimized minimizedReason }
}`);
export const REVIEWS_QUERY = prQuery(`reviews(first:100,after:$after) {
  pageInfo { hasNextPage endCursor }
  nodes { id fullDatabaseId ${AUTHOR} body state createdAt submittedAt updatedAt lastEditedAt url commit { oid }
    isMinimized minimizedReason }
}`);

function obj(value: unknown): Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
function idString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function oid(value: unknown): string | null {
  return str(obj(value).oid);
}
function author(o: Obj): FeedbackAuthor {
  const a = obj(o.author);
  return {
    login: str(a.login),
    type: str(a.__typename),
    association: str(o.authorAssociation),
  };
}

interface Connection {
  nodes: Obj[];
  cursor: string | null;
  hasNext: boolean;
}

function connection(value: unknown): Connection {
  const c = object(value);
  const info = object(c.pageInfo);
  if (!Array.isArray(c.nodes) || typeof info.hasNextPage !== "boolean")
    throw new Error("Invalid connection");
  return {
    nodes: c.nodes.map(object),
    hasNext: info.hasNextPage,
    cursor: str(info.endCursor),
  };
}

async function paginate(
  graphql: Graphql,
  query: string,
  vars: Vars,
  pick: (data: Record<string, any>) => unknown,
  signal: AbortSignal | undefined,
  first?: Connection,
): Promise<Obj[]> {
  const out: Obj[] = [];
  const seen = new Set<string>();
  let page =
    first ?? connection(pick(data(await graphql(query, vars, signal))));
  for (let n = 1; ; n++) {
    out.push(...page.nodes);
    if (!page.hasNext) return out;
    if (page.cursor === null || seen.has(page.cursor))
      throw new Error("Repeated cursor");
    if (n >= PAGE_LIMIT) throw new Error("Too many pages");
    seen.add(page.cursor);
    page = connection(
      pick(data(await graphql(query, { ...vars, after: page.cursor }, signal))),
    );
  }
}

function pullRequest(result: Record<string, any>): Obj {
  return object(object(result.repository).pullRequest);
}

function normalizeComment(raw: Obj): FeedbackThreadComment {
  const review = obj(raw.pullRequestReview);
  return {
    id: text(raw.id),
    databaseId: idString(raw.fullDatabaseId),
    author: author(raw),
    body: str(raw.body) ?? "",
    state: str(raw.state),
    createdAt: str(raw.createdAt) ?? "",
    updatedAt: str(raw.updatedAt),
    lastEditedAt: str(raw.lastEditedAt),
    url: str(raw.url),
    isMinimized: raw.isMinimized === true,
    minimizedReason: str(raw.minimizedReason),
    replyTo: str(obj(raw.replyTo).id),
    reviewId: str(review.id),
    reviewState: str(review.state),
    path: str(raw.path),
    commit: oid(raw.commit),
    originalCommit: oid(raw.originalCommit),
    line: int(raw.line),
    originalLine: int(raw.originalLine),
    startLine: int(raw.startLine),
    originalStartLine: int(raw.originalStartLine),
    outdated: raw.outdated === true,
  };
}

export function normalizeThread(raw: Obj, comments: Obj[]): FeedbackThread {
  const diffHunk = comments.length ? str(comments[0].diffHunk) : null;
  return {
    id: text(raw.id),
    path: str(raw.path) ?? "",
    subjectType: str(raw.subjectType),
    diffSide: str(raw.diffSide),
    startDiffSide: str(raw.startDiffSide),
    line: int(raw.line),
    startLine: int(raw.startLine),
    originalLine: int(raw.originalLine),
    originalStartLine: int(raw.originalStartLine),
    isResolved: raw.isResolved === true,
    isOutdated: raw.isOutdated === true,
    isCollapsed: raw.isCollapsed === true,
    resolvedBy: str(obj(raw.resolvedBy).login),
    commentsTotal: int(obj(raw.comments).totalCount) ?? comments.length,
    diffHunk,
    comments: comments.map((c) => {
      const comment = normalizeComment(c);
      const hunk = str(c.diffHunk);
      return hunk === diffHunk ? comment : { ...comment, diffHunk: hunk };
    }),
  };
}

const KEPT_EMPTY_REVIEWS = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);

export function normalizeConversation(
  comments: Obj[],
  reviews: Obj[],
): { entries: FeedbackConversationEntry[]; omitted: number } {
  const entries: FeedbackConversationEntry[] = comments.map((o) => ({
    kind: "comment",
    id: text(o.id),
    databaseId: idString(o.fullDatabaseId),
    author: author(o),
    body: str(o.body) ?? "",
    state: null,
    createdAt: str(o.createdAt) ?? "",
    updatedAt: str(o.updatedAt),
    lastEditedAt: str(o.lastEditedAt),
    url: str(o.url),
    commit: null,
    isMinimized: o.isMinimized === true,
    minimizedReason: str(o.minimizedReason),
  }));
  let omitted = 0;
  for (const o of reviews) {
    const state = str(o.state);
    const body = str(o.body) ?? "";
    if (
      state === "PENDING" ||
      (body.trim() === "" && !KEPT_EMPTY_REVIEWS.has(state ?? ""))
    ) {
      omitted++;
      continue;
    }
    entries.push({
      kind: "review",
      id: text(o.id),
      databaseId: idString(o.fullDatabaseId),
      author: author(o),
      body,
      state,
      createdAt: str(o.submittedAt) ?? str(o.createdAt) ?? "",
      updatedAt: str(o.updatedAt),
      lastEditedAt: str(o.lastEditedAt),
      url: str(o.url),
      commit: oid(o.commit),
      isMinimized: o.isMinimized === true,
      minimizedReason: str(o.minimizedReason),
    });
  }
  entries.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  return { entries, omitted };
}

export async function collectFeedback(
  repo: string,
  number: number,
  graphql: Graphql = ghGraphql,
  signal?: AbortSignal,
): Promise<PrFeedback> {
  const [owner, name] = repo.split("/");
  const vars: Vars = { owner, name, number };
  const meta = pullRequest(data(await graphql(META_QUERY, vars, signal)));
  if (meta.number !== number) throw new Error("Unexpected pull request");
  const headSha = text(meta.headRefOid);
  const baseSha = text(meta.baseRefOid);
  const threadNodes = await paginate(
    graphql,
    THREADS_QUERY,
    vars,
    (d) => pullRequest(d).reviewThreads,
    signal,
  );
  const threads: FeedbackThread[] = [];
  for (const raw of threadNodes) {
    const first = connection(raw.comments);
    const comments = first.hasNext
      ? await paginate(
          graphql,
          THREAD_COMMENTS_QUERY,
          { id: text(raw.id), credentialOwner: owner },
          (d) => object(d.node).comments,
          signal,
          first,
        )
      : first.nodes;
    threads.push(normalizeThread(raw, comments));
  }
  const comments = await paginate(
    graphql,
    COMMENTS_QUERY,
    vars,
    (d) => pullRequest(d).comments,
    signal,
  );
  const reviews = await paginate(
    graphql,
    REVIEWS_QUERY,
    vars,
    (d) => pullRequest(d).reviews,
    signal,
  );
  const { entries, omitted } = normalizeConversation(comments, reviews);
  return {
    repo,
    pr: {
      number,
      title: str(meta.title) ?? "",
      url: str(meta.url),
      state: str(meta.state),
      isDraft: meta.isDraft === true,
      author: str(obj(meta.author).login),
      headRef: str(meta.headRefName),
      baseRef: str(meta.baseRefName),
      headSha,
      baseSha,
    },
    threads,
    conversation: entries,
    omittedReviews: omitted,
  };
}
