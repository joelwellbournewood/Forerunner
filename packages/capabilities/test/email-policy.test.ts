import { isForerunnerError } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectBlockedContent,
  EMAIL_DRAFT_TOOL,
  EMAIL_QUEUED_TOOL,
  EMAIL_SEND_TOOL,
  type EmailDraft,
  type EmailMode,
  EmailPolicy,
  FakeApprovalPort,
  ModelContentClassifier,
  recipientAllowlisted,
  type SendOutcome,
} from "../src/email/index.ts";
import {
  AGENT,
  emailWorld,
  lastOutbox,
  OWNER,
  STRANGER,
  type World,
} from "./helpers/email-world.ts";

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

async function expectBlocked(w: World, draft: EmailDraft, code: string, pattern?: RegExp) {
  await expect(sendAs(w, draft)).rejects.toSatisfy(
    (e: unknown) =>
      isForerunnerError(e, code as never) && (pattern ? pattern.test(e.message) : true),
  );
  const denied = await w.store.auditLog.list({
    agentId: w.agentId,
    tool: EMAIL_SEND_TOOL,
    allowed: false,
  });
  expect(denied.length).toBeGreaterThan(0);
  expect(denied[denied.length - 1]?.denied_reason).toContain(code);
}

describe("EmailPolicy mode matrix", () => {
  const matrix: Array<[EmailMode, string]> = [
    ["off", "tool_not_allowed"],
    ["read_only", "tool_not_allowed"],
    ["draft_only", "awaiting_approval"],
    ["allowlist", "awaiting_approval"],
    ["full_discretion", "sent"],
  ];
  for (const [mode, expected] of matrix) {
    it(`mode ${mode}: sending to a stranger -> ${expected}`, async () => {
      world = await emailWorld({ mode });
      if (expected === "tool_not_allowed") {
        await expectBlocked(world, draftTo(STRANGER), "tool_not_allowed");
        expect(world.server.outbox).toHaveLength(0);
        return;
      }
      const outcome = await sendAs(world, draftTo(STRANGER));
      expect(outcome.status).toBe(expected);
      if (expected === "sent") {
        expect(lastOutbox(world)?.envelope.rcptTo).toEqual([STRANGER]);
      } else {
        expect(world.server.outbox).toHaveLength(0);
      }
    });
  }

  it("replies to the registered human are allowed in every mode except off", async () => {
    for (const mode of ["read_only", "draft_only", "allowlist", "full_discretion"] as EmailMode[]) {
      const w = await emailWorld({ mode });
      const outcome = await sendAs(w, draftTo(OWNER, "Here is what I found."));
      expect(outcome.status, mode).toBe("sent");
      expect(w.ownerBox.messages).toHaveLength(1);
      await w.stop();
    }
    world = await emailWorld({ mode: "off" });
    await expectBlocked(world, draftTo(OWNER), "tool_not_allowed", /off/);
  });

  it("read_only refuses a mail that goes to the human and a stranger together", async () => {
    world = await emailWorld({ mode: "read_only" });
    await expectBlocked(
      world,
      { to: [OWNER], cc: [STRANGER], subject: "x", text: "y" },
      "tool_not_allowed",
    );
  });
});

describe("EmailPolicy caps", () => {
  it("enforces the daily send cap with day boundaries in the human's time zone", async () => {
    // 22:30 UTC on 2 March is 23:30 in Zurich: two sends fit, the third is blocked,
    // and one simulated hour later (00:30 local, still 2 March in UTC) the cap resets.
    world = await emailWorld({
      mode: "full_discretion",
      dailySendCap: 2,
      start: "2026-03-02T22:30:00.000Z",
    });
    expect((await sendAs(world, draftTo("a@external.test"))).status).toBe("sent");
    expect((await sendAs(world, draftTo("b@external.test"))).status).toBe("sent");
    await expectBlocked(world, draftTo("c@external.test"), "budget_exceeded", /daily send cap/);
    // Replies to the human never count against the cap.
    expect((await sendAs(world, draftTo(OWNER, "status"))).status).toBe("sent");
    await world.clock.advance(60 * 60 * 1000);
    expect((await sendAs(world, draftTo("c@external.test"))).status).toBe("sent");
    expect(world.server.outbox).toHaveLength(3);
  });

  it("enforces the per-recipient daily cap", async () => {
    world = await emailWorld({ mode: "full_discretion", perRecipientDailyCap: 1 });
    expect((await sendAs(world, draftTo(STRANGER))).status).toBe("sent");
    await expectBlocked(world, draftTo(STRANGER, "again"), "budget_exceeded", /per-recipient/);
    expect((await sendAs(world, draftTo("other@external.test"))).status).toBe("sent");
  });
});

