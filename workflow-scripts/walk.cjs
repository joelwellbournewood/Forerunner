// fixup-l4-github-merge bench walk: L4-github-124 (a) and L4-money-301 at person speed.
// Usage: node walk.cjs <repo> <bench name> <part: press|costs|restart>
const repo = process.argv[2];
const name = process.argv[3];
const part = process.argv[4];
const fs = require("node:fs");
const path = require("node:path");
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/githost.json`, "utf8"));
const out = `/tmp/frbench/${name}/walk-${part}.json`;
const ghApi = async (method, route, body) => {
  const r = await fetch(`${gh.url}${route}`, {
    method,
    headers: {
      authorization: `token ${gh.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const prOf = (url) => Number(/\/pull\/(\d+)/.exec(url ?? "")?.[1]);

async function press() {
  const result = {};
  let project = (await R.api(name, "GET", "/projects")).find((p) => p.name === "Kite club");
  let aId;
  let bId;
  if (!project) {
    project = await R.api(name, "POST", "/projects", {
      name: "Kite club",
      goal: "The club's pages",
      repos: ["bench/seeded"],
    });
    const a = await R.api(name, "POST", `/projects/${project.id}/tasks`, {
      title: "Write kite/club.txt with one line",
      outcome: "kite/club.txt holds one line",
      riskTier: 1,
      specialist: "coder",
    });
    aId = a.task?.id ?? a.id;
    const b = await R.api(name, "POST", `/projects/${project.id}/tasks`, {
      title: "Write kite/club-day.txt after the club file",
      outcome: "kite/club-day.txt names the club day",
      riskTier: 1,
      specialist: "coder",
      dependsOn: [aId],
    });
    bId = b.task?.id ?? b.id;
    const started = await R.startSession(name, project.id);
    await R.waitForSession(name, started.session?.id ?? started.id, 240_000);
  } else {
    const ts = await R.api(name, "GET", `/projects/${project.id}/tasks`);
    aId = ts.find((t) => t.title.startsWith("Write kite/club.txt")).id;
    bId = ts.find((t) => t.title.startsWith("Write kite/club-day.txt")).id;
  }
  const tasks = await R.api(name, "GET", `/projects/${project.id}/tasks`);
  const ta = tasks.find((t) => t.id === aId);
  const tb = tasks.find((t) => t.id === bId);
  const [prA, prB] = [prOf(ta.prUrl), prOf(tb.prUrl)];
  result.prs = { prA, prB };
  result.before = { a: ta.display?.label, b: tb.display?.label };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await page.goto(`${JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8")).uiUrl}/projects/${project.id}/tasks`);
    await page.waitForTimeout(3000);
    if (await page.getByText("Set up later").count()) await R.skipSetup(page);
    await page.goto(`${JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8")).uiUrl}/projects/${project.id}/tasks`);
    await page.getByTestId("task-row").first().waitFor();
    result.step1 = await R.step(page, "press-01-tasks-before-close");
    // The person closes A on GitHub (no poll runs: the watcher polls once an hour here).
    result.closeA = (await ghApi("PATCH", `/repos/bench/seeded/pulls/${prA}`, { state: "closed" })).status;
    await page.getByTestId("tab-summary").click();
    const files = page.getByTestId("your-files");
    const rowB = files.locator(`[data-testid="pr-waiting"][data-number="${prB}"]`);
    await rowB.waitFor();
    result.step2 = await R.step(page, "press-02-overview-before-press");
    await rowB.getByTestId("pr-merge").click();
    await files.getByRole("alert").waitFor({ timeout: 30_000 });
    result.alert = await files.getByRole("alert").innerText();
    result.step3 = await R.step(page, "press-03-overview-after-press");
    await page.getByTestId("tab-tasks").click();
    await page.getByTestId("task-row").first().waitFor();
    const rowA = page.locator(`[data-testid="task-row"][data-task-id="${aId}"]`);
    result.rowA = await rowA.getByTestId("task-status").innerText();
    result.step4 = await R.step(page, "press-04-tasks-after-press");
    const after = await R.api(name, "GET", `/projects/${project.id}/tasks`);
    result.apiAfter = {
      a: after.find((t) => t.id === aId)?.display,
      b: after.find((t) => t.id === bId)?.display?.label,
    };
    result.ghA = (await ghApi("GET", `/repos/bench/seeded/pulls/${prA}`)).body?.state;
    result.ghB = (await ghApi("GET", `/repos/bench/seeded/pulls/${prB}`)).body?.merged;
    const me = await R.api(name, "GET", "/me");
    const inbox = await R.api(name, "GET", `/inbox?humanId=${me.human?.id ?? me.id}`).catch(() => null);
    result.inboxForB = inbox?.requests
      ?.filter((r) => r.taskId === bId)
      .map((r) => ({ title: r.title, status: r.status }));
    result.inboxForA = inbox?.requests
      ?.filter((r) => r.taskId === aId)
      .map((r) => ({ title: r.title, status: r.status }));
    result.projectId = project.id;
    result.aId = aId;
  } finally {
    await browser.close();
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

async function restart() {
  const prev = JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/walk-press.json`, "utf8"));
  const { browser, page } = await R.openApp(name);
  const result = {};
  try {
    const b = JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8"));
    await page.goto(`${b.uiUrl}/projects/${prev.projectId}/tasks`);
    await page.getByTestId("task-row").first().waitFor();
    const rowA = page.locator(`[data-testid="task-row"][data-task-id="${prev.aId}"]`);
    result.rowA = await rowA.getByTestId("task-status").innerText();
    result.step = await R.step(page, "press-05-tasks-after-restart");
  } finally {
    await browser.close();
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

async function costs() {
  const result = {};
  const b = JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8"));
  const project = await R.api(name, "POST", "/projects", { name: "Guide", goal: "A guide" });
  const t = await R.api(name, "POST", `/projects/${project.id}/tasks`, {
    title: "Write the guide in guide.md",
    outcome: "guide.md explains the club",
    acceptanceCriteria: ["guide.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 45_000,
    specialist: "coder",
    riskTier: 1,
  });
  const taskId = t.task?.id ?? t.id;
  const started = await R.startSession(name, project.id);
  await R.waitForSession(name, started.session?.id ?? started.id, 240_000);
  const { browser, page } = await R.openApp(name);
  try {
    await page.goto(`${b.uiUrl}/inbox`);
    const card = page.getByText('"Write the guide in guide.md" paused before its budget ran out').first();
    await card.waitFor({ timeout: 30_000 });
    result.step1 = await R.step(page, "costs-01-inbox-paused");
    const cont = page.getByRole("button", { name: /^Continue \(CHF \d+\.\d\d more\)$/ }).first();
    result.continueLabel = await cont.innerText();
    await cont.click();
    await R.until(
      async () => {
        const rows = await R.api(name, "GET", `/projects/${project.id}/tasks`);
        return rows.find((x) => x.id === taskId)?.status === "done" ? true : null;
      },
      240_000,
      1000,
      "the guide to be done",
    );
    await page.goto(`${b.uiUrl}/projects/${project.id}/costs`);
    const byTask = page.getByTestId("cost-by-task");
    await byTask.waitFor();
    const row = byTask.locator("tr", { hasText: "Write the guide in guide.md" });
    result.byTaskRow = await row.innerText();
    result.bySpecialist = await page.getByTestId("cost-by-specialist").innerText();
    result.byModel = await page.getByTestId("cost-by-model").innerText();
    result.step2 = await R.step(page, "costs-02-costs-after-continue");
    const api = await R.api(name, "GET", `/costs?projectId=${project.id}`);
    result.api = {
      byTask: api.byTask.map((x) => [x.label, x.runs, x.accepted, x.tries]),
      bySpecialist: api.bySpecialist.map((x) => [x.key, x.runs, x.accepted, x.tries]),
      byModel: api.byModel.map((x) => [x.key, x.runs, x.accepted, x.tries]),
      total: api.totals,
    };
  } finally {
    await browser.close();
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

({ press, restart, costs })[part]().catch((e) => {
  console.error(e);
  process.exit(1);
});
