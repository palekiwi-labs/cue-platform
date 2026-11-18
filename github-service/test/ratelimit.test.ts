import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIncluded, rateLimitUntil } from "../src/collector.js";

test("rate limit detection covers headers, GraphQL types and gh stderr", () => {
  const now = 1_000_000;
  const at = (stdout: string, stderr = "") =>
    rateLimitUntil(parseIncluded(stdout), stderr, now);
  assert.equal(
    at(
      'HTTP/1.1 429 Too Many Requests\r\nretry-after: Thu, 01 Jan 1970 00:20:00 GMT\r\n\r\n{"message":"x"}',
    ),
    1_200_000,
  );
  assert.equal(at("HTTP/2.0 429 Too Many Requests\n\r\n"), now + 60_000);
  assert.equal(
    at('HTTP/2.0 200 OK\n\r\n{"errors":[{"type":"RATE_LIMITED"}]}'),
    now + 300_000,
  );
  assert.equal(
    at("", "gh: API rate limit exceeded for user ID 1. (HTTP 403)"),
    now + 300_000,
  );
  assert.equal(
    at(
      "HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 999999999\n\r\n",
    ),
    now + 7_200_000,
  );
  assert.equal(at("HTTP/2.0 403 Forbidden\nRetry-After: 0\n\r\n"), now + 1000);
  assert.equal(
    at('HTTP/2.0 200 OK\n\r\n{"errors":[{"type":"NOT_FOUND"}]}'),
    null,
  );
  assert.equal(at("", "gh: Could not resolve to a PullRequest"), null);
  assert.deepEqual(parseIncluded('{"data":{}}').body, '{"data":{}}');
});
