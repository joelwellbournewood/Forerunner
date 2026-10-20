/**
 * Scenario 2, "Email task" (spec, Phase 8): "J emails a task with both PCs off. The cloud
 * runner acknowledges it, does it, and replies with results."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. The evening: both PCs are off
 * (no desktop device row was ever seen, no session runs with runner "pc"); the cloud runner of
 * Alice is composed in-process on the shared store (`scenario-cloud-runner.ts`: the runner's
 * device row, the PC-wins presence rule, the cloud runner's `EmailWatch` over Alice's mailbox
 * on the world's mail server, and the port that starts email sessions with runner "cloud").
 * J sends a task from his own mailbox through the authenticated path (DKIM-signed for the
 * domain, SPF pass, the private marker in the subject); the runner's gate verifies it in code,
 * the handler classifies it on the fake provider, files the task, starts a capped cloud session
 * and acknowledges within a simulated minute; the session does the task (coder on the fake
 * provider, PR on the fake git host, critic accepts) and the runner replies with the results
 * in the same thread. A spoofed copy of the same email (From claims J, a bogus DKIM signature,
 * from an address on the internet) is ignored by the gate and reported in the command audit:
 * no task, no session, no reply. Every clause is asserted on state rows, audit rows, events,
 * the mailboxes and the git host.
 *
 * Why in-process: `startCloudRunner` opens the shared state by URL and the scenario world's
 * store is in-memory; the runner's modules are composed on the world's store instead (see the
 * helper's header and testing.md, "Scenarios").
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform); the final-build runs are recorded in gates.md.
 */
