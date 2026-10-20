import { isForerunnerError } from "@forerunner/platform";
import type { ToolExecutionContext } from "@forerunner/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_SEND_CAP,
  DEFAULT_PER_RECIPIENT_DAILY_CAP,
  EMAIL_SEND_TOOL,
  type EmailDraft,
  type EmailMode,
  emailTools,
  FakeApprovalPort,
  type SendOutcome,
  TestMailbox,
} from "../src/email/index.ts";
import {
  AGENT,
  addAgentForHuman,
  DOMAIN,
  emailWorld,
  STRANGER,
  type World,
} from "./helpers/email-world.ts";

/**
 * Requirements close-out for agent email (spec "Security, permissions and email" -> "Agent
 * email"): the clauses the email suites exercise only in passing, asserted one by one against
 * the real policy, settings store and tools on the testenv mail server, an in-memory SQLite
 * store and the simulated clock.
 *
 * - S.10 / S.15: an agent reads its own mailbox only. The tools bind the mailbox to the run's
 *   agent id, never to anything the model writes; a second human's agent sees nothing of the
 *   first agent's mail, and its own mode `off` reads nothing while the other mailbox has mail.
 * - S.21: the limits stay on in every sending mode (draft only, allowlist, full discretion):
 *   blocked content and the daily and per-recipient caps hold, and each cap is adjustable.
 * - S.22: the defaults are 20 sends a day and 5 per recipient a day.
 */

let world: World | undefined;

afterEach(async () => {
  await world?.stop();
  world = undefined;
});

function draftTo(
  to: string,
  text = "Hello, here is the weekly status.",
  subject = "Status",
): EmailDraft {
  return { to: [to], subject, text };
}

async function sendAs(w: World, draft: EmailDraft): Promise<SendOutcome> {
  return w.policy.send(draft, { agentId: w.agentId, humanId: w.human.id, sessionId: w.sessionId });
}

function ctx(agentId: string, humanId: string, sessionId: string): ToolExecutionContext {
  return {
    runId: `run-${agentId}`,
    sessionId,
    agentId,
    humanId,
    allowedPaths: [],
    signal: new AbortController().signal,
  };
}

