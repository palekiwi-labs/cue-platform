import { connect, createInbox, type NatsConnection } from "@nats-io/transport-node";
import { type GitEvent, parseEvent } from "./activity.js";

export const ACTIVITY_STREAM = "GIT_ACTIVITY";
const DOMAIN = "pale";
const BACKFILL_MS = 24 * 60 * 60 * 1000;

export interface ActivityFeed {
  close(): Promise<void>;
}

export interface FeedHandlers {
  onEvent(e: GitEvent): void;
  onError(text: string): void;
}

/**
 * Replays the last day of GIT_ACTIVITY and keeps following it through an
 * ephemeral, unacknowledged push consumer created over the JetStream API.
 */
export async function followActivity(h: FeedHandlers, now = Date.now()): Promise<ActivityFeed> {
  const nc: NatsConnection = await connect({
    servers: process.env.CUE_NATS_URL?.trim() || "nats://127.0.0.1:4222",
    name: "station-activity",
    timeout: 2_000,
  });
  const inbox = createInbox();
  const decoder = new TextDecoder();
  const sub = nc.subscribe(inbox, {
    callback: (err, msg) => {
      if (err !== null) return h.onError(err.message);
      if (msg.data.length === 0) return;
      const e = parseEvent(decoder.decode(msg.data));
      if (e !== null) h.onEvent(e);
    },
  });
  const config = {
    deliver_subject: inbox,
    deliver_policy: "by_start_time",
    opt_start_time: new Date(now - BACKFILL_MS).toISOString(),
    ack_policy: "none",
    replay_policy: "instant",
    inactive_threshold: 60_000_000_000,
    mem_storage: true,
    num_replicas: 1,
  };
  try {
    const reply = await nc.request(
      `$JS.${DOMAIN}.API.CONSUMER.CREATE.${ACTIVITY_STREAM}`,
      JSON.stringify({ stream_name: ACTIVITY_STREAM, config }),
      { timeout: 5_000 },
    );
    const body = JSON.parse(decoder.decode(reply.data)) as { error?: { description?: string } };
    if (body.error !== undefined) throw new Error(body.error.description ?? "consumer create failed");
  } catch (e) {
    sub.unsubscribe();
    await nc.close();
    throw new Error(`${ACTIVITY_STREAM}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    close: async () => {
      sub.unsubscribe();
      await nc.close();
    },
  };
}
