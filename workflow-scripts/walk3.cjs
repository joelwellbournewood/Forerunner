// Reviewer walk 3 (w8-together): Undo from Changes after two restarts, Work together again (the
// removed together row comes back), a session on the together project (what Bob writes on
// GitHub), Ada's Add to it in the background, chat's Work together, the model's task words,
// a move of one of two same-titled tasks.
const WT = "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-5";
const R = require(`${WT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const A = "review-w8-together";
const B = "review-w8-together-bob";
const OUT = "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/walk";
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  fs.appendFileSync(`${OUT}/walk3.log`, `${line}\n`);
};
async function ghApi(login, method, path, body) {
  const res = await fetch(`${gh.url}${path}`, {
    method,
    headers: {
      authorization: `token ${gh.users[login].token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
const restart = (bench) =>
  execFileSync("node", [`${WT}/scripts/bench/restart-daemon.mjs`, "--name", bench], {
    stdio: "pipe",
  }).toString();
const writesBy = (login) =>
  fs
    .readFileSync(`/tmp/frbench/${A}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter(
      (r) =>
        r.login === login &&
        !["GET", "HEAD"].includes(r.method) &&
        !/git-upload-pack|\/graphql$/.test(r.path ?? r.url ?? ""),
    );
const ids = () => JSON.parse(fs.readFileSync(`${OUT}/ids.json`, "utf8"));

async function chatSay(page, text) {
  const input = page.getByTestId("chat-input");
  await input.fill(text);
  await page.getByTestId("chat-send").click();
  await page.waitForTimeout(2500);
}

(async () => {
  const step = process.argv[2];
  const { kite, site } = ids();
  if (step === "undo") {
    log(restart(B).trim().split("\n").at(-1));
    log(restart(B).trim().split("\n").at(-1));
    const before = writesBy("bob").length;
    const { browser, page } = await R.openApp(B, { path: "/changes" });
    await page.waitForTimeout(3000);
    let t = await R.step(page, "bob changes after two restarts", { waitMs: 500 });
    log("CHANGES", t.slice(0, 1500));
    const row = page.getByTestId("change").filter({ hasText: 'joined "Team site"' }).first();
    log("undo buttons", await row.getByTestId("change-undo").count());
    await row.getByTestId("change-undo").click();
    await page.waitForTimeout(3000);
    t = await R.step(page, "bob after undo", { waitMs: 500 });
    log("AFTER UNDO", t.slice(0, 1800));
    await page.goto(`${R.bench(B).uiUrl}/projects/${site}/summary`);
    await page.waitForTimeout(4000);
    t = await R.step(page, "bob site back", { waitMs: 500 });
    log("SITE BACK", t.slice(0, 2200));
    log("bob writes at undo", writesBy("bob").length - before);
    const projects = await R.api(B, "GET", "/projects");
    log(
      "projects",
      projects.map((p) => [p.name, p.id === kite ? "kite-id" : p.id === site ? "site-id" : "other"]),
    );
    await browser.close();
    return;
  }
  if (step === "again") {
    const before = writesBy("bob").length;
    const { browser, page } = await R.openApp(B, { path: `/projects/${site}/summary` });
    await page.waitForTimeout(3000);
    await page.getByTestId("repository-work-together").first().click();
    await page.getByTestId("join-together-sentence").waitFor({ timeout: 30_000 });
    let t = await R.step(page, "bob together dialog again", { waitMs: 300 });
    log("DIALOG AGAIN", t.slice(-1200));
    await page.getByTestId("join-together-confirm").click();
    await page.waitForURL((u) => !u.toString().includes(site), { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    t = await R.step(page, "bob after work together again", { waitMs: 500 });
    log("URL", page.url().includes(kite) ? "kite-id page" : page.url());
    log("AFTER AGAIN", t.slice(0, 1800));
    log("bob writes at second press", writesBy("bob").length - before);
    await browser.close();
    return;
  }
  if (step === "session") {
    const before = writesBy("bob").length;
    const s = await R.startSession(B, kite, "reviewer: a session on the together project");
    log("session", s.id ?? JSON.stringify(s).slice(0, 300));
    const end = await R.waitForSession(B, s.session?.id ?? s.id, 300_000);
    log("session end", end.status, (end.summary ?? "").slice(0, 300));
    await new Promise((r) => setTimeout(r, 8000));
    const w = writesBy("bob").slice(before);
    log("bob writes in the session", w.map((x) => `${x.method} ${x.path ?? x.url}`));
    const prs = (await ghApi("ada", "GET", "/repos/team/shared/pulls?state=all")).body.map((p) => [
      p.number,
      p.state,
      p.head.ref,
      p.user?.login,
    ]);
    log("prs", prs);
    const issues = (await ghApi("ada", "GET", "/repos/team/shared/issues?state=all")).body;
    for (const i of issues ?? []) {
      if (i.pull_request) continue;
      log("issue", i.number, i.title, i.user?.login);
      const cs = (await ghApi("ada", "GET", `/repos/team/shared/issues/${i.number}/comments`)).body;
      for (const c of cs ?? []) log("  comment by", c.user?.login, JSON.stringify(c.body).slice(0, 600));
    }
    const { browser, page } = await R.openApp(B, { path: `/projects/${kite}/summary` });
    await page.waitForTimeout(3000);
    const t = await R.step(page, "bob together after session", { waitMs: 500 });
    log("AFTER SESSION", t.slice(0, 2000));
    await browser.close();
    return;
  }
  if (step === "addto2") {
    // Add to it on <repo>: snapshots at 400 ms and 1.5 s after landing; then from Home a second
    // brief for the same repository while it drafts (or while its plan waits).
    const repo = process.argv[3] ?? "team/empty";
    const { browser, page } = await R.openApp(A, { path: "/" });
    await R.skipSetup(page);
    const addTo = async (name, brief) => {
      await page.goto(`${R.bench(A).uiUrl}/`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "New project", exact: true }).first().click();
      await page.locator('input[name="name"]').fill(name);
      await page.locator('textarea[name="brief"], input[name="brief"]').first().fill(brief);
      await page.locator('input[name="repo"]').fill(`https://github.com/${repo}`);
      await page.getByTestId("create-project").click();
      await page.getByTestId("offer-add").waitFor({ timeout: 15000 });
      const t0 = Date.now();
      await page.getByTestId("offer-add").click();
      return t0;
    };
    const t0 = await addTo("Contact", "Add a contact page with a thank-you note.");
    await page.waitForURL(/\/projects\//, { timeout: 15000 });
    log("landed after ms", Date.now() - t0);
    await page.waitForTimeout(400);
    let t = await R.step(page, `ada add to ${repo} landed`, { settleMs: 0 });
    log("AT 0.4s drafting line:", /Drafting the plan/.test(t), t.match(/Drafting[^\n]*/)?.[0] ?? "");
    await page.waitForTimeout(1100);
    t = await R.step(page, `ada add to ${repo} 1.5s`, { settleMs: 0 });
    log("AT 1.5s drafting line:", /Drafting the plan/.test(t), t.match(/(Drafting|Waiting for you)[^\n]*/)?.[0] ?? "");
    await addTo("Blog", "Add a blog page.");
    await page.waitForTimeout(800);
    t = await R.step(page, `ada second brief for ${repo}`, { settleMs: 0 });
    log("SECOND (dialog)", t.split("\n").filter((l) => /plan|Plan|draft/.test(l)).join(" | "));
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(8000);
    const projects = await R.api(A, "GET", "/projects");
    for (const p of projects) {
      const st = await R.api(A, "GET", `/projects/${p.id}/intake`).catch(() => null);
      log("intake of", p.name, st?.state, st?.error ?? "");
    }
    await browser.close();
    return;
  }
  if (step === "addto") {
    const { browser, page } = await R.openApp(A, { path: "/" });
    await R.skipSetup(page);
    await page.goto(`${R.bench(A).uiUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await page.locator('input[name="name"]').fill("Contact form");
    await page.locator('textarea[name="goal"], input[name="goal"]').first().fill("A contact form");
    await page
      .locator('textarea[name="brief"], input[name="brief"]')
      .first()
      .fill("Add a contact form page with a short thank-you note after sending.");
    await page.locator('input[name="repo"]').fill("https://github.com/team/shared");
    await page.getByTestId("create-project").click();
    await page.getByTestId("offer-add").waitFor({ timeout: 15000 });
    let t = await R.step(page, "ada add to offer", { waitMs: 300 });
    log("OFFER", t.slice(-900));
    const t0 = Date.now();
    await page.getByTestId("offer-add").click();
    await page.waitForURL(/\/projects\//, { timeout: 15000 });
    log("landed after ms", Date.now() - t0);
    t = await R.step(page, "ada add to landed", { waitMs: 0 });
    log("LANDED drafting line:", /Drafting the plan/.test(t));
    log("LANDED", t.slice(0, 1200));
    // A second brief while it drafts: the dialog's answer.
    await page.getByRole("button", { name: "New project", exact: true }).first().click().catch(() => undefined);
    const dlg = page.locator('input[name="name"]');
    if (await dlg.count()) {
      await dlg.fill("Blog");
      await page.locator('textarea[name="goal"], input[name="goal"]').first().fill("A blog");
      await page.locator('textarea[name="brief"], input[name="brief"]').first().fill("Add a blog page.");
      await page.locator('input[name="repo"]').fill("https://github.com/team/shared");
      await page.getByTestId("create-project").click();
      await page.getByTestId("offer-add").waitFor({ timeout: 15000 });
      await page.getByTestId("offer-add").click();
      await page.waitForTimeout(1500);
      t = await R.step(page, "ada second add to while drafting", { waitMs: 0 });
      log("SECOND", t.slice(-900));
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    await page.waitForTimeout(9000);
    t = await R.step(page, "ada plan waits", { waitMs: 500 });
    log("LATER", t.slice(0, 1500));
    const st = await R.api(A, "GET", `/projects/${ids().adaProject ?? ""}/intake`).catch(() => null);
    log("intake status", st?.state ?? st);
    await browser.close();
    return;
  }
  if (step === "club") {
    const club = await R.api(A, "POST", "/projects", { name: "Club", goal: "The club", repos: ["team/empty"] });
    log("ada club", club.name);
    const marker = await R.until(
      async () => {
        const m = await ghApi("ada", "GET", "/repos/team/empty/contents/.forerunner/project.json?ref=main");
        if (m.status === 200) return "main";
        const prs = (await ghApi("ada", "GET", "/repos/team/empty/pulls?state=open")).body ?? [];
        return prs.length ? `pr ${prs[0].head.ref}` : null;
      },
      60_000,
      1000,
      "Club's marker",
    );
    log("club marker on", marker);
    fs.writeFileSync(`${OUT}/ids.json`, JSON.stringify({ ...ids(), club: club.id }));
    return;
  }
  if (step === "chat-together") {
    const before = writesBy("bob").length;
    const { browser, page } = await R.openApp(B, { path: `/projects/${kite}/chat` });
    await page.waitForTimeout(3000);
    await chatSay(page, 'tool: project_create {"name":"Kites","goal":"The club","repos":["team/empty"]}');
    let t = await R.step(page, "bob chat create refused", { waitMs: 500 });
    log("REFUSED", t.slice(-900));
    await chatSay(
      page,
      'tool: project_create {"name":"Kites","goal":"The club","repos":["team/empty"],"together":true}',
    );
    t = await R.step(page, "bob chat together read-back", { waitMs: 500 });
    log("READBACK", t.slice(-900));
    const projBefore = (await R.api(B, "GET", "/projects")).length;
    log("projects before yes", projBefore);
    await page.getByTestId("confirm-yes").last().click();
    await page.waitForTimeout(3000);
    t = await R.step(page, "bob chat together yes", { waitMs: 500 });
    log("YES", t.slice(-900));
    const projects = await R.api(B, "GET", "/projects");
    log("projects after", projects.map((p) => [p.name, p.id === ids().club ? "club-id" : "-"]));
    log("bob writes in chat together", writesBy("bob").slice(before).map((x) => `${x.method} ${x.path}`));
    await browser.close();
    return;
  }
  if (step === "taskwords") {
    const { browser, page } = await R.openApp(B, { path: `/projects/${kite}/chat` });
    await page.waitForTimeout(3000);
    const tasks0 = (await R.api(B, "GET", `/projects/${kite}/tasks`)).length;
    await chatSay(page, "add a task: Write the FAQ");
    let t = await R.step(page, "bob chat add a task pattern", { waitMs: 500 });
    log("PATTERN", t.slice(-600));
    log("tasks after pattern", (await R.api(B, "GET", `/projects/${kite}/tasks`)).length - tasks0);
    await chatSay(page, 'tool: task_create {"title":"Write the FAQ page"}');
    t = await R.step(page, "bob chat task model words", { waitMs: 500 });
    log("MODEL WORDS", t.slice(-700));
    log("tasks after model words", (await R.api(B, "GET", `/projects/${kite}/tasks`)).length - tasks0);
    await page.getByTestId("confirm-yes").last().click().catch((e) => log("no yes", String(e)));
    await page.waitForTimeout(2500);
    t = await R.step(page, "bob chat task model words yes", { waitMs: 500 });
    log("AFTER YES", t.slice(-500));
    log("tasks after yes", (await R.api(B, "GET", `/projects/${kite}/tasks`)).length - tasks0);
    await browser.close();
    return;
  }
  if (step === "sametitle") {
    for (const _ of [1, 2])
      await R.api(B, "POST", `/projects/${kite}/tasks`, {
        title: "Write the guide",
        outcome: "The guide is written",
        riskTier: 1,
        specialist: "coder",
      });
    const { browser, page } = await R.openApp(B, { path: `/projects/${kite}/chat` });
    await page.waitForTimeout(3000);
    await chatSay(page, 'tool: task_pause {"task":"Write the guide (the older one)"}');
    let t = await R.step(page, "bob chat pause older same title", { waitMs: 500 });
    log("PAUSE READBACK", t.slice(-600));
    await page.getByTestId("confirm-yes").last().click().catch((e) => log("no yes", String(e)));
    await page.waitForTimeout(2500);
    t = await R.step(page, "bob chat pause older yes", { waitMs: 500 });
    log("PAUSE YES", t.slice(-500));
    await browser.close();
    return;
  }
  log("unknown step", step);
})().catch((e) => {
  log("ERROR", String(e?.stack ?? e));
  process.exit(1);
});
