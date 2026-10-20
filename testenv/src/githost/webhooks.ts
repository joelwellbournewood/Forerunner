/**
 * Webhook delivery: every emitted event is POSTed to each active hook of the repo that
 * subscribes to it, with GitHub's headers (`X-GitHub-Event`, `X-GitHub-Delivery`,
 * `X-Hub-Signature-256` HMAC over the raw body when the hook has a secret). Deliveries are
 * recorded on the event; `flush()` waits for every in-flight delivery so tests can assert.
 */
import { createHmac, randomUUID } from "node:crypto";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { HookRecord } from "./store.ts";
import type { HostEvent, WebhookDelivery } from "./types.ts";

const logger = log("testenv:githost:webhooks");

export function signPayload(
  secret: string,
  body: string | Uint8Array,
  algo: "sha1" | "sha256",
): string {
  return `${algo}=${createHmac(algo, secret).update(body).digest("hex")}`;
}

export class WebhookDispatcher {
  private readonly inflight = new Set<Promise<void>>();
  readonly deliveries: WebhookDelivery[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** True when `hook` wants `event`. GitHub's default subscription is `push` only. */
  static subscribes(hook: HookRecord, event: string): boolean {
    if (!hook.active) return false;
    if (event === "ping") return true;
    return hook.events.includes("*") || hook.events.includes(event);
  }

  dispatch(event: HostEvent, hooks: Iterable<HookRecord>): void {
    for (const hook of hooks) {
      if (!WebhookDispatcher.subscribes(hook, event.event)) continue;
      const delivery = this.deliver(hook, event);
      event.deliveries.push(delivery.record);
      this.deliveries.push(delivery.record);
      this.track(delivery.done);
    }
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch(() => undefined).finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
  }

  /** Resolve when every delivery started so far has finished (success or failure). */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private deliver(
    hook: HookRecord,
    event: HostEvent,
  ): { record: WebhookDelivery; done: Promise<void> } {
    const body = JSON.stringify(event.payload);
    const id = randomUUID();
    const record: WebhookDelivery = {
      id,
      hookId: hook.id,
      url: hook.url,
      event: event.event,
      action: event.action,
      status: "pending",
      responseStatus: null,
      error: null,
      signature256: hook.secret ? signPayload(hook.secret, body, "sha256") : null,
      at: this.clock.nowIso(),
    };
    const headers: Record<string, string> = {
      "Content-Type":
        hook.contentType === "form" ? "application/x-www-form-urlencoded" : "application/json",
      "User-Agent": "GitHub-Hookshot/fake-git-host",
      "X-GitHub-Event": event.event,
      "X-GitHub-Delivery": id,
      "X-GitHub-Hook-ID": String(hook.id),
      "X-GitHub-Hook-Installation-Target-Type": "repository",
    };
    if (hook.secret) {
      headers["X-Hub-Signature"] = signPayload(hook.secret, body, "sha1");
      headers["X-Hub-Signature-256"] = record.signature256 ?? "";
    }
    const sendBody = hook.contentType === "form" ? `payload=${encodeURIComponent(body)}` : body;
    const done = (async () => {
      try {
        const res = await this.fetchImpl(hook.url, {
          method: "POST",
          headers,
          body: sendBody,
          signal: AbortSignal.timeout(10_000),
        });
        record.responseStatus = res.status;
        record.status = res.ok ? "delivered" : "failed";
        hook.lastResponse = {
          code: res.status,
          status: res.ok ? "active" : "misconfigured",
          message: res.statusText,
        };
        await res.arrayBuffer().catch(() => undefined);
      } catch (e) {
        record.status = "failed";
        record.error = errorMessage(e);
        hook.lastResponse = { code: null, status: "misconfigured", message: record.error };
        logger.debug("webhook delivery failed", {
          hook: hook.id,
          event: event.event,
          error: record.error,
        });
      }
    })();
    return { record, done };
  }
}
