// Review walk 1 (l4-chat-depth): the chat's depth lines on a project with a failed task.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk1.json";

(async () => {
  const out = { steps: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const idle = async (wait = 40_000) => {
    const until = Date.now() + wait;
    while (Date.now() < until) {
      const busy = await page.getByRole("button", { name: "Stop", exact: true }).count();
      if (!busy) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1200);
  };
  const say = async (text) => {
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill(text);
    await box.press("Enter");
    await page.waitForTimeout(900);
    await idle();
  };
  const press = async (name) => {
    const b = page.getByRole("button", { name, exact: true });
    const n = await b.count();
    out.buttons = [...(out.buttons ?? []), { name, count: n }];
    if (!n) return false;
    await b.last().click();
    await page.waitForTimeout(900);
    await idle();
    return true;
  };
  const shot = async (label) => {
    out.steps[label] = await R.step(page, label);
    save();
  };
  try {
    await R.skipSetup(page).catch(() => undefined);
    const planned = await R.createPlannedProject(N, {
      project: "Garden club",
      goal: "A web page for the garden club",
      brief: "A small web page for our garden club with an index.html page, a stylesheet and a script, and a README.",
    });
    out.projectId = planned.projectId;
    out.tasks = planned.tasks.map((t) => ({ title: t.title, status: t.status }));
    save();
    // Approve already starts a session (Approve and start); wait for it to end.
    await R.until(
      async () => {
        const s = await R.api(N, "GET", `/projects/${planned.projectId}/tasks`);
        const running = s.some((t) => t.status === "running" || t.status === "in_review");
        const sessions = await R.api(N, "GET", `/sessions?projectId=${planned.projectId}`).catch(() => []);
        const live = (Array.isArray(sessions) ? sessions : sessions.sessions ?? []).some((x) =>
          ["running", "starting", "queued"].includes(x.status),
        );
        return !running && !live && s.some((t) => /styles/.test(t.title) && t.status !== "ready") ? s : null;
      },
      240_000,
      2000,
      "the first session to end with the stylesheet task failed",
    ).catch((e) => (out.waitError = String(e)));
    const tasks = await R.api(N, "GET", `/projects/${planned.projectId}/tasks`);
    out.tasksAfter = tasks.map((t) => ({ title: t.title, status: t.status, reason: t.reason }));
    save();
    const styles = tasks.find((t) => /styles/.test(t.title));
    await page.goto(`${UI}/projects/${planned.projectId}/chat`);
    await page.waitForTimeout(2500);
    await shot("w1-01-chat-open");
    // L4-chat-202, U-094's failure question in the answer-alone mode.
    await say(`why does "${styles?.title}" keep failing and what should I change?`);
    await shot("w1-02-failure-question");
    // L4-chat-201: Go ahead runs once.
    out.goAhead1 = await press("Go ahead");
    await shot("w1-03-failure-go-ahead");
    // L4-chat-202: the plan line in the answer-alone mode.
    await say("make a plan for the next two sessions");
    await shot("w1-04-plan-line");
    // L4-chat-212: another line after the ask line.
    await say("what is left?");
    await shot("w1-05-after-another-line");
    // L4-chat-201: two more stronger Go aheads in a row.
    await say("use a stronger model: compare the two ways to style the page");
    await shot("w1-06-stronger-ask-2");
    out.goAhead2 = await press("Go ahead");
    await shot("w1-07-stronger-go-ahead-2");
    await say("use a stronger model: review the README for the garden club");
    await shot("w1-08-stronger-ask-3");
    out.goAhead3 = await press("Go ahead");
    await shot("w1-09-stronger-go-ahead-3");
    // A typed yes under an ask (the plan line again).
    await say("make a plan for the next two sessions");
    await shot("w1-10-plan-line-again");
    await say("yes");
    await shot("w1-11-typed-yes");
    // L4-chat-206: Answer now during a longer pass.
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill("think it through: what did the last two sessions do?");
    await box.press("Enter");
    const an = page.getByRole("button", { name: "Answer now", exact: true });
    await an.waitFor({ timeout: 30_000 }).catch(() => undefined);
    await shot("w1-12-answer-now-showing");
    out.answerNow = (await an.count()) > 0;
    if (out.answerNow) await an.click();
    await idle();
    await shot("w1-13-after-answer-now");
    out.conversation = (await R.api(N, "GET", `/projects/${planned.projectId}/conversation`)).turns.map((t) => ({
      human: t.said ?? t.human?.text,
      reply: t.reply?.text,
      offer: t.reply?.offer ?? null,
      footer: t.reply?.footer ?? null,
      depth: t.reply?.depth ?? null,
      cost: t.reply?.cost ?? null,
    }));
    out.inbox = (await R.api(N, "GET", "/inbox")).requests?.map((r) => r.title ?? r.why) ?? null;
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
