import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { ConfirmationPolicy } from "../src/confirmation.ts";
import { staticRisk } from "../src/registry.ts";
import type { Risk } from "../src/types.ts";
import { settle, world } from "./helpers.ts";

/**
 * Security review of the command registry's risk classes, read-back rules and undo (spec Q,
 * ADR 0030): the always-human commands carry the risk the spec gives them, a pending card
 * cannot be confirmed by the wrong kind of answer, a guessed email token or another actor,
 * and the device rule holds for every device kind. A test marked `it.fails` is a finding on
 * the current code (comment above it).
 */

describe("risk classes are what the spec says, before any parameter is known", () => {
  it("the commands that always need a human are high risk with a limit flag; starting a session is at most medium", async () => {
    const w = await world();
    const expected: Record<string, { risk: Risk; limit?: boolean }> = {
      "capability.grant": { risk: "high", limit: true },
      "autonomy.set": { risk: "high", limit: true },
      "budget.set": { risk: "high", limit: true },
      "email.mode.set": { risk: "high", limit: true },
      "device.revoke": { risk: "high" },
      "request.answer": { risk: "high" },
      "settings.set": { risk: "high" },
      "session.start": { risk: "medium" },
      "task.transition": { risk: "medium" },
    };
    for (const [name, want] of Object.entries(expected)) {
      const def = w.registry.mustGet(name);
      expect(staticRisk(def), name).toBe(want.risk);
      if (want.limit) expect(def.limit, `${name} limit`).toBe(true);
    }
    // The persisted command table shows the same risks to the UI.
    const rows = await w.store.command.list({}, { limit: 100 });
    for (const [name, want] of Object.entries(expected)) {
      expect(rows.find((r) => r.name === name)?.risk, name).toBe(want.risk);
    }
  });

  it("an agent raising its own autonomy by one step is medium (a yes), by two steps high (a device); never 'act'", async () => {
    const w = await world();
    const agentCtx = w.ctx({ actor: { kind: "agent", id: w.agent.id } });
    const one = await w.executor.execute({
      name: "autonomy.set",
      params: { level: 3, project: "PharmaWatch" },
      ctx: agentCtx,
    });
    expect(one.status).toBe("pending");
    if (one.status === "pending") expect(one.decision).toBe("needs_yes");
    const two = await w.executor.execute({
      name: "autonomy.set",
      params: { level: 4, project: "PharmaWatch" },
      ctx: agentCtx,
    });
    expect(two.status).toBe("pending");
    if (two.status === "pending") expect(two.decision).toBe("needs_device");
    expect((await w.store.project.get(w.pharma.id))?.autonomy_level).toBe(2);
  });
});

