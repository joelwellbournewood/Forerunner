import type { HumanRequestRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { requestOpened, sessionEnded } from "../src/notifications/producers.ts";

/**
 * l4-cred-engine L4-creds-3 (live check 4: LC-C21, LC-C24; design §4.3, §5.10 "the person hears
 * once"): a notification about a card says what the card says, once. Before, the ask card's
 * notification named the reset in UTC (07:26 while every screen said 08:26), a refused key's card
 * said "Answer it in the Inbox." though it has nothing to answer, a long list of names read "and 2
 * more and 1 more", and a session's end pointed to the Inbox twice.
 */
const row = (over: Partial<HumanRequestRow>): HumanRequestRow =>
  ({
    id: "req-1",
    human_id: "h-1",
    project_id: null,
    task_id: null,
    session_id: null,
    kind: "approval",
    why: "",
    steps: [],
    options: [],
    blocking: true,
    risk: "medium",
    change_card: null,
    status: "open",
    answer: null,
    created_at: "2026-11-17T06:00:00.000Z",
    updated_at: "2026-11-17T06:00:00.000Z",
    author_agent: null,
    author_human: null,
    version: 1,
    ...over,
  }) as unknown as HumanRequestRow;

describe("l4-cred-engine, run L4: a notification about a credential card says what the card says, once", () => {
  it("the ask card's reset is in the person's time zone, from the context the Inbox reads", () => {
    const ask = row({
      change_card: {
        key: "credential:ask",
        source_id: "src-sub",
        stop_key: "limit:2026-11-17T07:26:00.000Z",
        reason: "limit",
        credential_kind: "subscription",
        until: "2026-11-17T07:26:00.000Z",
        estimate_usd_micro: 120_000,
        chf_per_usd: 0.8,
        filed_at: "2026-11-17T06:00:00.000Z",
      } as never,
    });
    const n = requestOpened(ask, "h-1", {
      projectName: null,
      taskTitle: null,
      credentialAsk: {
        timezone: "Europe/Zurich",
        nowMs: Date.parse("2026-11-17T06:00:00Z"),
        sessionWaits: true,
      },
    });
    expect(n.title).toBe("Use your API key until 08:26?");
    expect(n.body).toContain("until 08:26");
    expect(n.body).not.toContain("07:26");
  });

  it("without the person's zone the ask card's time comes from when it was filed, never from now", () => {
    const ask = row({
      change_card: {
        key: "credential:ask",
        source_id: "src-sub",
        reason: "limit",
        credential_kind: "subscription",
        until: "2026-11-18T07:26:00.000Z",
        estimate_usd_micro: 0,
        filed_at: "2026-11-18T06:00:00.000Z",
      } as never,
    });
    // Filed on the day of the reset: the time alone, whatever day it is when it is read.
    expect(requestOpened(ask, "h-1").title).toBe("Use your API key until 07:26?");
  });

  it("a refused key's card says its sentence and links the setup assistant; nothing to answer", () => {
    const refused = row({
      change_card: { key: "credential:refused", source_id: "src-key" } as never,
    });
    const n = requestOpened(refused, "h-1", {
      projectName: null,
      taskTitle: null,
      credentialRefused: { category: "invalid_key", rule: "wait", other: null },
    });
    expect(n.kind).toBe("request_blocking");
    expect(n.title).toBe("Anthropic refused your API key");
    expect(n.body).toBe(
      "The key is not valid or was deleted. Save a new one in Settings; until then the work waits.",
    );
    expect(n.body).not.toContain("Answer it in the Inbox");
    expect(n.link).toBe("/setup");
  });

  it("under 'API key first, then subscription' the refused key's card says the subscription does the work", () => {
    const refused = row({
      change_card: { key: "credential:refused", source_id: "src-key" } as never,
    });
    const n = requestOpened(refused, "h-1", {
      projectName: null,
      taskTitle: null,
      credentialRefused: { category: "invalid_key", rule: "next", other: "subscription" },
    });
    expect(n.body).toMatch(/Claude subscription does the work/);
    expect(n.body).not.toContain("Answer it in the Inbox");
  });

  it("a session's end with four long names counts the rest once", () => {
    const titles = [
      "Write the opening section of the field guide",
      "Write the closing section of the field guide",
      "Check every single link in the field guide",
    ];
    const n = sessionEnded("h-1", {
      sessionId: "s-1",
      status: "completed",
      stopReason: "completed",
      summary: "",
      news: [`Did 4 tasks: ${titles.map((t) => `"${t}"`).join(", ")} and 1 more.`],
      spentUsdMicro: 0,
      completed: ["a", "b", "c", "d"],
      needsHuman: [],
      agentName: "Alice",
      projectName: "Field guide",
    } as never);
    expect(n.title.match(/and \d+ more/g) ?? []).toHaveLength(1);
    expect(n.title.length).toBeLessThanOrEqual(60);
  });

  it("a session that ended to wait for an ask card points to the Inbox once", () => {
    const n = sessionEnded("h-1", {
      sessionId: "s-2",
      status: "completed",
      stopReason: "completed",
      summary: "",
      news: [
        'Did 1 task: "Style the page".',
        "Waits for your answer: use your API key? The card is in the Inbox.",
      ],
      spentUsdMicro: 0,
      completed: ["a"],
      needsHuman: [],
      agentName: "Alice",
      projectName: "Quote page",
    } as never);
    expect(n.body.match(/Inbox/g) ?? []).toHaveLength(1);
  });
});