describe("EmailPolicy serializes the caps per agent", () => {
  it("concurrent sends cannot slip past the daily send cap", async () => {
    world = await emailWorld({ mode: "full_discretion", dailySendCap: 1 });
    const results = await Promise.allSettled([
      sendAs(world, draftTo("a@external.test")),
      sendAs(world, draftTo("b@external.test")),
      sendAs(world, draftTo("c@external.test")),
    ]);
    const sent = results.filter((r) => r.status === "fulfilled" && r.value.status === "sent");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(sent).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(isForerunnerError(r.reason, "budget_exceeded")).toBe(true);
    }
    expect(world.server.outbox).toHaveLength(1);
  });

  it("concurrent sends cannot slip past the per-recipient cap", async () => {
    world = await emailWorld({ mode: "full_discretion", perRecipientDailyCap: 1 });
    const results = await Promise.allSettled([
      sendAs(world, draftTo(STRANGER, "one")),
      sendAs(world, draftTo(STRANGER, "two")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(world.server.outbox).toHaveLength(1);
  });

  it("an approval answered twice at the same time sends once", async () => {
    world = await emailWorld({ mode: "allowlist" });
    const pending = await sendAs(world, draftTo(STRANGER));
    if (pending.status !== "awaiting_approval") throw new Error("unreachable");
    const [a, b] = await Promise.all([
      world.policy.resolveApproval(pending.requestId, "yes", world.human.id),
      world.policy.resolveApproval(pending.requestId, "yes", world.human.id),
    ]);
    expect([a.status, b.status].sort()).toEqual(["refused", "sent"]);
    expect(world.server.outbox).toHaveLength(1);
  });
});

describe("EmailPolicy blocked content", () => {
  const cases: Array<[string, string, string]> = [
    ["credentials (password)", "The password: hunter22xyz for the staging box", "credentials"],
    [
      "credentials (token shape)",
      `Use ${["ghp", "_", "A".repeat(40)].join("")} to pull the repo`, // not-a-secret
      "credentials",
    ],
    ["secret reference", "Deploy with secret:github_pat please", "secret_reference"],
    ["private memory marker", "[[private memory]] J prefers short meetings", "private_memory"],
    [
      "third-party email address",
      "Please loop in carol@somewhere-else.test on this",
      "third_party_personal_data",
    ],
    [
      "third-party phone number",
      "Call him on +41 79 123 45 67 tomorrow",
      "third_party_personal_data",
    ],
    [
      "financial commitment",
      "We will pay the invoice of CHF 12'000 by Friday",
      "financial_commitment",
    ],
    ["legal agreement", "This agreement is legally binding on both parties", "legal_agreement"],
  ];
  for (const [name, text, cls] of cases) {
    it(`blocks ${name}`, async () => {
      world = await emailWorld({ mode: "full_discretion" });
      await expect(sendAs(world, draftTo(STRANGER, text))).rejects.toSatisfy(
        (e: unknown) =>
          isForerunnerError(e, "tool_not_allowed") && (e.details.classes as string[]).includes(cls),
      );
      expect(world.server.outbox).toHaveLength(0);
      const denied = await world.store.auditLog.list({ agentId: world.agentId, allowed: false });
      expect(denied[0]?.denied_reason).toContain("blocked content");
      expect(denied[0]?.input_summary).not.toContain("hunter22xyz");
    });
  }

  it("still blocks credentials in a reply to the human but allows contact details there", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    await expectBlocked(world, draftTo(OWNER, "password: hunter22xyz"), "tool_not_allowed");
    expect(
      (await sendAs(world, draftTo(OWNER, "Carol's address is carol@somewhere-else.test"))).status,
    ).toBe("sent");
  });

  it("recipients' own addresses are not other people's data", () => {
    const check = detectBlockedContent("Hi client@external.test, see you", "x", {
      exemptAddresses: ["client@external.test"],
      toHuman: false,
    });
    expect(check.blocked).toEqual([]);
  });

  it("paid sign-ups and terms acceptance need approval and send after yes", async () => {
    const approvals = new FakeApprovalPort("pending");
    world = await emailWorld({ mode: "full_discretion", approvals });
    const signup = await sendAs(
      world,
      draftTo("sales@saas.test", "Please sign me up for the Pro plan."),
    );
    expect(signup).toMatchObject({ status: "awaiting_approval", reason: "paid_signup" });
    const terms = await sendAs(
      world,
      draftTo("legal@saas.test", "We accept the terms of service."),
    );
    expect(terms).toMatchObject({ status: "awaiting_approval", reason: "terms_acceptance" });
    expect(world.server.outbox).toHaveLength(0);
    if (signup.status !== "awaiting_approval") throw new Error("unreachable");
    const sent = await world.policy.resolveApproval(signup.requestId, "yes", world.human.id);
    expect(sent.status).toBe("sent");
    expect(lastOutbox(world)?.envelope.rcptTo).toEqual(["sales@saas.test"]);
  });

  it("an optional model classifier can block what the rules miss", async () => {
    const provider = new FakeProvider({
      latency: "none",
      replies: [
        textReply(
          '{"blocked":true,"classes":["financial_commitment"],"reason":"promises a refund"}',
        ),
      ],
    });
    world = await emailWorld({ mode: "full_discretion" });
    const policy = new EmailPolicy({
      settings: world.settings,
      identity: world.identity,
      sentLog: world.sentLog,
      approvals: world.approvals,
      mailboxFor: async () => world!.mailbox,
      clock: world.clock,
      classifier: new ModelContentClassifier(provider, "fake-haiku"),
    });
    await expect(
      policy.send(draftTo(STRANGER, "Of course, no problem at all."), {
        agentId: world.agentId,
        humanId: world.human.id,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isForerunnerError(e, "tool_not_allowed") && /classifier/.test(e.message),
    );
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request.messages[0]?.content).toContain("UNTRUSTED_CONTENT");
  });
});

describe("EmailPolicy signature, pause and logging", () => {
  it("appends the AI-agent signature naming the human when on, not when off", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    await sendAs(world, draftTo(STRANGER));
    const raw = lastOutbox(world)?.parsed.text ?? "";
    expect(raw).toContain("-- \nAlice is an AI agent acting for J.");
    await world.settings.update(world.agentId, { settings: { signature: { enabled: false } } });
    await sendAs(world, draftTo("second@external.test"));
    expect(lastOutbox(world)?.parsed.text ?? "").not.toContain("AI agent");
  });

  it("queues instead of sending while paused, and resumes after", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    await world.settings.setPaused(world.agentId, true);
    const outcome = await sendAs(world, draftTo(STRANGER));
    expect(outcome).toMatchObject({ status: "queued", reason: "paused" });
    expect(world.server.outbox).toHaveLength(0);
    const queued = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_QUEUED_TOOL,
    });
    expect(queued).toHaveLength(1);
    await world.settings.setPaused(world.agentId, false);
    expect((await sendAs(world, draftTo(STRANGER))).status).toBe("sent");
  });

  it("logs every sent email with a full copy (audit row) and an event on the session", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    const outcome = await sendAs(world, draftTo(STRANGER, "Full body here."));
    expect(outcome.status).toBe("sent");
    const rows = await world.sentLog.recent(world.agentId, "2026-01-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      to: [STRANGER],
      subject: "Status",
      toHuman: false,
      mode: "full_discretion",
    });
    expect(rows[0]?.text).toContain("Full body here.");
    expect(rows[0]?.text).toContain("AI agent");
    expect(world.events.events.map((e) => e.type)).toEqual(["email_sent"]);
  });
});

