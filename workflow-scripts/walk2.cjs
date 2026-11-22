// Reviewer's walk of L4-chat-103: Cancel on a session that waits to go on, then Last result and
// chat 'summary' without a reload, and after a daemon restart.
const repo = process.argv[2];
const phase = process.argv[3] ?? "first";
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-answers";
const UI = "http://127.0.0.1:2591";
const fs = require("fs");
const OUT = `/tmp/frbench/review-l4-chat-answers/walk2-${phase}.json`;
const enc = encodeURIComponent;

(async () => {
  const out = { steps: [] };
  const save = (k, v) => {
    out[k] = v;
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  };
  const { browser, page } = await R.openApp(N, { freshProfile: phase === "first" });
  const settle = async (wait = 30_000) => {
    await page.waitForTimeout(900);
    const until = Date.now() + wait;
    while (Date.now() < until) {
      const busy = await page.getByRole("button", { name: "Stop", exact: true }).count();
      if (!busy) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(900);
  };
  const say = async (text) => {
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill(text);
    await box.press("Enter");
    await settle();
  };
  const lastResult = async () => {
    const el = page.getByTestId("last-result");
    return (await el.count()) ? await el.first().innerText() : null;
  };
  try {
    await R.skipSetup(page).catch(() => undefined);
    let projectId;
    if (phase === "first") {
      const me = await R.api(N, "GET", "/me");
      const project = await R.api(N, "POST", "/projects", { name: "Garden club", goal: "Two notes" });
      projectId = project.id;
      for (const f of ["notes/a.md", "notes/b.md"])
        await R.api(N, "POST", `/projects/${enc(project.id)}/tasks`, {
          title: `Write ${f}`,
          outcome: `${f} exists with a short note`,
          acceptanceCriteria: [`${f} exists`],
          priority: "medium",
          status: "ready",
          dependsOn: [],
          specialist: "writer",
          riskTier: 0,
        });
      const started = await R.api(N, "POST", "/sessions", {
        agentId: me.agent.id,
        projectId: project.id,
        trigger: "manual",
        reason: "review walk",
      });
      const session = await R.waitForSession(N, started.session.id, 300_000);
      save("session", { status: session.status, summary: session.summary });
      save("projectId", projectId);
      save("running", await R.api(N, "GET", "/running").catch((e) => String(e)));
      await page.goto(`${UI}/projects/${enc(projectId)}`);
      await page.waitForTimeout(3000);
      save("lastResultBefore", await lastResult());
      out.steps.push(await R.step(page, "w2-01-overview-waiting"));
      // Cancel on the run indicator bar.
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      save("cancelButtons", await cancel.count());
      if (await cancel.count()) {
        await cancel.first().click();
        await page.waitForTimeout(800);
        // A confirm step, if any.
        const again = page.getByRole("button", { name: /^Cancel/ });
        save("afterClickButtons", await again.allInnerTexts());
      }
      await page.waitForTimeout(4000);
      save("lastResultAfterCancel", await lastResult());
      out.steps.push(await R.step(page, "w2-02-overview-after-cancel"));
      save("runningAfter", await R.api(N, "GET", "/running").catch((e) => String(e)));
      await page.goto(`${UI}/projects/${enc(projectId)}/chat`);
      await page.waitForTimeout(2500);
      await say("summary");
      const turns = (await R.api(N, "GET", `/projects/${enc(projectId)}/conversation`)).turns;
      save("summaryReply", turns.at(-1)?.reply?.text);
      out.steps.push(await R.step(page, "w2-03-chat-summary"));
    } else {
      projectId = JSON.parse(fs.readFileSync(`/tmp/frbench/review-l4-chat-answers/walk2-first.json`, "utf8")).projectId;
      await page.goto(`${UI}/projects/${enc(projectId)}`);
      await page.waitForTimeout(3500);
      save("lastResultAfterRestart", await lastResult());
      out.steps.push(await R.step(page, "w2-04-overview-after-restart"));
      await page.goto(`${UI}/projects/${enc(projectId)}/chat`);
      await page.waitForTimeout(2500);
      await say("summary");
      const turns = (await R.api(N, "GET", `/projects/${enc(projectId)}/conversation`)).turns;
      save("summaryReplyAfterRestart", turns.at(-1)?.reply?.text);
      out.steps.push(await R.step(page, "w2-05-chat-summary-after-restart"));
    }
  } catch (e) {
    save("error", String(e?.stack ?? e));
  } finally {
    save("done", true);
    await browser.close();
  }
})();
