// d1116-budget-all bench walk: a Budget 2.00 Swiss task the critic sends back once (the row, the
// drawer and Costs; the second run's start line) and a Budget 0.10 footer task (which branch it
// takes, its card, Continue, the review-only pass). Usage: node walk-budget-all.cjs <bench> <label>
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c78dba2-180-1/scripts/bench/recorder.cjs");

const [n, label, footerChfArg] = process.argv.slice(2);
const footerChf = Number(footerChfArg ?? "0.10");
const out = {};
const RATE = 0.8;
const usdOfChf = (chf) => Math.round((chf / RATE) * 1_000_000);

async function lines(sessionId) {
  const ev = await R.api(n, "GET", `/sessions/${sessionId}/events`);
  return ev.map((e) => e.text ?? "").filter(Boolean);
}

async function rows(projectId) {
  const tasks = await R.api(n, "GET", `/projects/${projectId}/tasks`);
  return (tasks.tasks ?? tasks).map((t) => ({
    title: t.title,
    status: t.status,
    budget: t.budget,
    actual: t.actual,
    spent: t.spent,
    cap: t.cap,
    capSource: t.capSource,
    label: t.display?.label,
  }));
}

async function cards(taskIds) {
  const inbox = await R.api(n, "GET", "/inbox");
  return (inbox.requests ?? [])
    .filter((r) => taskIds.includes(r.taskId))
    .map((r) => ({
      id: r.id,
      status: r.status,
      title: r.title,
      body: r.body,
      options: r.options,
      choices: (r.choices ?? []).map((c) => c.label),
      card: r.changeCard
        ? {
            source: r.changeCard.source,
            cap: r.changeCard.cap_usd_micro,
            spent: r.changeCard.spent_usd_micro,
            continue: r.changeCard.continue_usd_micro,
            needs: r.changeCard.needs_usd_micro,
            room: r.changeCard.room_usd_micro,
            estimate: r.changeCard.estimate_usd_micro,
          }
        : null,
    }));
}

function firstCalls() {
  const calls = R.modelCalls(n);
  const pick = (role, needle) => {
    const c = calls.find(
      (x) => x.role === role && JSON.stringify(x.messages ?? "").includes(needle),
    );
    return c ? { usd: c.usd, usage: c.reply?.usage, model: c.model } : null;
  };
  return {
    coderSwiss: pick("specialist", "Swiss"),
    criticSwiss: pick("critic", "Swiss"),
    coderFooter: pick("specialist", "footer"),
    criticFooter: pick("critic", "footer"),
  };
}

(async () => {
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page);
    const b = JSON.parse(fs.readFileSync(path.join("/tmp/frbench", n, "bench.json"), "utf8"));
    const project = await R.api(n, "POST", "/projects", {
      name: `Chess club ${label}`,
      goal: "A chess club site",
    });
    const pid = project.id;
    const mk = (title, file, chf, priority) =>
      R.api(n, "POST", `/projects/${pid}/tasks`, {
        title,
        outcome: `${file} is written`,
        acceptanceCriteria: [`${file} exists`],
        priority,
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: usdOfChf(chf),
        specialist: "coder",
        riskTier: 1,
      });
    const swiss = await mk("Write the Swiss pairing tool in swiss.html", "swiss.html", 2.0, "high");
    const footer = await mk(
      "Add a footer line with the club's name to index.html",
      "index.html",
      footerChf,
      "medium",
    );
    out.project = pid;
    out.startCheck = await R.api(n, "GET", `/projects/${pid}/start-check`);
    await page.goto(`${b.uiUrl}/projects/${pid}/tasks`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await R.step(page, `${label}-01-tasks-before-start`);
    const started = await R.startSession(n, pid);
    const sid = started.session?.id ?? started.id;
    out.session1 = sid;
    await R.waitForSession(n, sid, 600_000);
    out.lines1 = (await lines(sid)).filter((l) =>
      /This run may spend|paused|Session review|kept for its review|is spent|Told the coder|Session over|Plan:/.test(
        l,
      ),
    );
    out.rows1 = await rows(pid);
    out.cards1 = await cards([swiss.id, footer.id]);
    out.costs1 = await R.api(n, "GET", `/costs?projectId=${pid}`);
    out.costs1 = {
      totals: out.costs1.totals,
      byTask: out.costs1.byTask.map((t) => ({ label: t.label, cost: t.cost })),
    };
    await page.goto(`${b.uiUrl}/projects/${pid}/tasks`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await R.step(page, `${label}-02-tasks-after-session`);
    await page.goto(`${b.uiUrl}/projects/${pid}/tasks?task=${swiss.id}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    await R.step(page, `${label}-03-drawer-swiss`);
    await page.goto(`${b.uiUrl}/projects/${pid}/costs`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await R.step(page, `${label}-04-costs`);
    await page.goto(`${b.uiUrl}/sessions/${sid}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const details = page.getByRole("button", { name: /Details/ });
    if (await details.count()) await details.first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await R.step(page, `${label}-05-session`);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await R.step(page, `${label}-06-inbox`);
    // The footer: Continue on its card, when it has one.
    const open = out.cards1.find((c) => c.status === "open" && c.choices.some((x) => /^Continue/.test(x)));
    if (open) {
      const card = page.locator(`[data-request-id="${open.id}"]`);
      const btn = card.getByRole("button", { name: /^Continue/ });
      if (await btn.count()) {
        await btn.first().click();
        const confirm = page.getByRole("button", { name: /^(Continue|Yes|Confirm)/ });
        await page.waitForTimeout(500);
        if ((await confirm.count()) > 1) await confirm.last().click().catch(() => undefined);
        out.continued = open.id;
        await R.until(
          async () => {
            const t = (await rows(pid)).find((r) => r.title.startsWith("Add a footer"));
            return t && ["done", "needs_human", "failed"].includes(t.status) &&
              !(await cards([footer.id])).some((c) => c.status === "open" && c.id === open.id)
              ? t
              : null;
          },
          300_000,
          2000,
          "the footer after Continue",
        ).catch((e) => {
          out.continueError = String(e.message ?? e);
        });
        const sessions = await R.api(n, "GET", `/projects/${pid}/sessions`);
        const last = (sessions.rows ?? [])[0];
        if (last && last.id !== sid) {
          await R.waitForSession(n, last.id, 300_000).catch(() => undefined);
          out.session2 = last.id;
          out.lines2 = (await lines(last.id)).filter((l) =>
            /This run may spend|paused|Session review|kept for its review|reviewed|critic|Session over/.test(l),
          );
        }
        out.rows2 = await rows(pid);
        out.cards2 = await cards([swiss.id, footer.id]);
        await page.goto(`${b.uiUrl}/projects/${pid}/tasks`);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await R.step(page, `${label}-07-tasks-after-continue`);
        await page.goto(`${b.uiUrl}/inbox`);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await R.step(page, `${label}-08-inbox-after-continue`);
      }
    }
    out.firstCalls = firstCalls();
    out.problems = R.problems(n).slice(-20);
  } catch (e) {
    out.error = String(e.stack ?? e);
  } finally {
    const dir = path.join("/tmp/frbench", n, "steps");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${label}-budget-all.json`), JSON.stringify(out, null, 2));
    await browser.close();
    console.log(JSON.stringify(out, null, 2).slice(0, 6000));
  }
})();
