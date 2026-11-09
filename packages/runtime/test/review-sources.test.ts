import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { SUBMIT_REVIEW_TOOL } from "@forerunner/critic";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ChatMessage, ModelRequest } from "../src/provider/types.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * The review reads the pages a task's work rests on (W15-26), through the composed runtime and
 * its routes, with the stand-in model and a page server on this computer.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
type Req = (path: string, init?: RequestInit) => Response | Promise<Response>;
const WRAP = "About a fifth of this task's budget is left";
const textOf = (m: ChatMessage) =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
const heardWrapUp = (r: ModelRequest) =>
  r.messages.some((m) => m.role === "user" && textOf(m).includes(WRAP));
const isReview = (r: ModelRequest) => (r.tools ?? []).some((t) => t.name === SUBMIT_REVIEW_TOOL);

/** Polls in real time (at least 10 s); the error says what was seen last. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: () => Promise<string>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${await what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * w15-review, wave 15. W15-26 (live check 2, research F6): a research task read ten pages,
 * paused at its budget, and after Continue its run read none; its review saw none of the pages
 * the work rests on and was told the evidence was complete. Now each run keeps what it read for a
 * later review (the Run row's `reviewSources`), and the review reads the pages of the task's
 * earlier runs too.
 */
describe("w15-review, wave 15", () => {
  const clock = new SimulatedClock("2026-11-09T04:24:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-w15-review-"));
  const calls: ModelRequest[] = [];
  const pages: Record<string, string> = {
    "/netlify.html":
      "<!doctype html><title>Netlify pricing</title><main><p>Netlify's free plan includes 100 GB of bandwidth a month.</p></main>",
    "/pages.html":
      "<!doctype html><title>Cloudflare Pages limits</title><main><p>Cloudflare Pages allows 500 builds a month on the free plan.</p></main>",
  };
  let server: http.Server;
  let base = "";
  let rt: RuntimeApp;
  let req: Req;
  const TITLE = "Compare two hosts";
  // Both cases' tasks start with the title.
  const researcherOn = (r: ModelRequest) =>
    (r.origin?.label ?? "").startsWith(`researcher on ${TITLE}`);
  const firstUser = (r: ModelRequest) => {
    const m = r.messages.find((x) => x.role === "user");
    return m ? textOf(m) : "";
  };
  const continued = (r: ModelRequest) =>
    researcherOn(r) && firstUser(r).includes("## Where the last run stopped");
  const fetched = (r: ModelRequest, path: string) =>
    JSON.stringify(r.messages).includes(`${base}${path}`);

  beforeAll(async () => {
    server = http.createServer((q, res) => {
      const body = pages[q.url ?? ""];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fake = new FakeProvider({
      clock,
      latency: "none",
      onNoMatch: "echo",
      replies: [
        submitReply({}, { times: Number.POSITIVE_INFINITY }),
        closingReply(),
        // The continued run reads nothing: it writes the file from what the paused run read.
        textReply(
          "Wrote hosts.md: Netlify 100 GB a month, Cloudflare Pages 500 builds a month.\n\nLeft to do: nothing",
          { when: continued, times: Number.POSITIVE_INFINITY },
        ),
        textReply(
          "Summary: read both pricing pages.\n\nWhere I stopped: both pages are read; hosts.md is not written yet.\n\nLeft to do:\n- write hosts.md",
          {
            when: (r) => researcherOn(r) && heardWrapUp(r),
            times: Number.POSITIVE_INFINITY,
            usage: { input_tokens: 1_000, output_tokens: 50 },
          },
        ),
        toolReply("web_fetch", { url: `${base}/pages.html` }, "Reading the second page.", {
          when: (r) => researcherOn(r) && fetched(r, "/netlify.html") && !fetched(r, "/pages.html"),
          times: Number.POSITIVE_INFINITY,
          usage: { input_tokens: 30_000, output_tokens: 10 },
        }),
        toolReply("web_fetch", { url: `${base}/netlify.html` }, "Reading the first page.", {
          when: (r) => researcherOn(r) && !fetched(r, "/netlify.html"),
          times: Number.POSITIVE_INFINITY,
          usage: { input_tokens: 30_000, output_tokens: 10 },
        }),
        toolReply("list_dir", { path: "." }, "Looking at the folder.", {
          when: researcherOn,
          times: Number.POSITIVE_INFINITY,
          usage: { input_tokens: 30_000, output_tokens: 10 },
        }),
      ],
    });
    const stream = fake.stream.bind(fake);
    fake.stream = (r) => {
      calls.push({ ...r, messages: structuredClone(r.messages) });
      return stream(r);
    };
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      provider: fake,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      // The fixture is on this computer: the page reader's development seam, as the bench uses.
      webReadLoopback: true,
    });
    const { app, token } = createDaemonApp(rt);
    req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  /**
   * A researcher task on `title` that reads both pages, pauses at its budget, and is continued
   * (`beforeContinue` runs while it waits); the continued run reads nothing and finishes. Returns
   * the critic's first request of its one review.
   */
  async function pauseAndContinue(
    title: string,
    beforeContinue: (taskId: string) => Promise<void> = async () => {},
  ): Promise<{ taskId: string; sent: string }> {
    const projectId = (
      (await (
        await req("/projects", {
          method: "POST",
          body: JSON.stringify({ name: `${title} notes`, goal: "Pick a host for the club site" }),
        })
      ).json()) as Json
    ).id as string;
    const created = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title,
        outcome: "hosts.md compares the free plans of Netlify and Cloudflare Pages, with sources",
        acceptanceCriteria: ["Every figure names the page it was read from"],
        priority: "high",
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 300_000,
        specialist: "researcher",
        riskTier: 1,
      }),
    });
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as Json).id as string;
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    });
    expect(started.status, await started.clone().text()).toBe(202);
    const card = await waitFor(
      async () =>
        ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.find(
          (q) => q.taskId === taskId && q.status === "open",
        ),
      async () => `"${title}" to pause (${(await rt.store.task.mustGet(taskId)).status})`,
    );
    // The paused run read both pages; nothing reviewed it.
    const paused = (await rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
    expect(paused.map((r) => r.outcome)).toEqual(["paused"]);
    expect(calls.filter((c) => isReview(c) && firstUser(c).includes(title))).toEqual([]);
    const idle = async () =>
      waitFor(
        async () => ((await rt.store.session.active(rt.agent.id)).length === 0 ? true : undefined),
        async () => "no session to be running",
      );
    await idle();
    await beforeContinue(taskId);
    // Continue: the next session's run reads nothing and finishes; the critic reviews it.
    const choice = ((card.choices ?? []) as Json[])[0] as Json;
    expect(String(choice.label)).toMatch(/^Continue \(CHF/);
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: choice.label }),
    });
    expect(answered.status).toBe(200);
    await waitFor(
      async () => ((await rt.store.task.mustGet(taskId)).status === "done" ? true : undefined),
      async () => `"${title}" to be done (${(await rt.store.task.mustGet(taskId)).status})`,
    );
    await idle();
    // The continued run read nothing: its Run row lists no page.
    const work = (await rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
    expect(work.map((r) => r.outcome).sort()).toEqual(["completed", "paused"]);
    const done = work.find((r) => r.outcome === "completed");
    expect(JSON.stringify(done?.artifacts)).not.toContain("webSources");
    // One review (one critic run); its first request is what the critic was given.
    expect(
      (await rt.store.run.forTask(taskId)).filter((r) => r.specialist === "critic"),
    ).toHaveLength(1);
    const review = calls.find((c) => isReview(c) && firstUser(c).includes(`task ${taskId}`));
    return { taskId, sent: firstUser(review as ModelRequest) };
  }

  it("W15-26: after a pause and Continue, the review reads every page the paused run read", async () => {
    const { taskId, sent } = await pauseAndContinue(TITLE);
    expect(sent).toContain(
      `### web page ${base}/netlify.html (read by an earlier run of this task)`,
    );
    expect(sent).toContain("Netlify's free plan includes 100 GB of bandwidth a month.");
    expect(sent).toContain(`### web page ${base}/pages.html (read by an earlier run of this task)`);
    expect(sent).toContain("Cloudflare Pages allows 500 builds a month on the free plan.");
    // What the drawer reads keeps the addresses only: the text never reaches a screen.
    const detail = (await (await req(`/tasks/${taskId}`)).json()) as Json;
    expect(JSON.stringify(detail)).not.toContain("100 GB of bandwidth");
    expect(JSON.stringify(detail)).toContain(`${base}/netlify.html`);
  }, 120_000);

  it("W15-26: a page whose text an earlier run did not keep is listed under 'Evidence not available', never 'complete'", async () => {
    // A Run row written before this change keeps the addresses only.
    const { sent } = await pauseAndContinue(`${TITLE} (older run)`, async (taskId) => {
      const [run] = (await rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
      if (!run) throw new Error("no paused run");
      await rt.store.run.patch(run.id, {
        artifacts: run.artifacts.filter(
          (a) => !(a && typeof a === "object" && !Array.isArray(a) && "reviewSources" in a),
        ),
      });
    });
    expect(sent).not.toContain("### web page");
    const unavailable = sent.slice(sent.indexOf("## Evidence not available"));
    for (const path of ["/netlify.html", "/pages.html"])
      expect(unavailable).toContain(
        `- web page ${base}${path}: an earlier run of this task read it; its text was not kept for this review`,
      );
    expect(sent).not.toContain("(nothing: every section above is complete");
  }, 120_000);
});
