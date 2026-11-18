import { parse } from "smol-toml";
import type { ServiceOptions } from "./service.js";

export interface Config {
  repositories: string[];
  natsUrl: string;
  scheduling: ServiceOptions;
}
export function parseConfig(input: string): Config {
  const value = parse(input);
  const allowed = [
    "repositories",
    "nats_url",
    "poll_seconds",
    "concurrency",
    "feedback_concurrency",
    "cooldown_seconds",
    "stagger_seconds",
    "max_backoff_seconds",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("unknown configuration key");
  const repos = value.repositories;
  if (
    !Array.isArray(repos) ||
    !repos.length ||
    repos.length > 100 ||
    repos.some(
      (r) =>
        typeof r !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r),
    )
  )
    throw new Error("explicit repositories are required");
  const repositories = (repos as string[]).map((r) => r.toLowerCase());
  if (new Set(repositories).size !== repositories.length)
    throw new Error("duplicate repository");
  const number = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const n = value[key] ?? fallback;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
      throw new Error("invalid scheduling value");
    return n;
  };
  const natsUrl = value.nats_url ?? "nats://127.0.0.1:4222";
  if (typeof natsUrl !== "string" || !natsUrl.trim())
    throw new Error("invalid NATS URL");
  const pollMs = number("poll_seconds", 120, 15, 86_400) * 1000;
  const cooldownMs = number("cooldown_seconds", 15, 1, 3600) * 1000;
  const maxBackoffMs = number("max_backoff_seconds", 1800, 15, 86_400) * 1000;
  if (cooldownMs > pollMs || maxBackoffMs < pollMs)
    throw new Error("inconsistent scheduling intervals");
  return {
    repositories,
    natsUrl,
    scheduling: {
      pollMs,
      cooldownMs,
      maxBackoffMs,
      concurrency: number("concurrency", 2, 1, 8),
      feedbackConcurrency: number("feedback_concurrency", 1, 1, 4),
      staggerMs: number("stagger_seconds", 1, 0, 60) * 1000,
    },
  };
}
