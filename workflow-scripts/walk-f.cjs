// Walk f (review of fix/stops, blocking item): a GitHub project's task being reviewed has its
// pull request; the row's Cancel dialog and the chat's read-back of "skip the X task" both say
// the pull request stays open, and Yes says the same.
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_7dea540b-2f3-9/scripts/bench/recorder.cjs");
const N = "fixup-stops";
const OUT = `/tmp/frbench/fixup-stops/steps/walk-f-result-${process.argv[3] ? "empty" : "seeded"}.json`;

(async () => {
  const out = { checks: [] };
  const check = (name, ok, seen) => out.checks.push({ name, ok: !!ok, seen });
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await R.skipSetup(page);
    // New project with the repository bench/seeded (as New project's "Repository" field).
    await page.getByTestId("new-project").first().click();
    const dlg = page.getByTestId("new-project-dialog");
    await dlg.locator('[name="name"]').fill(process.argv[2] || "Garden club repo");
    await dlg.locator('[name="brief"]').fill(
      "A small web page for the garden club that shows the next meeting date and a short welcome.",
    );
    await dlg.locator('[name="repo"]').fill(process.argv[3] || "bench/seeded");
    await R.step(page, "f-00-new-project");
    await dlg.getByTestId("create-project").click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
    const projectId = /\/projects\/([^/?#]+)/.exec(page.url())[1];
    out.projectId = projectId;
    await R.until(
      async () =>
        (await R.api(N, "GET", `/projects/${projectId}/intake`)).state === "pending" || null,
      120_000,
      1000,
      "the plan",
    );
    await page.goto(`${R.bench(N).uiUrl}/inbox`);
    await page.getByRole("button", { name: "Approve and start" }).first().click({ timeout: 30_000 });
    await R.step(page, "f-01-approved");
    // The first task's review, with its pull request.
    let reviewed = null;
    await R.until(
      async () => {
        const tasks = await R.api(N, "GET", `/projects/${projectId}/tasks`);
        reviewed = tasks.find((t) => t.display?.label === "Being reviewed" && t.prUrl) || null;
        return reviewed;
      },
      180_000,
      150,
      "a task being reviewed with its pull request",
    );
    out.reviewed = { title: reviewed.title, prUrl: reviewed.prUrl, live: reviewed.display.live };
    check("the task being reviewed has a pull request and its review goes on", reviewed.display.live === true, out.reviewed);
    // Tasks tab: the row's Cancel dialog.
    await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/tasks`);
    const row = page.locator(`[data-testid="task-row"][data-task-id="${reviewed.id}"]`);
    await row.getByTestId("action-cancel").click({ timeout: 15_000 });
    const explain = await page.getByTestId("action-explain").innerText();
    out.dialog = explain;
    await R.step(page, "f-02-row-cancel-dialog", { settleMs: 500 });
    check(
      "the row's Cancel dialog says the review stops and the pull request stays open",
      /Its review stops now; its pull request stays open\./.test(explain) && !/removed/.test(explain),
      explain,
    );
    await page.getByTestId("dismiss-action").click();
    // Chat: "skip the X task" while it is being reviewed.
    await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/chat`);
    const input = page.getByTestId("chat-input");
    await input.fill(`skip the ${reviewed.title} task`);
    await page.getByTestId("chat-send").click();
    const confirm = page.getByTestId("pending-confirmation");
    await confirm.waitFor({ timeout: 30_000 });
    const readback = await confirm.innerText();
    out.readback = readback;
    await R.step(page, "f-03-chat-readback", { settleMs: 500 });
    check(
      "the read-back says the review stops and the pull request stays open",
      readback.includes(
        `Cancel "${reviewed.title}"? It is dropped; its review stops now; its pull request stays open`,
      ),
      readback,
    );
    check("the read-back promises no removal", !/removed/.test(readback), readback);
    const before = await page.getByTestId("chat-agent").count();
    await confirm.getByTestId("confirm-yes").click();
    await R.until(
      async () => ((await page.getByTestId("chat-agent").count()) > before ? true : null),
      30_000,
      250,
      "the reply to yes",
    );
    await page.waitForTimeout(1000);
    const reply = await page.getByTestId("chat-agent").last().innerText();
    out.yes = reply;
    await R.step(page, "f-04-chat-after-yes", { settleMs: 500 });
    check(
      "Yes says the review stopped and the pull request stays open",
      reply.includes(`Cancelled "${reviewed.title}": its review stopped; its pull request stays open.`),
      reply,
    );
    // Tasks tab after it, and the pull request on the stand-in for GitHub.
    await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/tasks`);
    await R.step(page, "f-05-tasks-after", { settleMs: 1500 });
    const after = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((t) => t.id === reviewed.id);
    out.after = { status: after.status, label: after.display?.label, prUrl: after.prUrl };
    check("the row reads Cancelled and keeps its pull request", after.display?.label === "Cancelled" && after.prUrl === reviewed.prUrl, out.after);
    const prNumber = /\/pull\/(\d+)/.exec(reviewed.prUrl)?.[1];
    const gh = R.bench(N).githost.url;
    try {
      const g = JSON.parse(fs.readFileSync("/tmp/frbench/fixup-stops/githost.json", "utf8"));
      const pr = await (
        await fetch(`${gh}/repos/${process.argv[3] || "bench/seeded"}/pulls/${prNumber}`, {
          headers: { authorization: `token ${g.token}` },
        })
      ).json();
      out.pr = { state: pr.state, merged: pr.merged, head: pr.head?.ref };
      check("the pull request is still open on GitHub", pr.state === "open", out.pr);
    } catch (e) {
      out.prError = String(e);
    }
    // Stop what is left of the session.
    const sessions = await R.api(N, "GET", `/projects/${projectId}/sessions`).catch(() => []);
    out.sessions = Array.isArray(sessions) ? sessions.map((s) => s.status) : sessions;
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    await R.step(page, "f-error").catch(() => undefined);
  } finally {
    out.ok = !out.error && out.checks.every((c) => c.ok);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
