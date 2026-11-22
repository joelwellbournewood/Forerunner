// Review walk C: Standard project with the person's own tasks: the set asks first (card), answered
// while the session runs; the approved tasks join the running session by the admit rule.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-5/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-d1109-selftasks-run";
const pname = process.argv[2] ?? "Corner shop";
const answerWith = process.argv[3] ?? "Make these changes";
const check = (name, ok, detail) =>
  console.log(ok ? "OK  " : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 900));

(async () => {
  const { browser, page } = await R.openApp(N);
  const p = await R.api(N, "POST", "/projects", { name: pname, goal: "A small shop page", autonomyLevel: 2 });
  const add = (body) => R.api(N, "POST", `/projects/${p.id}/tasks`, { status: "ready", ...body });
  const create = await add({ title: "Create the page skeleton in index.html", outcome: "index.html exists", acceptanceCriteria: ["index.html has a heading"], specialist: "coder", priority: "high" });
  await add({ title: "Write the README", outcome: "README.md says how to open the page", acceptanceCriteria: ["README.md exists"], specialist: "writer", priority: "high" });
  await add({ title: "Write the shop notes in notes.md", outcome: "notes.md lists the opening hours", acceptanceCriteria: ["notes.md exists"], specialist: "writer", priority: "medium" });
  const cid = create.id ?? create.taskId ?? create.task?.id;
  const style = await add({ title: "Style the page in styles.css", outcome: "styles.css styles the page", acceptanceCriteria: ["styles.css has a layout for phones", "styles.css uses warm colours"], specialist: "designer", priority: "low", dependsOn: [cid] });
  const sid = style.id ?? style.taskId ?? style.task?.id;
  await add({ title: "Publish the page", outcome: "the page is ready", acceptanceCriteria: ["index.html links styles.css"], specialist: "coder", priority: "low", dependsOn: [sid] });
  const tasks0 = await R.api(N, "GET", `/projects/${p.id}/tasks`);
  check("tasks made", tasks0.length === 5, tasks0.map((t) => [t.title, t.status]));
  const started = await R.startSession(N, p.id, "review walk C").catch(async (e) => {
    console.log("start said", String(e).slice(0, 300));
    return null;
  });
  console.log("started", JSON.stringify(started).slice(0, 300));
  const card = await R.until(async () => {
    const ib = await R.api(N, "GET", "/inbox");
    return (ib.requests ?? []).find((r) => r.projectId === p.id && r.status === "open" && /agent suggests/.test(r.title ?? "")) ?? null;
  }, 300_000, 300, "the suggestion card");
  const list = await R.api(N, "GET", `/projects/${p.id}/sessions`);
  const running = (list.rows ?? []).find((r) => r.working);
  check("the session runs on while the card waits", !!running, { title: card.title, body: card.body, details: card.details });
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(1200);
  const cardEl = page.locator("article, section, li, div").filter({ hasText: `${pname}: the agent suggests` }).filter({ has: page.getByRole("button", { name: "Keep the tasks" }) }).last();
  await R.step(page, `running-${pname}-card`);
  await cardEl.getByRole("button", { name: answerWith }).first().click();
  await page.waitForTimeout(2500);
  const done = await R.step(page, `running-${pname}-done`);
  check("Done line", true, done.split("\n").filter((l) => /^Done:/.test(l)));
  if (running) await R.waitForSession(N, running.id, 600_000);
  const list2 = await R.api(N, "GET", `/projects/${p.id}/sessions`);
  check("sessions after", true, (list2.rows ?? []).map((r) => [r.working, r.gist]));
  const tasks1 = await R.api(N, "GET", `/projects/${p.id}/tasks`);
  check("tasks after", true, tasks1.map((t) => [t.title, t.status]));
  await page.goto(`${R.bench(N).uiUrl}/sessions/${running?.id}`);
  await page.waitForTimeout(2500);
  const s = await R.step(page, `running-${pname}-session`);
  check("session page", true, s.split("\n").filter((l) => /Did \d|Took|joined|Left for|Changed|Split|Added/.test(l)));
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  const ib = await R.step(page, `running-${pname}-inbox-after`);
  check("inbox after", true, ib.split("\n").filter((l) => l.includes(pname) || /^Done:/.test(l)));
  fs.writeFileSync(`/tmp/frbench/${N}/steps/running-${pname}.json`, JSON.stringify({ projectId: p.id }, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