describe("EmailPolicy approvals", () => {
  it("allowlist: a new recipient needs approval, is added on yes, and the mail is sent once", async () => {
    world = await emailWorld({ mode: "allowlist" });
    const first = await sendAs(world, draftTo(STRANGER));
    expect(first).toMatchObject({ status: "awaiting_approval", reason: "new_recipient" });
    if (first.status !== "awaiting_approval") throw new Error("unreachable");
    const open = await world.store.humanRequest.open({ humanId: world.human.id });
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("approval");
    expect(open[0]?.why).toContain(STRANGER);

    const sent = await world.policy.resolveApproval(first.requestId, "yes", world.human.id);
    expect(sent.status).toBe("sent");
    expect(lastOutbox(world)?.envelope.rcptTo).toEqual([STRANGER]);
    expect((await world.settings.get(world.agentId)).settings.allowlist.addresses).toContain(
      STRANGER,
    );
    // The same approval cannot send twice.
    const replay = await world.policy.resolveApproval(first.requestId, "yes", world.human.id);
    expect(replay).toMatchObject({ status: "refused", reason: "approval already used" });
    expect(world.server.outbox).toHaveLength(1);
    // Now allowlisted: free to send.
    expect((await sendAs(world, draftTo(STRANGER, "follow-up"))).status).toBe("sent");
  });

  it("allowlist: refused after no, logged as blocked", async () => {
    world = await emailWorld({ mode: "allowlist" });
    const first = await sendAs(world, draftTo(STRANGER));
    if (first.status !== "awaiting_approval") throw new Error("unreachable");
    const refused = await world.policy.resolveApproval(first.requestId, "no", world.human.id);
    expect(refused).toMatchObject({ status: "refused", reason: "human said no" });
    expect(world.server.outbox).toHaveLength(0);
    const denied = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_SEND_TOOL,
      allowed: false,
    });
    expect(denied[0]?.denied_reason).toContain("refused");
    expect((await world.settings.get(world.agentId)).settings.allowlist.addresses).not.toContain(
      STRANGER,
    );
  });

  it("allowlist domains cover addresses, wildcards cover subdomains", () => {
    const allowlist = { addresses: ["x@y.test"], domains: ["partner.test", "*.corp.test"] };
    expect(recipientAllowlisted("x@y.test", allowlist)).toBe(true);
    expect(recipientAllowlisted("anyone@partner.test", allowlist)).toBe(true);
    expect(recipientAllowlisted("a@mail.corp.test", allowlist)).toBe(true);
    expect(recipientAllowlisted("a@sub.partner.test", allowlist)).toBe(false);
    expect(recipientAllowlisted("z@y.test", allowlist)).toBe(false);
  });

  it("draft_only: the draft is stored, a 'send this email?' request is raised, sent only on yes", async () => {
    world = await emailWorld({ mode: "draft_only" });
    const outcome = await sendAs(world, draftTo(STRANGER));
    expect(outcome).toMatchObject({ status: "awaiting_approval", reason: "send_email" });
    if (outcome.status !== "awaiting_approval") throw new Error("unreachable");
    expect(world.mailbox.drafts).toHaveLength(1);
    const drafts = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_DRAFT_TOOL,
    });
    expect(drafts).toHaveLength(1);
    const request = await world.store.humanRequest.mustGet(outcome.requestId);
    expect(request.why).toMatch(/^Send this email/);
    expect(world.server.outbox).toHaveLength(0);
    const sent = await world.policy.resolveApproval(outcome.requestId, "yes", world.human.id);
    expect(sent.status).toBe("sent");
    const rows = await world.sentLog.recent(world.agentId, "2026-01-01T00:00:00.000Z");
    expect(rows[0]?.approvalRequestId).toBe(outcome.requestId);
  });

  it("an approval port that answers at once sends immediately", async () => {
    world = await emailWorld({ mode: "draft_only", approvals: new FakeApprovalPort("yes") });
    expect((await sendAs(world, draftTo(STRANGER))).status).toBe("sent");
    world.approvals = new FakeApprovalPort("no");
  });

  it("limits still hold for an approved draft: the daily cap blocks it", async () => {
    world = await emailWorld({ mode: "allowlist", dailySendCap: 1 });
    const pending = await sendAs(world, draftTo(STRANGER));
    if (pending.status !== "awaiting_approval") throw new Error("unreachable");
    await world.settings.addAllowlisted(world.agentId, { address: "ok@external.test" });
    expect((await sendAs(world, draftTo("ok@external.test"))).status).toBe("sent");
    await expect(
      world.policy.resolveApproval(pending.requestId, "yes", world.human.id),
    ).rejects.toSatisfy((e: unknown) => isForerunnerError(e, "budget_exceeded"));
  });
});

describe("EmailPolicy digest", () => {
  it("sends the optional daily digest listing the day's mail to the human", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    expect(await world.policy.sendDailyDigest(world.agentId)).toBeNull();
    await sendAs(world, draftTo(STRANGER, "one"));
    await world.settings.update(world.agentId, { settings: { dailyDigest: true } });
    const digest = await world.policy.sendDailyDigest(world.agentId);
    expect(digest?.status).toBe("sent");
    const mail = world.ownerBox.messages[world.ownerBox.messages.length - 1];
    expect(mail?.parsed.subject).toMatch(/^Email digest 2026-03-02/);
    expect(mail?.parsed.text).toContain(`to ${STRANGER}: Status`);
    expect(mail?.parsed.from?.value[0]?.address).toBe(AGENT);
  });
});
