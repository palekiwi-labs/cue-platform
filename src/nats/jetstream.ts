import { jetstream, jetstreamManager, DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream"
import { Kvm, type KV } from "@nats-io/kv"
import type { NatsConnection } from "@nats-io/transport-node"
import { EVENT_STREAM, EVENT_SUBJECT_ROOT, MAX_MSG_BYTES, REGISTRY_BUCKET } from "./events"

export const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const EVENT_MAX_BYTES = 512 * 1024 * 1024
export const EVENT_DUPLICATE_WINDOW_MS = 2 * 60 * 1000
export const REGISTRY_TTL_MS = 90 * 1000
export const REGISTRY_MARKER_TTL_MS = 60 * 1000

const NS_PER_MS = 1_000_000

function jsOpts(domain: string | undefined) {
  return domain ? { domain } : {}
}

/** Create the event stream unless it exists. */
export async function ensureEventStream(nc: NatsConnection, domain: string | undefined): Promise<void> {
  const jsm = await jetstreamManager(nc, jsOpts(domain))
  try {
    await jsm.streams.info(EVENT_STREAM)
    return
  } catch {
  }
  await jsm.streams.add({
    name: EVENT_STREAM,
    subjects: [`${EVENT_SUBJECT_ROOT}.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: EVENT_MAX_AGE_MS * NS_PER_MS,
    max_bytes: EVENT_MAX_BYTES,
    max_msg_size: MAX_MSG_BYTES,
    duplicate_window: EVENT_DUPLICATE_WINDOW_MS * NS_PER_MS,
  })
}

/** Open the registry bucket, creating it with TTL and delete markers when missing. */
export async function ensureRegistry(nc: NatsConnection, domain: string | undefined): Promise<KV> {
  const kvm = new Kvm(jetstream(nc, jsOpts(domain)))
  return kvm.create(REGISTRY_BUCKET, {
    history: 1,
    ttl: REGISTRY_TTL_MS,
    markerTTL: REGISTRY_MARKER_TTL_MS,
    storage: StorageType.File,
  })
}

/** Open the registry bucket, failing when it does not exist. */
export async function openRegistry(nc: NatsConnection, domain: string | undefined): Promise<KV> {
  const kvm = new Kvm(jetstream(nc, jsOpts(domain)))
  const kv = await kvm.open(REGISTRY_BUCKET)
  await kv.status()
  return kv
}

export async function ensureInfra(nc: NatsConnection, domain: string | undefined): Promise<void> {
  await ensureEventStream(nc, domain)
  await ensureRegistry(nc, domain)
}
