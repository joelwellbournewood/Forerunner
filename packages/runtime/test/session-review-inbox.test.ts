import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { type HumanRequestView, InboxView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";

/**
 * U-033: a session review that needs the person (the summary they received says more tasks
 * were done than the records show) filed its request for nobody (`human_id: null`), so no
 * inbox listed it, and its options ("acknowledge", "cancel") had no reader. Here a session
 * ends with such a summary, the critic reviews it the way the session runner asks, the Inbox
 * lists the request, and each option is clicked with the string the Inbox shows.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const opened: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of opened.splice(0)) await rt.close();
});

async function daemon() {
  const home = mkdtempSync(join(tmpdir(), "fr-u033-"));
  const clock = new SimulatedClock("2026-10-31T20:00:00Z");
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider: new FakeProvider({ replies: [textReply("Noted.")], clock, latency: "none" }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    startServices: false,
  });
  opened.push(rt);
  const { app, token } = createDaemonApp(rt);
  const req = (path: string, init: RequestInit = {}) =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );
  return { rt, req, clock };
}

type Daemon = Awaited<ReturnType<typeof daemon>>;

/**
 * A finished session whose summary says "Done: 2" while one of its two planned tasks is done,
 * reviewed through the runtime's critic port as the session runner does at session end.
 */
async function untrueSession(d: Daemon): Promise<{ sessionId: string; requestId: string }> {
  const { rt, clock } = d;
  const project = await rt.store.project.insert({
    name: "PharmaWatch",
    goal: "Watch pharma news",
    settings: { members: [rt.agent.id] },
  });
  const task = (title: string, status: "done" | "in_review") =>
    rt.store.task.insert({
      project_id: project.id,
      title,
      acceptance_criteria: ["works"],
      status,
      owner_agent_id: rt.agent.id,
    });
  const done = await task("Fetch the feed", "done");
  const open = await task("Parse the feed", "in_review");
  const session = await rt.store.session.insert({
    agent_id: rt.agent.id,
    project_id: project.id,
    trigger: "manual",
    plan: {
      items: [done, open].map((t) => ({ taskId: t.id, title: t.title, estimateUsdMicro: 1000 })),
      estimateUsdMicro: 2000,
      summary: "two tasks",
    },
    budget_cap_usd_micro: 5_000_000,
    status: "completed",
    summary: "Session completed. Done: 2. In review: 0. Spent $0.00.",
    // A plan write carries its reason and author (spec B.5).
    reason: "planned by the session",
    author_agent: rt.agent.id,
  });
  const token = rt.tokens.issue({
    runId: "r-review",
    sessionId: session.id,
    agentId: rt.agent.id,
    ownerHumanId: rt.human.id,
    projectId: project.id,
    allowedTools: [],
    allowedPaths: [],
    allowedDomains: [],
    grantedSecrets: [],
    budgetUsdMicro: 1_000_000,
    depth: 0,
    maxDepth: 2,
    autonomy: 2,
    planApproved: false,
    expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
  });
  const review = await rt.critic.reviewSession({
    sessionId: session.id,
    token,
    budget: new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 1_000_000,
      stepCap: 10,
      deadlineMs: clock.now() + 3_600_000,
      reserveShare: 0.1,
    }),
    agentId: rt.agent.id,
    projectId: project.id,
  });
  expect(review.verdict).toBe("human");
  expect(review.humanRequestId).toBeDefined();
  return { sessionId: session.id, requestId: review.humanRequestId as string };
}

async function shown(d: Daemon, id: string): Promise<HumanRequestView | undefined> {
  const inbox = InboxView.parse(await (await d.req("/inbox")).json());
  return inbox.requests.find((r) => r.id === id && r.status === "open");
}

async function click(d: Daemon, card: HumanRequestView, option: string): Promise<void> {
  const r = await d.req(`/requests/${card.id}/answer`, {
    method: "POST",
    body: JSON.stringify({ version: card.version, answer: option }),
  });
  expect(r.status).toBe(200);
}

async function reviewFindings(d: Daemon, sessionId: string) {
  const reviews = await d.rt.store.review.forSession(sessionId);
  return d.rt.store.finding.forReview(reviews[0]?.id ?? "");
}

async function summaryOf(d: Daemon, sessionId: string): Promise<string> {
  const r = await d.req(`/sessions/${sessionId}`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as { summary?: string; session?: { summary?: string } };
  return body.summary ?? body.session?.summary ?? "";
}

describe("a session review that needs the person reaches the Inbox (U-033)", () => {
  it("is listed in GET /inbox for the session's owner with options that each do something", async () => {
    const d = await daemon();
    const { requestId } = await untrueSession(d);
    const card = await shown(d, requestId);
    expect(card).toBeDefined();
    expect(card?.why).toContain("Session review needs your eyes");
    expect(card?.steps.join(" ")).toContain("Summary claims 2 task(s) done but 1");
    expect(card?.options).toEqual(["Acknowledge", "Correct the summary"]);
  });

  it('"Acknowledge" closes it: the review\'s findings are marked seen, the summary stays as it was', async () => {
    const d = await daemon();
    const { sessionId, requestId } = await untrueSession(d);
    const before = await summaryOf(d, sessionId);
    const card = (await shown(d, requestId)) as HumanRequestView;
    await click(d, card, card.options[0] as string);
    expect(await shown(d, requestId)).toBeUndefined();
    const findings = await reviewFindings(d, sessionId);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.status === "wontfix")).toBe(true);
    expect(await summaryOf(d, sessionId)).toBe(before);
    const row = await d.rt.store.humanRequest.mustGet(requestId);
    expect(row.change_card).toMatchObject({ outcome: "acknowledged" });
  });

  it('"Correct the summary" writes the true numbers into the session\'s summary and resolves the finding', async () => {
    const d = await daemon();
    const { sessionId, requestId } = await untrueSession(d);
    const card = (await shown(d, requestId)) as HumanRequestView;
    await click(d, card, card.options[1] as string);
    expect(await shown(d, requestId)).toBeUndefined();
    const summary = await summaryOf(d, sessionId);
    expect(summary).toContain("Session completed. Done: 2.");
    expect(summary).toContain("Corrected after the session review");
    expect(summary).toContain("1 of the task(s) the session planned or ran are done");
    expect(summary).toContain("the summary said 2 done");
    const findings = await reviewFindings(d, sessionId);
    const lie = findings.find((f) => f.description.startsWith("Summary claims"));
    expect(lie?.status).toBe("resolved");
    expect(findings.every((f) => f.status !== "open")).toBe(true);
    // Applied once: another sync adds no second correction.
    await d.rt.syncApprovals();
    expect((await summaryOf(d, sessionId)).match(/Corrected after/g)).toHaveLength(1);
  });
});
