import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { API_PREFIX, HEARTBEAT_BUCKET, HEARTBEAT_KEY, HEARTBEAT_TTL_MS, apiReply } from "./api";
import type { LaunchEnvironment } from "./run";

export async function serveNats(env: LaunchEnvironment, signal: AbortSignal): Promise<void> {
  const nc = await connect({
    servers: env.env.CUE_NATS_URL?.trim() || "nats://127.0.0.1:4222",
    name: "cue-supervisor",
    timeout: 2_000,
    reconnect: false,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => { void nc.close(); };
  signal.addEventListener("abort", close, { once: true });
  try {
    const domain = env.env.CUE_NATS_JS_DOMAIN === undefined ? "pale" : env.env.CUE_NATS_JS_DOMAIN.trim();
    const kv = await new Kvm(jetstream(nc, domain ? { domain } : {})).create(HEARTBEAT_BUCKET, {
      history: 1, ttl: HEARTBEAT_TTL_MS,
    });
    const sub = nc.subscribe(`${API_PREFIX}.*`);
    const beat = async () => {
      await kv.put(HEARTBEAT_KEY, JSON.stringify({ v: 1, updatedAt: Date.now(), api: API_PREFIX }));
    };
    await nc.flush();
    await beat();
    timer = setInterval(() => { void beat().catch(close); }, 5_000);
    if (signal.aborted) close();
    for await (const msg of sub) {
      if (!msg.reply) continue;
      let reply: unknown;
      try {
        reply = apiReply(msg.subject.slice(API_PREFIX.length + 1), msg.json(), env);
      } catch {
        reply = { ok: false, error: { code: "invalid_request", message: "invalid JSON" } };
      }
      const encoded = JSON.stringify(reply);
      msg.respond(Buffer.byteLength(encoded) <= (nc.info?.max_payload ?? 1_048_576) ? encoded :
        JSON.stringify({ ok: false, error: { code: "response_too_large", message: "result exceeds NATS max_payload; read authoritative run files" } }));
    }
    if (!signal.aborted) throw new Error("supervisor NATS connection closed");
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", close);
    await nc.close();
  }
}