import { SUBMIT_REVIEW_TOOL } from "@forerunner/critic";
import { DEFAULT_INJECT_IP, spoofedFrom } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ScenarioCloudRunner, scenarioCloudRunner } from "../src/scenario-cloud-runner.ts";
import { type AgentMailbox, agentMailbox, classifierSays } from "../src/scenario-mail.ts";
import { coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { advanceUntil, iso, waitFor } from "../src/scenario-support.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

const EVENING = iso("2026-11-03T21:00:00Z"); // 22:00 Europe/Zurich, 3 November 2026
const MARKER = "[FR-scen2]";
const TITLE = "Health endpoint";
const PHRASE = "health endpoint that answers with the service name";
const HEALTH = "export const health = () => ({ ok: true, name: 'service' });\n";
/** CHF 5 per email at 0.8 CHF/USD: the default per-email cap, the session's hard cap. */
const PER_EMAIL_CAP_USD_MICRO = 6_250_000;

describe("scenario 2: email task", () => {
  let w: ScenarioWorld;
  let mail: AgentMailbox;
  let runner: ScenarioCloudRunner;
  beforeAll(async () => {
    w = await scenarioWorld({ start: EVENING });
    mail = await agentMailbox(w, w.alice, { marker: MARKER });
    runner = await scenarioCloudRunner(w, w.alice, mail);
  });
  afterAll(async () => {
    await runner?.stop();
    await w?.close();
  });

  it("J emails a task with both PCs off; the cloud runner acknowledges it within a minute, does it and replies with results; a spoofed copy is ignored and reported", async () => {
    const jBox = w.j.mailbox;
    if (!jBox || !w.mail) throw new Error("the world has no mail server");
    w.provider.pushReplies(
      classifierSays(PHRASE, {
        kind: "task",
        project: "Sample service",
        title: TITLE,
        summary: "Add a health endpoint that answers with the service name",
      }),
      ...coderWrites(TITLE, { "src/health.ts": HEALTH }),
      ...criticAccepts(),
    );

    // --- Clause: both PCs off ---------------------------------------------------------------
    // No desktop of either human was ever paired or seen, and no session runs on a PC; the
    // runner's presence rule (what keeps it from taking over a schedule while a PC is on) says
    // so, and the runner itself is the only device of J.
    expect(await w.store.device.list({ kind: "desktop" })).toHaveLength(0);
    expect(await w.store.session.active(w.alice.agent.id)).toHaveLength(0);
    const presence = await runner.pcOnline();
    expect(presence).toMatchObject({ pcOnline: false, reason: "none" });
    expect(
      (await w.store.device.list({ owner_human_id: w.j.id })).map((d) => [d.kind, d.name]),
    ).toEqual([["runner", runner.runnerId]]);
    expect(runner.status()).toMatchObject({
      state: "watching",
      address: mail.address,
      pushActive: true,
      handled: 0,
    });

    // --- J emails the task from his own mailbox (signed for the domain, SPF pass, marker) --
    const sentAt = w.clock.now();
    const sent = await w.mail.sendFrom(w.j.email, {
      to: mail.address,
      subject: `${MARKER} ${TITLE} tonight`,
      text: `Please add a ${PHRASE} to the service tonight. Keep it tiny, no framework.`,
    });
    const aliceCopy = sent.delivered.find((m) => m.mailbox === mail.address);
    expect(aliceCopy?.authResults).toMatchObject({ dkim: "pass", aligned: true, spf: "pass" });

    // --- Clause: acknowledged within one simulated minute -----------------------------------
    // The watcher hands the message to the handler on push delivery; the handler verifies,
    // classifies, files the task, starts the session, acknowledges and audits, then reports
    // the outcome. The clock advances a second at a time meanwhile.
    const elapsed = await advanceUntil(w.clock, () => runner.outcomes.length >= 1, {
      maxMs: 60_000,
    });
    expect(elapsed).toBeLessThan(60_000);
    const ack = jBox.messages.find((m) => (m.parsed.text ?? "").startsWith("Understood:"));
    if (!ack) throw new Error("no acknowledgement");
    expect(w.clock.now() - sentAt).toBeLessThan(60_000);
    expect(Date.parse(ack.receivedAt) - sentAt).toBeLessThan(60_000);
    expect(ack.parsed.inReplyTo).toBe(sent.messageId);
    expect(ack.parsed.from?.value[0]?.address).toBe(mail.address);
    expect(ack.parsed.text).toContain("Understood: Add a health endpoint");
    expect(ack.parsed.text).toContain("Project: Sample service");
    expect(ack.parsed.text).toContain(`Task: ${TITLE} (`);
    expect(ack.parsed.text).toContain("Autonomy for this task: level 2");
    expect(ack.parsed.text).toMatch(/Session log: forerunner:\/\/sessions\//);
    // The ack went through the signed submission path of the agent's own mailbox.
    expect(ack.authResults).toMatchObject({ dkim: "pass", aligned: true, spf: "pass" });

    // The command was verified in code and the email, its interpretation and the result are
    // one audit row (T.3, T.5); the ack latency is recorded on it.
    const commands = await w.store.auditLog.list({
      agentId: w.alice.agent.id,
      tool: "email.command",
    });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    if (!command) throw new Error("no command audit row");
    expect(command.allowed).toBe(true);
    expect(command.denied_reason).toBeNull();
    expect(command.human_id).toBe(w.j.id);
    const commandInput = JSON.parse(command.input_summary) as {
      messageId: string;
      from: string;
      verdict: { reason: string; via: string; auth: Record<string, unknown> };
      injection: { suspicious: boolean };
    };
    expect(commandInput.from).toBe(w.j.email);
    expect(`<${commandInput.messageId}>`).toBe(sent.messageId);
    expect(commandInput.verdict).toMatchObject({
      reason: "ok",
      via: "marker",
      auth: { dkim: "pass", aligned: true, spf: "pass", source: "header" },
    });
    expect(commandInput.injection.suspicious).toBe(false);
    const commandResult = JSON.parse(command.result_summary) as {
      outcome: string;
      taskId: string;
      sessionId: string;
      capUsdMicro: number;
      autonomyLevel: number;
      ackLatencyMs: number;
      ackMessageId: string | null;
      interpretation: { kind: string; title: string };
    };
    expect(commandResult).toMatchObject({
      outcome: "task",
      capUsdMicro: PER_EMAIL_CAP_USD_MICRO,
      autonomyLevel: 2,
      interpretation: { kind: "task", title: TITLE },
    });
    expect(commandResult.ackLatencyMs).toBeGreaterThanOrEqual(0);
    expect(commandResult.ackLatencyMs).toBeLessThan(60_000);
    expect(`<${commandResult.ackMessageId}>`).toBe(ack.parsed.messageId);
    expect(command.session_id).toBe(commandResult.sessionId);
    expect(runner.outcomes).toHaveLength(1);
    expect(runner.outcomes[0]?.outcome).toMatchObject({
      kind: "task",
      taskId: commandResult.taskId,
      sessionId: commandResult.sessionId,
    });

    // --- Clause: the cloud runner does it ---------------------------------------------------
    expect(runner.sessions).toHaveLength(1);
    const record = runner.sessions[0];
    if (!record) throw new Error("no cloud session");
    expect(record.request).toMatchObject({
      agentId: w.alice.agent.id,
      humanId: w.j.id,
      projectId: w.project.id,
      taskId: commandResult.taskId,
      capUsdMicro: PER_EMAIL_CAP_USD_MICRO,
      autonomyLevel: 2,
      trigger: "email",
    });
    expect(record.started.sessionId).toBe(commandResult.sessionId);
    const result = await record.result;
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("completed");
    expect(result.plan?.items.map((i) => i.taskId)).toEqual([commandResult.taskId]);
    expect(result.completed).toEqual([commandResult.taskId]);
    expect(result.needsHuman).toEqual([]);
    const session = await w.store.session.mustGet(result.sessionId);
    expect(session).toMatchObject({
      agent_id: w.alice.agent.id,
      project_id: w.project.id,
      trigger: "email",
      runner: "cloud",
      device_id: runner.device.id,
      status: "completed",
      budget_cap_usd_micro: PER_EMAIL_CAP_USD_MICRO,
    });
    expect(session.started_at ?? "").not.toBe("");
    expect(session.spent_usd_micro).toBeGreaterThan(0);
    expect(session.spent_usd_micro).toBeLessThanOrEqual(PER_EMAIL_CAP_USD_MICRO);
    expect(session.spent_usd_micro).toBe(
      (await w.store.costLedger.sum({ sessionId: session.id })).usd_micro,
    );
    const events = await w.eventsOf(session.id);
    expect(events.find((e) => e.type === "session.started")?.payload).toMatchObject({
      trigger: "email",
      budgetCapUsdMicro: PER_EMAIL_CAP_USD_MICRO,
      autonomy: 2,
    });
    expect(events.find((e) => e.type === "email_command")?.payload).toMatchObject({
      auditId: command.id,
      outcome: "task",
    });
    expect(events.find((e) => e.type === "session.ended")?.payload).toMatchObject({
      status: "completed",
      stopReason: "completed",
    });
    // The task row the handler filed: tier 1, owned by Alice, done after the critic's accept.
    const task = await w.store.task.mustGet(commandResult.taskId);
    expect(task).toMatchObject({
      project_id: w.project.id,
      title: TITLE,
      risk_tier: 1,
      status: "done",
      owner_agent_id: w.alice.agent.id,
      claimed_by: null,
    });
    expect(task.budget_usd_micro).toBe(PER_EMAIL_CAP_USD_MICRO);
    expect(task.reason).toMatch(/^critic accepted/);
    // Done on the fake provider: one coder run, every tool call audited and allowed, the
    // critic's review on fake-sonnet.
    const runs = await w.store.run.forSession(session.id);
    expect(runs.every((r) => r.provider === "fake" && r.task_id === task.id)).toBe(true);
    const coderRuns = runs.filter((r) => r.specialist === "coder");
    expect(coderRuns).toHaveLength(1);
    expect(coderRuns[0]).toMatchObject({ outcome: "completed", model: "fake-sonnet" });
    expect(runs.length - coderRuns.length).toBe(1); // the critic's review run
    const reviews = await w.store.review.forTask(task.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      tier: 1,
      critic_model: "fake-sonnet",
      verdict: "accept",
      session_id: session.id,
    });
    const audit = await w.auditRows({ sessionId: session.id });
    // The ack and the completion carry the session id in the sent log; the rest are tool calls.
    const toolRows = audit.filter((r) => !r.tool.startsWith("email."));
    expect(toolRows.length).toBeGreaterThanOrEqual(2);
    expect(toolRows.filter((r) => !r.allowed)).toHaveLength(0);
    expect(
      toolRows.every((r) => ["write_file", "read_file", SUBMIT_REVIEW_TOOL].includes(r.tool)),
    ).toBe(true);
    expect(toolRows.filter((r) => r.tool === "write_file")).toHaveLength(1);
    // The work is a PR on the fake git host with the file J asked for.
    expect(task.pr_url).toBeTruthy();
    expect(task.branch).toBeTruthy();
    const pr = (await w.pullRequests({ state: "open" })).find((p) => p.htmlUrl === task.pr_url);
    expect(pr).toBeDefined();
    expect(pr?.head.ref).toBe(task.branch);
    expect(pr?.base.ref).toBe("main");
    expect(await w.fileOnHost("src/health.ts", task.branch ?? undefined)).toBe(HEALTH);
    expect(await w.fileOnHost("src/health.ts", "main")).toBeNull();
    // The ledger bills the cloud session's calls to Alice's own source, like any session.
    const ledger = await w.store.costLedger.list({ session_id: session.id });
    expect(ledger.length).toBeGreaterThan(0);
    for (const e of ledger) {
      expect(e.human_id).toBe(w.j.id);
      expect(e.billing_source_id).toBe("bs-alice");
    }

    // --- Clause: replies with results -------------------------------------------------------
    const completion = await waitFor(
      () => jBox.messages.find((m) => (m.parsed.text ?? "").startsWith("Done:")),
      "completion email",
    );
    expect(completion.parsed.inReplyTo).toBe(sent.messageId);
    expect(completion.parsed.subject).toBe(`Re: ${MARKER} ${TITLE} tonight`);
    expect(completion.parsed.text).toContain("Done: Session completed.");
    expect(completion.parsed.text).toContain(`Pull requests:\n- ${task.pr_url}`);
    expect(completion.parsed.text).toContain(`Session log: forerunner://sessions/${session.id}`);
    expect(completion.parsed.text).toMatch(/Cost: CHF /);
    // Both replies are in the agent's sent log, threaded under J's email (T.10).
    const sentLog = await w.store.auditLog.list({ agentId: w.alice.agent.id, tool: "email.send" });
    expect(sentLog.every((r) => r.allowed)).toBe(true);
    expect(
      sentLog.map((r) => (JSON.parse(r.input_summary) as { kind?: string }).kind).sort(),
    ).toEqual(["ack", "completion"]);
    expect(
      sentLog.map((r) => (JSON.parse(r.result_summary) as { status?: string }).status),
    ).toEqual(["sent", "sent"]);
    // J's inbox in the app holds the session summary as well.
    const summary = (await w.inbox(w.j)).find(
      (m) => m.type === "info" && m.from_agent_id === w.alice.agent.id,
    );
    expect(summary?.body).toBe(session.summary);
    expect(summary?.body).toMatch(/^Session completed\. Done: 1\./);
    expect(await w.humanRequests(w.j, { status: "open" })).toHaveLength(0);
    // Nothing left the machine: the mail server's outbox (mail for the internet) is empty.
    expect(w.mail.outbox).toHaveLength(0);
    expect(jBox.messages).toHaveLength(2);

    // --- Clause: a spoofed copy of the same email is ignored and reported --------------------
    // Same From, same subject (marker included), same words, a DKIM-Signature whose value is
    // random, delivered from an address on the internet: the gate refuses it before anything
    // is classified, and the refusal is in the command audit.
    const spoofRaw = await spoofedFrom(w.j.email, {
      to: mail.address,
      subject: `${MARKER} ${TITLE} tonight`,
      text: `Please add a ${PHRASE} to the service tonight. Keep it tiny, no framework.`,
      bogusSignature: true,
      clock: w.clock,
    });
    const [spoof] = await w.mail.inject(spoofRaw, { skipSigning: true, fromIp: DEFAULT_INJECT_IP });
    if (!spoof) throw new Error("the spoof was not delivered");
    expect(spoof.mailbox).toBe(mail.address);
    expect(spoof.authResults.dkim).toBe("fail");
    expect(spoof.authResults.spf).not.toBe("pass");
    await advanceUntil(w.clock, () => runner.outcomes.length >= 2, { maxMs: 60_000 });
    const ignored = runner.outcomes[1];
    expect(ignored?.message.id).toBe(spoof.id);
    expect(ignored?.outcome).toMatchObject({ kind: "ignored", reason: "dkim_fail" });
    const rows = await w.store.auditLog.list({ agentId: w.alice.agent.id, tool: "email.command" });
    expect(rows).toHaveLength(2);
    const refused = rows.find((r) => !r.allowed);
    if (!refused) throw new Error("the spoof has no audit row");
    expect(refused.denied_reason).toBe("ignored: dkim_fail");
    expect(refused.session_id).toBeNull();
    const refusedInput = JSON.parse(refused.input_summary) as {
      from: string;
      mailboxId: string;
      verdict: { reason: string; auth: Record<string, unknown> };
    };
    expect(refusedInput.from).toBe(w.j.email);
    expect(refusedInput.mailboxId).toBe(spoof.id);
    expect(refusedInput.verdict).toMatchObject({
      reason: "dkim_fail",
      auth: { dkim: "fail", aligned: false, source: "header" },
    });
    expect(JSON.parse(refused.result_summary)).toEqual({ outcome: "ignored", reason: "dkim_fail" });
    // Reported: the command audit the UI shows (T.14) names it as not obeyed, with the reason.
    const commandAudit = await runner.watch.handler.commandAudit(w.alice.agent.id);
    expect(commandAudit.map((c) => `${c.obeyed}:${c.deniedReason}`).sort()).toEqual([
      "false:ignored: dkim_fail",
      "true:null",
    ]);
    // Nothing happened: no second task, no second session, no reply, nothing sent.
    expect(await w.store.task.list({ project_id: w.project.id })).toHaveLength(1);
    expect(await w.store.session.list({ agent_id: w.alice.agent.id })).toHaveLength(1);
    expect(runner.sessions).toHaveLength(1);
    expect(jBox.messages).toHaveLength(2);
    expect(w.mail.outbox).toHaveLength(0);
    expect(runner.status().handled).toBe(2);
    // The handled messages are marked seen, so a catch-up poll never hands them over again.
    expect(await mail.mailbox.listUnseen()).toHaveLength(0);

    // --- Secrets: no token reached a row, an event or a mail --------------------------------
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.message.list(),
      await w.store.task.list(),
      await w.store.session.list(),
      events,
      jBox.messages.map((m) => m.raw),
    ]);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 90_000);
});
