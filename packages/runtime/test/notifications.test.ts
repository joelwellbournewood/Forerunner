import { afterEach, describe, expect, it } from "vitest";
import {
  bindProducers,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationRecord,
  URGENT_KINDS,
  urgencyOf,
} from "../src/notifications/index.ts";
import { fail, note, sessionFor, settle, type World, world } from "./notifications-helpers.ts";

// Europe/Zurich is CEST (UTC+2) on these dates: 21:00Z = 23:00 local, 05:00Z = 07:00 local.
const NIGHT = "2026-10-20T21:00:00Z";
const QUIET = { start: "22:00", end: "07:00" };

describe("notifier", () => {
  let w: World;
  afterEach(async () => {
    await w.close();
  });

  it("routing matrix: every kind reaches the first configured channel outside quiet hours", async () => {
    w = await world();
    const outcomes: Record<string, string> = {};
    for (const kind of NOTIFICATION_KINDS) {
      const r = await w.notifier.notify(note(w.humanId, { kind, dedupeKey: `m:${kind}` }));
      outcomes[kind] = `${r.outcome}/${r.urgency}/${r.deliveries.map((d) => d.channel).join(",")}`;
      expect(r.deliveries[0]?.status).toBe("delivered");
    }
    expect(w.channels.desktop.sent).toHaveLength(NOTIFICATION_KINDS.length);
    expect(w.channels.email.sent).toHaveLength(0);
    for (const kind of NOTIFICATION_KINDS) {
      const urgency = URGENT_KINDS.has(kind) ? "urgent" : urgencyOf({ kind });
      expect(outcomes[kind]).toBe(`delivered/${urgency}/desktop`);
    }
    expect([...URGENT_KINDS].sort()).toEqual([
      "budget_stop",
      "injection_flagged",
      "kill_switch",
      "request_blocking",
    ]);
  });

  it("per-kind channel lists route only to those channels; an empty list disables the kind", async () => {
    w = await world({
      prefs: {
        channels: {
          session_ended: ["email"],
          critic_verdict: [],
          budget_stop: ["telegram", "email"],
        },
        telegram_chat_id: "4242",
      },
    });
    w.channels.telegram.answer(fail("telegram api 400: chat not found", false));
    const ended = await w.notifier.notify(note(w.humanId));
    expect(ended.outcome).toBe("delivered");
    expect(ended.deliveries.map((d) => d.channel)).toEqual(["email"]);
    expect(w.channels.desktop.sent).toHaveLength(0);

    const verdict = await w.notifier.notify(note(w.humanId, { kind: "critic_verdict" }));
    expect(verdict.outcome).toBe("no_channel");
    expect(verdict.deliveries).toEqual([]);

    const budget = await w.notifier.notify(note(w.humanId, { kind: "budget_stop" }));
    expect(budget.outcome).toBe("delivered");
    expect(budget.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      "telegram:unavailable",
      "email:delivered",
    ]);
  });

  it("notify_channel puts the preferred channel first; 'push' means desktop first", async () => {
    w = await world({ prefs: { notify_channel: "email" } });
    const r = await w.notifier.notify(note(w.humanId));
    expect(r.deliveries.map((d) => d.channel)).toEqual(["email"]);
    await w.notifier.setPrefs(w.humanId, { notify_channel: "push" });
    const r2 = await w.notifier.notify(note(w.humanId, { dedupeKey: "k2" }));
    expect(r2.deliveries.map((d) => d.channel)).toEqual(["desktop"]);
    // Channels that are not configured are skipped with the reason, never attempted.
    await w.notifier.setPrefs(w.humanId, { notify_channel: "telegram" });
    const r3 = await w.notifier.notify(note(w.humanId, { dedupeKey: "k3" }));
    expect(r3.deliveries.map((d) => `${d.channel}:${d.status}:${d.attempts}`)).toEqual([
      "telegram:skipped:0",
      "desktop:delivered:1",
    ]);
    expect(w.channels.telegram.sent).toHaveLength(0);
  });

  it("quiet hours hold normal notifications and tick() flushes them when the window ends", async () => {
    w = await world({ start: NIGHT, prefs: { quiet_hours: QUIET } });
    const r = await w.notifier.notify(note(w.humanId));
    expect(r.outcome).toBe("held");
    expect(r.heldFor).toBe("quiet_hours");
    expect(w.channels.desktop.sent).toHaveLength(0);
    expect(w.notifier.pending(w.humanId).held).toHaveLength(1);
    expect(w.notifier.recent({ humanId: w.humanId })).toHaveLength(0);

    await w.notifier.tick();
    expect(r.outcome).toBe("held");
    await w.clock.set("2026-10-21T04:59:00Z"); // 06:59 local
    await w.notifier.tick();
    expect(r.outcome).toBe("held");
    await w.clock.set("2026-10-21T05:00:00Z"); // 07:00 local: the window ended
    await w.notifier.tick();
    expect(r.outcome).toBe("delivered");
    expect(r.heldFor).toBeNull();
    expect(r.resolvedAt).toBe("2026-10-21T05:00:00.000Z");
    expect(w.channels.desktop.sent).toHaveLength(1);
    expect(w.notifier.pending(w.humanId).held).toHaveLength(0);
    expect(w.notifier.recent({ humanId: w.humanId }).map((x) => x.id)).toEqual([r.id]);
  });

  it("start() ticks on the clock and flushes the queue at the window end by itself", async () => {
    w = await world({ start: NIGHT, prefs: { quiet_hours: QUIET } });
    const stop = w.notifier.start(60_000);
    const r = await w.notifier.notify(note(w.humanId));
    expect(r.outcome).toBe("held");
    await w.clock.set("2026-10-21T04:30:00Z");
    expect(r.outcome).toBe("held");
    await w.clock.set("2026-10-21T05:01:00Z");
    expect(r.outcome).toBe("delivered");
    stop();
    expect(w.clock.pendingTimers()).toBe(0);
  });

  it("urgent kinds go through during quiet hours; the quiet window honours the human's time zone", async () => {
    w = await world({ start: NIGHT, prefs: { quiet_hours: QUIET } });
    for (const kind of ["kill_switch", "injection_flagged", "budget_stop", "request_blocking"]) {
      const r = await w.notifier.notify(note(w.humanId, { kind: kind as NotificationKind }));
      expect(r.outcome, kind).toBe("delivered");
      expect(r.urgency, kind).toBe("urgent");
    }
    const normal = await w.notifier.notify(note(w.humanId, { kind: "request_opened" }));
    expect(normal.outcome).toBe("held");
    // The same instant is 17:00 in New York: not quiet there.
    await w.notifier.setPrefs(w.humanId, { timezone: "America/New_York" });
    const ny = await w.notifier.notify(note(w.humanId, { dedupeKey: "ny" }));
    expect(ny.outcome).toBe("delivered");
  });

  it("a producer can raise urgency but never lower it", async () => {
    expect(urgencyOf({ kind: "critic_verdict" })).toBe("info");
    expect(urgencyOf({ kind: "critic_verdict", urgency: "normal" })).toBe("normal");
    expect(urgencyOf({ kind: "session_ended", urgency: "info" })).toBe("normal");
    expect(urgencyOf({ kind: "kill_switch", urgency: "info" })).toBe("urgent");
    w = await world({ start: NIGHT, prefs: { quiet_hours: QUIET } });
    const raised = await w.notifier.notify(
      note(w.humanId, { kind: "critic_verdict", urgency: "urgent" }),
    );
    expect(raised.outcome).toBe("delivered");
    const lowered = await w.notifier.notify(note(w.humanId, { urgency: "info" }));
    expect(lowered.urgency).toBe("normal");
    expect(lowered.outcome).toBe("held");
  });

  it("dedupes by key within the window and sends again after it", async () => {
    w = await world({ dedupeWindowMs: 60_000 });
    const first = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-1" }));
    const second = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-1" }));
    expect(first.outcome).toBe("delivered");
    expect(second.outcome).toBe("deduped");
    expect(second.deliveries).toEqual([]);
    expect(w.channels.desktop.sent).toHaveLength(1);
    // A different key is a different notification.
    const other = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-2" }));
    expect(other.outcome).toBe("delivered");
    await w.clock.advance(60_001);
    const again = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-1" }));
    expect(again.outcome).toBe("delivered");
    expect(w.channels.desktop.sent).toHaveLength(3);
    expect(w.notifier.recent({ humanId: w.humanId }).map((r) => r.outcome)).toEqual([
      "delivered",
      "delivered",
      "deduped",
      "delivered",
    ]);
  });

  it("a notification that was not delivered does not occupy the dedupe window", async () => {
    w = await world({ dedupeWindowMs: 60_000, prefs: { channels: { session_ended: [] } } });
    // Nothing to try: the producer may send again once a channel is configured.
    const none = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-1" }));
    expect(none.outcome).toBe("no_channel");
    await w.notifier.setPrefs(w.humanId, { channels: { session_ended: ["desktop"] } });
    const sent = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-1" }));
    expect(sent.outcome).toBe("delivered");
    // Every tried channel failed: the next send of the same key is tried again, not deduped.
    w.channels.desktop.answer(fail("socket closed", false));
    const failed = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-2" }));
    expect(failed.outcome).toBe("failed");
    const retried = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-2" }));
    expect(retried.outcome).toBe("delivered");
    // A delivered one occupies the window as before.
    const dup = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-2" }));
    expect(dup.outcome).toBe("deduped");
    expect(w.channels.desktop.sent).toHaveLength(3);
    // A held one occupies it too: the human will get it when the window ends.
    await w.notifier.setPrefs(w.humanId, { quiet_hours: { start: "09:00", end: "12:00" } });
    const held = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-3" }));
    expect(held.outcome).toBe("held");
    const heldDup = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-3" }));
    expect(heldDup.outcome).toBe("deduped");
    expect(w.notifier.pending(w.humanId).held).toHaveLength(1);
  });

  it("the channel receives the record id so a toast can be matched with the recent list", async () => {
    w = await world();
    const r = await w.notifier.notify(note(w.humanId, { dedupeKey: "request:r-1" }));
    expect(r.outcome).toBe("delivered");
    expect(w.channels.desktop.contexts[0]?.recordId).toBe(r.id);
    expect(w.notifier.recent({ humanId: w.humanId })[0]?.id).toBe(r.id);
    // The test send has no record: no id is passed.
    await w.notifier.sendTest(w.humanId);
    expect(w.channels.desktop.contexts[1]?.recordId).toBeUndefined();
  });

  it("info items wait for the daily digest, sent once per local day at the digest time", async () => {
    // 07:00Z is 09:00 local: today's 08:00 digest already passed, so items wait for tomorrow's.
    w = await world({ start: "2026-10-20T07:00:00Z", prefs: { digest_time: "08:00" } });
    const a = await w.notifier.notify(
      note(w.humanId, { kind: "critic_verdict", title: "Critic: accept (grade 91)" }),
    );
    const b = await w.notifier.notify(
      note(w.humanId, { kind: "update_available", title: "Update available: 1.2.0 (stable)" }),
    );
    expect(a.outcome).toBe("held");
    expect(a.heldFor).toBe("digest");
    expect(b.heldFor).toBe("digest");
    await w.notifier.tick();
    expect(w.channels.desktop.sent).toHaveLength(0);
    expect(w.notifier.pending(w.humanId).digest).toHaveLength(2);

    await w.clock.set("2026-10-21T05:59:00Z"); // 07:59 local
    await w.notifier.tick();
    expect(w.channels.desktop.sent).toHaveLength(0);
    await w.clock.set("2026-10-21T06:00:00Z"); // 08:00 local
    await w.notifier.tick();
    expect(w.channels.desktop.sent).toHaveLength(1);
    const digest = w.channels.desktop.sent[0];
    expect(digest?.kind).toBe("daily_digest");
    expect(digest?.title).toBe("Daily digest: 2 items");
    expect(digest?.body).toContain("[critic_verdict] Critic: accept (grade 91)");
    expect(digest?.body).toContain("[update_available] Update available: 1.2.0 (stable)");
    expect(digest?.link).toBe("/inbox");
    expect(a.outcome).toBe("digested");
    expect(b.outcome).toBe("digested");
    expect(w.notifier.pending(w.humanId).digest).toHaveLength(0);
    // Once per day: a second tick the same morning sends nothing more.
    await w.clock.advance(60_000);
    await w.notifier.tick();
    expect(w.channels.desktop.sent).toHaveLength(1);
    // The digest record is in the recent list along with the digested items.
    const outcomes = w.notifier.recent({ humanId: w.humanId }).map((r) => r.outcome);
    expect(outcomes).toEqual(["delivered", "digested", "digested"]);
    // An empty day sends no empty digest.
    await w.clock.set("2026-10-22T06:00:00Z");
    await w.notifier.tick();
    expect(w.channels.desktop.sent).toHaveLength(1);
  });

  it("the digest bundles quiet-hours holds still waiting at the digest time", async () => {
    w = await world({
      start: NIGHT,
      prefs: { quiet_hours: { start: "22:00", end: "09:00" }, digest_time: "08:00" },
    });
    const held = await w.notifier.notify(note(w.humanId));
    const info = await w.notifier.notify(note(w.humanId, { kind: "peer_message" }));
    expect(held.heldFor).toBe("quiet_hours");
    expect(info.heldFor).toBe("digest");
    await w.clock.set("2026-10-21T06:00:00Z"); // 08:00 local, still inside quiet hours
    await w.notifier.tick();
    expect(w.channels.desktop.sent.map((n) => n.kind)).toEqual(["daily_digest"]);
    expect(w.channels.desktop.sent[0]?.title).toBe("Daily digest: 2 items");
    expect(held.outcome).toBe("digested");
    expect(info.outcome).toBe("digested");
  });

  it("without a digest time info items go out at once; switching the digest off releases the queue", async () => {
    w = await world();
    const r = await w.notifier.notify(note(w.humanId, { kind: "critic_verdict" }));
    expect(r.outcome).toBe("delivered");
    await w.notifier.setPrefs(w.humanId, { digest_time: "20:00" });
    const queued = await w.notifier.notify(note(w.humanId, { kind: "update_available" }));
    expect(queued.heldFor).toBe("digest");
    await w.notifier.setPrefs(w.humanId, { digest_time: null });
    await w.notifier.tick();
    expect(queued.outcome).toBe("delivered");
    expect(w.channels.desktop.sent.map((n) => n.kind)).toEqual([
      "critic_verdict",
      "update_available",
    ]);
  });

  it("retries a failing channel with backoff, then falls back to the next configured one", async () => {
    w = await world();
    w.channels.desktop.answer(fail("toast failed"), fail("toast failed"), fail("toast failed"));
    const t0 = w.clock.now();
    const r = await settle(w.clock, w.notifier.notify(note(w.humanId)));
    expect(r.outcome).toBe("delivered");
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}:${d.attempts}`)).toEqual([
      "desktop:failed:3",
      "telegram:skipped:0",
      "signal:skipped:0",
      "email:delivered:1",
    ]);
    expect(r.deliveries[0]?.reason).toBe("toast failed");
    // Exponential backoff on the clock: 500 ms, then 1000 ms.
    const [first, second, third] = w.channels.desktop.sentAt;
    expect(first).toBeGreaterThanOrEqual(t0);
    expect((second ?? 0) - (first ?? 0)).toBe(500);
    expect((third ?? 0) - (second ?? 0)).toBe(1000);
    expect(w.channels.email.sent).toHaveLength(1);
  });

  it("a non-retryable failure moves on at once; a throwing channel counts as a retryable failure", async () => {
    w = await world({ retry: { attempts: 2, baseMs: 100 } });
    w.channels.desktop.answer(fail("notify-send is not on PATH", false));
    const r = await w.notifier.notify(note(w.humanId));
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}:${d.attempts}`)).toEqual([
      "desktop:unavailable:1",
      "telegram:skipped:0",
      "signal:skipped:0",
      "email:delivered:1",
    ]);
    w.channels.desktop.answer(fail("x", false));
    w.channels.email.send = async () => {
      throw new Error("smtp down");
    };
    const r2 = await settle(w.clock, w.notifier.notify(note(w.humanId, { dedupeKey: "k2" })));
    expect(r2.outcome).toBe("failed");
    const email = r2.deliveries.find((d) => d.channel === "email");
    expect(email).toMatchObject({ status: "failed", attempts: 2 });
    expect(email?.reason).toContain("smtp down");
  });

  it("when every channel fails the record is failed and logged; none configured is no_channel", async () => {
    w = await world({ retry: { attempts: 1 } });
    w.channels.desktop.answer(fail("no shell", false));
    w.channels.email.answer(fail("smtp 550", false));
    const r = await w.notifier.notify(note(w.humanId));
    expect(r.outcome).toBe("failed");
    expect(w.logs.some((l) => l.level === "warn" && l.msg === "not delivered")).toBe(true);
    await w.notifier.setPrefs(w.humanId, { channels: { session_ended: ["telegram", "signal"] } });
    const none = await w.notifier.notify(note(w.humanId, { dedupeKey: "k2" }));
    expect(none.outcome).toBe("no_channel");
    expect(none.deliveries.every((d) => d.status === "skipped")).toBe(true);
  });

  it("every delivery attempt is an audit row and a delivery on a session is an event", async () => {
    w = await world({ storeEvents: true, retry: { attempts: 1 } });
    const sessionId = await sessionFor(w);
    w.channels.desktop.answer(fail("no shell connected and notify-send is not on PATH", false));
    const r = await w.notifier.notify(note(w.humanId, { sessionId }));
    expect(r.outcome).toBe("delivered");
    const rows = await w.store.auditLog.list({ humanId: w.humanId });
    expect(rows.map((a) => `${a.tool}:${a.allowed}`).sort()).toEqual([
      "notify.desktop:false",
      "notify.email:true",
    ]);
    const desktop = rows.find((a) => a.tool === "notify.desktop");
    const email = rows.find((a) => a.tool === "notify.email");
    expect(desktop?.denied_reason).toContain("notify-send");
    expect(desktop?.session_id).toBe(sessionId);
    expect(email?.denied_reason).toBeNull();
    expect(email?.input_summary).toContain("session_ended: Session finished");
    expect(email?.result_summary).toBe("delivered after 1 attempt(s): email");
    const events = await w.store.event.list(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("notification");
    expect(events[0]?.payload).toMatchObject({
      id: r.id,
      kind: "session_ended",
      outcome: "delivered",
      deliveries: [
        { channel: "desktop", status: "unavailable", attempts: 1 },
        { channel: "telegram", status: "skipped", reason: "no Telegram chat id" },
        { channel: "signal", status: "skipped", reason: "no Signal number" },
        { channel: "email", status: "delivered", attempts: 1 },
      ],
    });
    // A notification without a session writes no event; the audit row still names the human.
    await w.notifier.notify(note(w.humanId, { dedupeKey: "k2" }));
    expect(await w.store.event.list(sessionId)).toHaveLength(1);
    expect(await w.store.auditLog.count({ humanId: w.humanId })).toBe(3);
  });

  it("refuses a notification without human, title or dedupe key, and an unknown human", async () => {
    w = await world();
    await expect(w.notifier.notify(note(w.humanId, { title: "  " }))).rejects.toMatchObject({
      code: "validation",
    });
    await expect(w.notifier.notify(note(w.humanId, { dedupeKey: "" }))).rejects.toMatchObject({
      code: "validation",
    });
    await expect(w.notifier.notify(note("nobody"))).rejects.toMatchObject({ code: "not_found" });
    await expect(w.notifier.getPrefs("nobody")).rejects.toMatchObject({ code: "not_found" });
    await expect(w.notifier.setPrefs(w.humanId, { bogus: 1 })).rejects.toMatchObject({
      code: "validation",
    });
    expect(w.channels.desktop.sent).toHaveLength(0);
  });

  it("recent() is newest first and capped; the emitter reports every decision", async () => {
    w = await world({ recentLimit: 3, start: NIGHT, prefs: { quiet_hours: QUIET } });
    const records: NotificationRecord[] = [];
    w.emitter.on("record", (r) => records.push({ ...r }));
    for (let i = 0; i < 4; i++) {
      await w.notifier.notify(note(w.humanId, { kind: "kill_switch", dedupeKey: `k${i}` }));
      await w.clock.advance(1000);
    }
    const recent = w.notifier.recent({ humanId: w.humanId, limit: 10 });
    expect(recent.map((r) => r.notification.dedupeKey)).toEqual(["k3", "k2", "k1"]);
    expect(w.notifier.recent({ humanId: w.humanId, limit: 1 })).toHaveLength(1);
    expect(w.notifier.recent({ humanId: "other" })).toEqual([]);
    const held = await w.notifier.notify(note(w.humanId, { dedupeKey: "held" }));
    expect(records.map((r) => r.outcome)).toEqual([
      "delivered",
      "delivered",
      "delivered",
      "delivered",
      "held",
    ]);
    expect(records[4]?.id).toBe(held.id);
  });

  it("sendTest sends one test to each configured channel and skips the rest with the reason", async () => {
    w = await world({ prefs: { signal_number: "+41790000000" } });
    const deliveries = await w.notifier.sendTest(w.humanId);
    expect(deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      "desktop:delivered",
      "telegram:skipped",
      "signal:delivered",
      "email:delivered",
      "voice:skipped",
    ]);
    expect(deliveries[1]?.reason).toBe("no Telegram chat id");
    expect(deliveries[4]?.reason).toBe("voice alerts are off");
    expect(w.channels.signal.sent[0]?.title).toContain("Test notification");
    const rows = await w.store.auditLog.list({ humanId: w.humanId });
    expect(rows.map((a) => a.tool).sort()).toEqual([
      "notify.desktop",
      "notify.email",
      "notify.signal",
    ]);
    expect(rows.every((a) => a.input_summary.includes("(test)"))).toBe(true);
    // Tests never enter the dedupe window or the recent list of real notifications.
    expect(w.notifier.recent({ humanId: w.humanId })).toEqual([]);
  });

  it("bound producers hand the builders' output to the notifier", async () => {
    w = await world();
    const hooks = bindProducers(w.notifier);
    const r = await hooks.sessionEnded(w.humanId, {
      sessionId: "s-9",
      status: "completed",
      stopReason: "done",
      summary: "Two PRs opened.",
      spentUsdMicro: 1_250_000,
      completed: ["a", "b"],
      needsHuman: [],
      agentName: "Alice",
    });
    expect(r.outcome).toBe("delivered");
    expect(r.notification.kind).toBe("session_ended");
    expect(r.notification.link).toBe("/sessions/s-9");
    const stop = await hooks.budgetStop(w.humanId, {
      sessionId: "s-9",
      status: "stopped",
      stopReason: "budget_exceeded",
      summary: "Cap hit.",
      spentUsdMicro: 5_000_000,
      completed: [],
      needsHuman: ["decide"],
    });
    expect(stop.notification.kind).toBe("budget_stop");
    expect(stop.notification.title).toContain("USD 5.00");
    expect(stop.urgency).toBe("urgent");
  });
});
