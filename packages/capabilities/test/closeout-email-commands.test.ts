import { afterEach, describe, expect, it } from "vitest";
import { EMAIL_SEND_TOOL, type EmailMode } from "../src/email/index.ts";
import {
  emailWorld,
  inboundOf,
  interpretation,
  lastOwnerMail,
  ownerSends,
  STRANGER,
  type World,
} from "./helpers/email-world.ts";

/**
 * Requirements close-out for email commands (spec "Email commands: tasks by email, run in the
 * cloud", T.1): the command toggle is a setting of its own, apart from the sending mode, and a
 * reply to the owner is allowed whatever the mode says about everyone else. Asserted against
 * the real gate, handler and policy on the testenv mail server (DKIM and SPF), an in-memory
 * SQLite store and the simulated clock; the fake provider plays the classifier.
 *
 * Mode `off` is deliberately not in the loop below: the modes table says an agent in mode off
 * reads nothing and sends nothing, and `EmailPolicy.checkSend` refuses even the reply to the
 * owner there, so the row stays open until the conflict with "replies to you are always
 * allowed" is decided (docs/status/BLOCKERS.md, T.1).
 */

let world: World | undefined;

afterEach(async () => {
  await world?.stop();
  world = undefined;
});

async function sentRows(w: World) {
  const rows = await w.store.auditLog.list({ agentId: w.agentId, tool: EMAIL_SEND_TOOL });
  return rows.map((row) => ({
    row,
    input: JSON.parse(row.input_summary) as Record<string, unknown>,
  }));
}

function toStranger(w: World) {
  return w.policy.send(
    { to: [STRANGER], subject: "Hello", text: "Here is the plan." },
    { agentId: w.agentId, humanId: w.human.id, sessionId: w.sessionId },
  );
}

describe("close-out T.1: email commands are a toggle of their own", () => {
  it("the command toggle and the sending mode are independent settings and independent gates", async () => {
    world = await emailWorld({ mode: "read_only", commands: true });
    world.provider.pushReplies(
      interpretation(
        { kind: "question", summary: "status of Sample", answer: "All green." },
        "status",
      ),
    );
    // Read only sends nothing to anyone else...
    await expect(toStranger(world)).rejects.toMatchObject({ code: "tool_not_allowed" });
    // ...while a command from the owner is obeyed and answered by reply.
    const asked = await ownerSends(world, { subject: "Status", text: "What is the status?" });
    const answered = await world.handler.handle(world.agentId, await inboundOf(asked));
    expect(answered.kind).toBe("question");
    expect(lastOwnerMail(world)?.parsed.text).toContain("All green.");

    // Turning commands off leaves the mode alone, and changing the mode leaves commands off.
    await world.settings.update(world.agentId, { commands: { enabled: false } });
    expect((await world.settings.get(world.agentId)).settings.mode).toBe("read_only");
    await world.settings.update(world.agentId, { settings: { mode: "full_discretion" } });
    const config = await world.settings.get(world.agentId);
    expect(config.settings.mode).toBe("full_discretion");
    expect(config.commands.enabled).toBe(false);

    // Full discretion with commands off: the owner's marked mail is data. No model call, no
    // reply, no session.
    const calls = world.provider.calls.length;
    const outbox = world.server.outbox.length;
    const marked = await ownerSends(world, { subject: "Task", text: "Please fix the login bug." });
    expect(await world.handler.handle(world.agentId, await inboundOf(marked))).toMatchObject({
      kind: "ignored",
      reason: "disabled",
    });
    expect(world.provider.calls).toHaveLength(calls);
    expect(world.server.outbox).toHaveLength(outbox);
    expect(world.cloud.started).toHaveLength(0);
  });

  it("the acknowledgement reaches the owner in every mode that reads mail, with the send caps at zero and no approval ticket", async () => {
    for (const mode of ["read_only", "draft_only", "allowlist", "full_discretion"] as EmailMode[]) {
      const w = await emailWorld({ mode, dailySendCap: 0, perRecipientDailyCap: 0 });
      world = w;
      w.provider.pushReplies(
        interpretation(
          { kind: "task", project: "Sample", title: "Fix login", summary: "Fix the login bug" },
          "login",
        ),
      );
      const stored = await ownerSends(w, { subject: "Login", text: "Please fix the login bug." });
      const outcome = await w.handler.handle(w.agentId, await inboundOf(stored));
      expect(outcome.kind, mode).toBe("task");
      if (outcome.kind !== "task") throw new Error("unreachable");
      expect(outcome.ackMessageId, mode).not.toBeNull();
      const ack = lastOwnerMail(w);
      expect(ack?.parsed.inReplyTo, mode).toBe(stored.parsed.messageId);
      expect(ack?.parsed.text, mode).toContain("Understood: Fix the login bug");
      // The reply is not an approval matter: no HumanRequest was opened for it...
      expect(await w.store.humanRequest.open({ humanId: w.human.id }), mode).toEqual([]);
      // ...and it is logged as a reply to the human, outside the caps: no refused row.
      const rows = await sentRows(w);
      expect(
        rows.filter((r) => !r.row.allowed),
        mode,
      ).toEqual([]);
      expect(
        rows.map((r) => r.input.toHuman),
        mode,
      ).toEqual([true]);
      // The mode and the caps still hold for everyone else: nothing to a stranger goes out.
      let strangerSent = false;
      try {
        strangerSent = (await toStranger(w)).status === "sent";
      } catch {
        // refused by the mode or by the daily cap
      }
      expect(strangerSent, mode).toBe(false);
      await w.stop();
      world = undefined;
    }
  });
});