describe("close-out S.10 and S.15: each agent reads its own mailbox only", () => {
  it("binds the mailbox to the run's agent, drops any mailbox the model names, and reads nothing at mode off", async () => {
    world = await emailWorld({ mode: "read_only" });
    const other = await addAgentForHuman(world, {
      humanName: "K",
      humanEmail: `k@${DOMAIN}`,
      agentName: "Bram",
      password: ["other", "pass", "word", "4"].join("-"), // not-a-secret
    });
    // A stranger writes to Alice. Nothing is delivered to Bram.
    const [stored] = await world.server.inject({
      from: STRANGER,
      to: AGENT,
      subject: "For Alice only",
      text: "Quarterly numbers inside.",
    });
    if (!stored) throw new Error("not delivered");
    const bramBox = new TestMailbox({
      server: world.server,
      address: other.mailboxAddress,
      clock: world.clock,
    });
    const asked: string[] = [];
    const w = world;
    const tools = emailTools({
      policy: w.policy,
      settings: w.settings,
      identity: w.identity,
      sentLog: w.sentLog,
      mailboxFor: async (agentId) => {
        asked.push(agentId);
        return agentId === other.agentId ? bramBox : w.mailbox;
      },
      clock: w.clock,
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const list = byName.get("email_list");
    const read = byName.get("email_read");
    if (!list || !read) throw new Error("email tools missing");
    const bramSession = await world.store.session.insert({
      agent_id: other.agentId,
      project_id: null,
      trigger: "manual",
    });
    const bram = ctx(other.agentId, other.humanId, bramSession.id);

    // The schemas carry no field that names a mailbox or an agent: whatever the model adds is dropped.
    expect(list.schema.parse({ limit: 5, agentId: world.agentId, mailbox: AGENT })).toEqual({
      limit: 5,
    });
    expect(read.schema.parse({ id: stored.id, agentId: world.agentId, mailbox: AGENT })).toEqual({
      id: stored.id,
    });

    // Bram's agent lists and reads its own mailbox: empty, and Alice's message id is unknown there.
    const listed = await list.execute({ limit: 5 }, bram);
    expect(listed.isError).toBeUndefined();
    expect(listed.content).toBe("(no unseen messages)");
    expect(listed.untrusted).toEqual({ source: "email", origin: other.mailboxAddress });
    const readOther = await read.execute({ id: stored.id }, bram);
    expect(readOther.isError).toBe(true);
    expect(readOther.content).not.toContain("Quarterly numbers");
    expect(asked).toEqual([other.agentId, other.agentId]);

    // Alice's own agent reads it.
    const mine = await read.execute(
      { id: stored.id },
      ctx(world.agentId, world.human.id, world.sessionId),
    );
    expect(mine.isError).toBeUndefined();
    expect(mine.content).toContain("Quarterly numbers");

    // Mode off for Bram's agent reads nothing, while Alice's settings row is untouched (one row per agent).
    await world.settings.update(other.agentId, { settings: { mode: "off" } });
    const off = await list.execute({}, bram);
    expect(off.isError).toBe(true);
    expect(off.content).toContain("email mode is off");
    expect((await world.settings.get(world.agentId)).settings.mode).toBe("read_only");
    expect((await world.settings.get(world.agentId)).settings.mailbox?.address).toBe(AGENT);
    expect((await world.settings.get(other.agentId)).settings.mailbox?.address).toBe(
      other.mailboxAddress,
    );
  });
});

describe("close-out S.21: the limits stay on in every sending mode and each is adjustable", () => {
  const SENDING_MODES: EmailMode[] = ["draft_only", "allowlist", "full_discretion"];
  for (const mode of SENDING_MODES) {
    it(`${mode}: blocked content and the caps hold; raising or lowering a cap takes effect at once`, async () => {
      world = await emailWorld({ mode, dailySendCap: 1, approvals: new FakeApprovalPort("yes") });
      if (mode === "allowlist") {
        await world.settings.addAllowlisted(world.agentId, { address: STRANGER });
        await world.settings.addAllowlisted(world.agentId, { address: "second@external.test" });
      }
      const w = world;

      // Blocked content is refused before anything leaves, in this mode too.
      await expect(
        sendAs(w, draftTo(STRANGER, "The password: hunter22xyz for the staging box")),
      ).rejects.toSatisfy(
        (e: unknown) =>
          isForerunnerError(e, "tool_not_allowed") &&
          (e.details.classes as string[]).includes("credentials"),
      );
      expect(w.server.outbox).toHaveLength(0);

      // The first send goes out (approved at once in draft only); the second hits the adjusted daily cap.
      expect((await sendAs(w, draftTo(STRANGER))).status).toBe("sent");
      await expect(sendAs(w, draftTo("second@external.test"))).rejects.toSatisfy(
        (e: unknown) => isForerunnerError(e, "budget_exceeded") && /daily send cap/.test(e.message),
      );
      expect(w.server.outbox).toHaveLength(1);

      // Adjustable: a raised daily cap lets the next one through; a lowered per-recipient cap blocks a repeat.
      await w.settings.update(w.agentId, {
        settings: { dailySendCap: 3, perRecipientDailyCap: 1 },
      });
      expect((await sendAs(w, draftTo("second@external.test"))).status).toBe("sent");
      await expect(sendAs(w, draftTo(STRANGER, "again"))).rejects.toSatisfy(
        (e: unknown) => isForerunnerError(e, "budget_exceeded") && /per-recipient/.test(e.message),
      );
      expect(w.server.outbox).toHaveLength(2);
      expect(w.server.outbox.map((m) => m.envelope.rcptTo)).toEqual([
        [STRANGER],
        ["second@external.test"],
      ]);

      // Every refusal is an audit row of the send tool with allowed = false.
      const denied = await w.store.auditLog.list({
        agentId: w.agentId,
        tool: EMAIL_SEND_TOOL,
        allowed: false,
      });
      expect(denied.map((r) => r.denied_reason ?? "")).toEqual([
        expect.stringContaining("tool_not_allowed"),
        expect.stringContaining("budget_exceeded"),
        expect.stringContaining("budget_exceeded"),
      ]);
    });
  }
});

describe("close-out S.22: the default caps", () => {
  it("a fresh agent starts with a daily send cap of 20 and a per-recipient cap of 5 per day", async () => {
    world = await emailWorld();
    const fresh = await world.settings.get("agent-fresh");
    expect(fresh.settings.dailySendCap).toBe(20);
    expect(fresh.settings.perRecipientDailyCap).toBe(5);
    expect(DEFAULT_DAILY_SEND_CAP).toBe(20);
    expect(DEFAULT_PER_RECIPIENT_DAILY_CAP).toBe(5);
  });
});
