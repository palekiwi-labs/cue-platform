import { connect } from "@nats-io/transport-node";
import { setTimeout as sleep } from "node:timers/promises";
import { apiReply } from "./api.js";
import { SUBJECTS } from "./protocol.js";
import type { GithubService } from "./service.js";

export async function serveNats(
  service: GithubService,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  let delay = 1_000;
  while (!signal.aborted) {
    try {
      const nc = await connect({
        servers: url,
        name: "cue-github",
        reconnect: false,
        timeout: 2_000,
      });
      const close = () => {
        void nc.close();
      };
      signal.addEventListener("abort", close, { once: true });
      const remove = service.onEvent((event, payload) => {
        if (!nc.isClosed())
          nc.publish(SUBJECTS[event], JSON.stringify(payload));
      });
      try {
        if (signal.aborted) {
          await nc.close();
          return;
        }
        const sub = nc.subscribe("github.api.v1.*");
        await nc.flush();
        delay = 1_000;
        for await (const msg of sub) {
          if (!msg.reply) continue;
          let reply: unknown;
          try {
            reply =
              msg.data.length > 16_384
                ? {
                    ok: false,
                    error: {
                      code: "invalid_request",
                      message: "request too large",
                    },
                  }
                : apiReply(
                    service,
                    msg.subject.slice("github.api.v1.".length),
                    msg.json(),
                  );
          } catch {
            reply = {
              ok: false,
              error: { code: "invalid_request", message: "invalid JSON" },
            };
          }
          const encoded = JSON.stringify(reply);
          msg.respond(
            Buffer.byteLength(encoded) <= (nc.info?.max_payload ?? 1_048_576)
              ? encoded
              : JSON.stringify({
                  ok: false,
                  error: {
                    code: "response_too_large",
                    message: "reduce list limit",
                  },
                }),
          );
        }
      } finally {
        remove();
        signal.removeEventListener("abort", close);
        await nc.close();
      }
    } catch {
      if (signal.aborted) return;
    }
    if (!signal.aborted) {
      await sleep(delay, undefined, { signal }).catch(() => {});
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