describe("a pending change card and the answers it does not accept", () => {
  it("a tap or a yes, from the agent or from the right human, never confirms a high-risk card; the state is untouched", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "autonomy.set",
      params: { level: 4, project: "PharmaWatch" },
      ctx: w.ctx(),
    });
    expect(r.status).toBe("pending");
    if (r.status !== "pending") return;
    const human = { kind: "human" as const, id: w.human.id };
    const agent = { kind: "agent" as const, id: w.agent.id };
    for (const answer of [
      { kind: "tap" as const, by: human },
      { kind: "yes" as const, by: human },
      { kind: "yes" as const, by: agent },
      { kind: "email" as const, token: r.emailToken, by: human },
      { kind: "device" as const, deviceId: w.phone.id, biometric: false },
      { kind: "device" as const, deviceId: w.phone.id, biometric: true, by: agent },
      { kind: "device" as const, deviceId: "no-such-device", biometric: true },
    ]) {
      const out = await w.executor.confirm(r.pendingId, answer);
      expect(out.status, JSON.stringify(answer)).toBe("refused");
      if (out.status === "refused") expect(out.code).toBe("approval_required");
    }
    expect(w.executor.getPending(r.pendingId)).toBeDefined();
    expect((await w.store.project.get(w.pharma.id))?.autonomy_level).toBe(2);
    const done = await w.executor.confirmFromDevice(r.pendingId, {
      deviceId: w.phone.id,
      biometric: true,
    });
    expect(done.status).toBe("done");
    expect((await w.store.project.get(w.pharma.id))?.autonomy_level).toBe(4);
  });

  it("a guessed email token confirms nothing and leaks nothing; the right token confirms once", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "budget.set",
      params: { amountChf: 30, scope: "session", project: "PharmaWatch" },
      ctx: w.ctx(),
    });
    expect(r.status).toBe("pending");
    if (r.status !== "pending") return;
    const human = { kind: "human" as const, id: w.human.id };
    for (const guess of [
      "",
      "FR-",
      "FR-aaaaaa",
      r.emailToken.toUpperCase(),
      `${r.emailToken} `,
      r.emailToken.slice(0, -1),
    ]) {
      const out = await w.executor.confirmByToken(guess, human);
      expect(out.status).toBe("refused");
      if (out.status === "refused") expect(out.reason).not.toContain(r.emailToken);
    }
    expect((await w.executor.confirmByToken(r.emailToken, human)).status).toBe("done");
    expect((await w.executor.confirmByToken(r.emailToken, human)).status).toBe("refused");
    await settle();
  });

  // security finding (low): `ConfirmationPolicy.check` required the biometric flag only for
  // `device.kind === "phone"`. A `web` device (ADR 0034: the page "always signs biometric=0";
  // high risk on the web is a re-entered code checked by the state service) and a `runner`
  // device therefore confirmed a high-risk change here without any second factor. The state
  // service is the first line for answers that come through it; this policy is the line for
  // answers that reach the daemon directly, and it accepts `desktop`, and `phone` with
  // biometric, only. The security critic's follow-up: a `web` or `runner` device presenting
  // `biometric: true` is refused as well; there is no second factor those kinds can bring.
  it("security finding: a web or runner device never confirms a high-risk change, with or without a biometric flag", async () => {
    const w = await world();
    const web = await w.store.device.register({
      owner_human_id: w.human.id,
      name: "Browser tab",
      platform: "web",
      public_key: ["pk", "web", "fixture"].join("-"), // not-a-secret
      kind: "web",
    });
    const runner = await w.store.device.register({
      owner_human_id: w.human.id,
      name: "Cloud runner",
      platform: "linux",
      public_key: ["pk", "runner", "fixture"].join("-"), // not-a-secret
      kind: "runner",
    });
    const policy = new ConfirmationPolicy();
    const ctx = (device: typeof web) => ({ humanId: w.human.id, emailToken: "", device });
    for (const device of [web, runner]) {
      for (const biometric of [false, true]) {
        let refused: unknown;
        try {
          policy.check(
            "needs_device",
            { kind: "device", deviceId: device.id, biometric },
            ctx(device),
          );
        } catch (e) {
          refused = e;
        }
        expect(refused, `${device.kind} biometric=${biometric}`).toBeDefined();
        expect(isForerunnerError(refused, "approval_required")).toBe(true);
        expect((refused as Error).message).toContain(device.kind);
      }
    }
    // The two kinds that can confirm still do: the desktop alone, the phone with biometric.
    expect(
      policy.check(
        "needs_device",
        { kind: "device", deviceId: w.desktop.id, biometric: false },
        ctx(w.desktop),
      ),
    ).toBe("confirmed");
    expect(
      policy.check(
        "needs_device",
        { kind: "device", deviceId: w.phone.id, biometric: true },
        ctx(w.phone),
      ),
    ).toBe("confirmed");
  });
});

describe("undo belongs to a human", () => {
  it("an agent cannot undo its human's change, and a change that was undone cannot be undone again", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "note.add",
      params: { text: "remember the tests", kind: "note", project: "PharmaWatch" },
      ctx: w.ctx(),
    });
    expect(r.status).toBe("done");
    if (r.status !== "done" || !r.undoToken) return;
    const byAgent = await w.executor.undo(
      r.undoToken,
      w.ctx({ actor: { kind: "agent", id: w.agent.id } }),
    );
    expect(byAgent.status).toBe("refused");
    const byOther = await w.executor.undo(
      r.undoToken,
      w.ctx({ actor: { kind: "human", id: w.other.id }, humanId: w.other.id }),
    );
    expect(byOther.status).toBe("refused");
    expect((await w.executor.undo(r.undoToken, w.ctx())).status).toBe("done");
    expect((await w.executor.undo(r.undoToken, w.ctx())).status).toBe("refused");
    expect((await w.store.queue.pending(w.pharma.id)).length).toBe(0);
  });
});
