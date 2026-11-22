// Fix-up walk of fix/l3-merge on the bench "fixup-l3-merge" (stand-in model, stand-in GitHub),
// built on the reviewer's walk (same phases) plus the fix-up's squash, rebase and squashpush checks.
//   node fixup-l3-walk.cjs <phases comma-separated> <tag>
//   phases: lock, stale, moved, squash, rebase, squashpush, cancel
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = "/home/user/Forerunner/.claude/worktrees/wf_d49abaae-666-14";
const NAME = "fixup-l3-merge";
const PHASES = (process.argv[2] ?? "lock,stale,moved,squash").split(",");
const TAG = process.argv[3] ?? "f";
const R = require(path.join(ROOT, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const resultFile = `/tmp/frbench/fixup-l3-merge/walk-${TAG}-${PHASES.join("-")}.json`;
const result = { checks: [], notes: {} };
const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
const out = (s) => console.log(`[fixup] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  save();
};
const note = (k, v) => {
  result.notes[k] = v;
  out(`note ${k}: ${JSON.stringify(v).slice(0, 600)}`);
  save();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Pat",
  GIT_AUTHOR_EMAIL: "pat@example.test",
  GIT_COMMITTER_NAME: "Pat",
  GIT_COMMITTER_EMAIL: "pat@example.test",
};
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
const b = () => R.bench(NAME);
const gh = JSON.parse(fs.readFileSync(path.join("/tmp/frbench", NAME, "githost.json"), "utf8"));
const bare = (() => {
  const p = path.join("/tmp/frbench", NAME, "githost", "bench", "seeded");
  return fs.existsSync(p) ? p : `${p}.git`;
})();
const ghApi = async (method, p, body) => {
  const res = await fetch(`${gh.url}/repos/bench/seeded${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${gh.token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const mainFiles = () =>
  git("/tmp", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"]).split("\n");
const rowsOf = async (projectId) =>
  (await R.api(NAME, "GET", `/projects/${enc(projectId)}/pull-requests`)).waiting;
const cardsOf = async (taskId) =>
  (await R.api(NAME, "GET", "/inbox")).requests.filter((r) => r.taskId === taskId);
const tasksOf = async (projectId) => R.api(NAME, "GET", `/projects/${enc(projectId)}/tasks`);
const prOf = (t) => Number(/\/pull\/(\d+)/.exec(t.prUrl ?? t.pr_url ?? "")?.[1]);
const D = `rv${TAG}`;

async function waitIdle(projectId, ms = 300_000) {
  await R.until(
    async () => {
      const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`);
      const all = Array.isArray(list) ? list : (list.sessions ?? []);
      return (
        all.length > 0 && all.every((s) => !["running", "planned", "paused"].includes(s.status))
      );
    },
    ms,
    1000,
    "the project's sessions to end",
  );
}
/** Waits for the watcher's next poll by its log lines (about a minute on the bench). */
async function nextPoll(label) {
  const log = b().logs.daemon;
  const size = fs.statSync(log).size;
  out(`waiting for the watcher's next poll (${label})`);
  // A poll is about a minute on the bench and logs nothing when nothing changed: wait for a line
  // that says it saw something, or 75 s.
  await R.until(
    async () =>
      /pull request (merged|closed) on the host|dependent (pull request|branch) rebuilt|merge cards closed/.test(
        fs.readFileSync(log, "utf8").slice(size),
      ),
    75_000,
    1000,
    "the watcher's next poll",
  ).catch(() => undefined);
  await sleep(8000);
}
async function project(name, tasks) {
  const p = await R.api(NAME, "POST", "/projects", {
    name: `${name} ${TAG}`,
    goal: "Club pages",
    repos: ["bench/seeded"],
  });
  const ids = [];
  for (const t of tasks) {
    const row = await R.api(NAME, "POST", `/projects/${enc(p.id)}/tasks`, {
      title: t.title,
      outcome: `${t.file} is written`,
      acceptanceCriteria: [`${t.file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn: (t.dependsOn ?? []).map((i) => ids[i]),
      specialist: "coder",
      riskTier: 1,
    });
    ids.push(row.id);
  }
  return { id: p.id, ids };
}
async function go(page, url, label) {
  await page.goto(`${b().uiUrl}${url}`);
  await page.waitForTimeout(2500);
  return R.step(page, label);
}
async function pressMerge(page, projectId, n, label) {
  await page.goto(`${b().uiUrl}/projects/${enc(projectId)}/summary`);
  await page.waitForTimeout(2500);
  await R.step(page, `${label}-before-press`);
  const answer = page.waitForResponse((r) => r.url().includes(`/pull-requests/${n}/merge`));
  await page.locator(`[data-testid=pr-waiting][data-number="${n}"] [data-testid=pr-merge]`).click();
  const ans = await (await answer).json();
  await page.waitForTimeout(400);
  const text = await R.step(page, `${label}-right-after-press`);
  return { ans, text };
}
async function pushCommit(branch, file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rv-push-"));
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${gh.token}`).toString("base64")}`;
  git(tmp, ["-c", `http.extraheader=${header}`, "clone", "-q", `${gh.url}/bench/seeded.git`, "c"]);
  const c = path.join(tmp, "c");
  git(c, ["config", "http.extraheader", header]);
  git(c, ["checkout", "-q", branch]);
  fs.writeFileSync(path.join(c, file), "pushed on GitHub after the review\n");
  git(c, ["add", file]);
  git(c, ["commit", "-qm", "A commit after the review"]);
  git(c, ["push", "-q", "origin", `HEAD:${branch}`]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
async function chainProject(name) {
  const k = name.toLowerCase().replace(/[^a-z]+/g, "");
  const p = await project(name, [
    { title: `Write ${D}/${k}.txt with one line`, file: `${D}/${k}.txt` },
    {
      title: `Write ${D}/${k}-day.txt after the ${k} file`,
      file: `${D}/${k}-day.txt`,
      dependsOn: [0],
    },
  ]);
  await R.startSession(NAME, p.id, `review ${name}`);
  await waitIdle(p.id);
  const tasks = await tasksOf(p.id);
  const [a, bb] = p.ids.map((id) => tasks.find((t) => t.id === id));
  return { p, a, bb, prA: prOf(a), prB: prOf(bb) };
}

async function lock(page) {
  const { p, a, bb, prA, prB } = await chainProject("Club");
  note("lock.prs", { prA, prB, a: a.display?.label, b: bb.display?.label });
  const rows = await rowsOf(p.id);
  const rowB = rows.find((r) => r.number === prB);
  check("B's row says it merges A first", JSON.stringify(rowB?.merge?.first) === JSON.stringify([prA]), JSON.stringify(rowB?.merge));
  const closed = await ghApi("PATCH", `/pulls/${prA}`, { state: "closed" });
  check("A closed on GitHub", closed.status === 200);
  const t0 = Date.now();
  const { ans, text } = await pressMerge(page, p.id, prB, "lock");
  note("lock.answer", { ans, ms: Date.now() - t0 });
  const want = `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`;
  check("the press answers the rebuilt-without sentence", ans.state === "refused" && ans.sentence === want, ans.sentence);
  check("the page shows the refusal right after the press, never Merging", text.includes(want) && !text.includes(`Merging #${prB}`), text.slice(0, 300));
  await sleep(6000);
  await R.step(page, "lock-after-6s");
  check("B not merged on GitHub", (await ghApi("GET", `/pulls/${prB}`)).body.merged === false);
  check("main has no file of A", !mainFiles().includes(`${D}/club.txt`), JSON.stringify(mainFiles()));
  const files = (await ghApi("GET", `/pulls/${prB}/files`)).body.map((f) => f.filename);
  check("B's PR holds only its own file", JSON.stringify(files) === JSON.stringify([`${D}/club-day.txt`]), JSON.stringify(files));
  const cards = (await cardsOf(bb.id)).filter((c) => c.status === "open");
  note("lock.cards", cards.map((c) => ({ title: c.title, body: c.body, details: c.details, choices: c.choices?.map((x) => x.label) })));
  check("exactly one card for B", cards.length === 1, JSON.stringify(cards.map((c) => c.title)));
  check(
    "card title",
    cards[0]?.title === `"Write ${D}/club-day.txt after the club file" was rebuilt without pull request #${prA}`,
    cards[0]?.title,
  );
  await page.goto(`${b().uiUrl}/inbox`);
  await page.waitForTimeout(2500);
  const el = page.locator("[data-testid=request]", { hasText: "was rebuilt without" }).first();
  await el.locator("[data-testid=request-details] summary").click().catch(() => undefined);
  await page.waitForTimeout(500);
  const inboxText = await R.step(page, "lock-inbox-card-details");
  check("Details show a rebuild's steps (L3-github-7)", inboxText.includes(`it no longer holds the changes of #${prA}`) && !inboxText.includes("commits pushed after the review"), "");
  await go(page, `/projects/${enc(p.id)}/tasks`, "lock-tasks");
  note("lock.taskLabels", (await tasksOf(p.id)).map((t) => `${t.title}: ${t.display?.label}`));
  // Nothing merges it by itself: a poll and its retry.
  await nextPoll("lock");
  check("B still not merged after a poll", (await ghApi("GET", `/pulls/${prB}`)).body.merged === false);
  check("still one card for B", (await cardsOf(bb.id)).filter((c) => c.status === "open").length === 1);
  // The person looked and presses Merge on the card in the Inbox.
  await page.goto(`${b().uiUrl}/inbox`);
  await page.waitForTimeout(2500);
  const card = page.locator("[data-testid=request]", { hasText: "was rebuilt without" }).first();
  await card.locator("[data-testid=option]", { hasText: /^Merge$/ }).click();
  await page.waitForTimeout(4000);
  await R.step(page, "lock-card-merge-pressed");
  await R.until(async () => (await ghApi("GET", `/pulls/${prB}`)).body.merged === true, 60_000, 1000, "B merged").catch(() => undefined);
  check("B merged after the person's Merge on the card", (await ghApi("GET", `/pulls/${prB}`)).body.merged === true);
  check("main has B's file and not A's", mainFiles().includes(`${D}/club-day.txt`) && !mainFiles().includes(`${D}/club.txt`), JSON.stringify(mainFiles()));
  await sleep(3000);
  const after = await cardsOf(bb.id);
  note("lock.cardsAfterMerge", after.map((c) => ({ status: c.status, outcome: c.outcome })));
  check("no open card for B", after.every((c) => c.status !== "open"));
  await go(page, "/inbox", "lock-inbox-after-merge");
}

async function stale(page) {
  const { p, bb, prA, prB } = await chainProject("Notes");
  note("stale.prs", { prA, prB });
  await ghApi("PATCH", `/pulls/${prA}`, { state: "closed" });
  await nextPoll("stale close");
  await R.until(async () => (await cardsOf(bb.id)).some((c) => c.status === "open"), 90_000, 1000, "B's rebuild card");
  const card = (await cardsOf(bb.id)).find((c) => c.status === "open");
  note("stale.card", { title: card.title, details: card.details });
  const merged = await ghApi("PUT", `/pulls/${prB}/merge`, { merge_method: "merge" });
  check("B merged on GitHub", merged.status === 200, String(merged.status));
  await nextPoll("stale merged");
  const open = (await cardsOf(bb.id)).filter((c) => c.status === "open");
  check("no card of B in Needs you once merged on GitHub", open.length === 0, JSON.stringify(open.map((c) => c.title)));
  const closed = (await cardsOf(bb.id)).find((c) => c.id === card.id);
  check("its Answered line", closed?.outcome === `Closed: #${prB} was merged.`, closed?.outcome);
  await page.goto(`${b().uiUrl}/inbox`);
  await page.waitForTimeout(2500);
  await page.locator("[data-testid=answered] summary").click().catch(() => undefined);
  await page.waitForTimeout(500);
  const t = await R.step(page, "stale-inbox-answered");
  check("the Inbox's Answered shows Closed: #B was merged.", t.includes(`Closed: #${prB} was merged.`));
  note("stale.taskLabels", (await tasksOf(p.id)).map((x) => `${x.title}: ${x.display?.label}`));
  // Restart the daemon: the card stays closed.
  execFileSync("node", [path.join(ROOT, "scripts/bench/restart-daemon.mjs"), "--name", NAME], { encoding: "utf8" });
  await sleep(4000);
  check("after a restart, still no open card for B", (await cardsOf(bb.id)).every((c) => c.status !== "open"));
  // The chat is asked what is left to merge.
  const me = await R.api(NAME, "GET", "/me");
  const agents = await R.api(NAME, "GET", "/agents");
  const reply = await R.api(NAME, "POST", "/chat", {
    humanId: me.id,
    agentId: agents[0].id,
    projectId: p.id,
    projectTab: true,
    text: "what is left to merge?",
    source: "text",
  });
  const calls = R.modelCalls(NAME, "chat");
  const told = JSON.stringify(calls[calls.length - 1] ?? {});
  check("the chat is not told B was not merged", !told.includes(`pull request #${prB} was not merged`));
  note("stale.chatReply", reply.reply?.slice(0, 300));
}

async function moved(page) {
  const title = `Link trips page from ${D}/index.html as "Our trips"`;
  const p = await project("Trips", [{ title, file: `${D}/index.html` }]);
  await R.startSession(NAME, p.id, "review moved");
  await waitIdle(p.id);
  const t = (await tasksOf(p.id))[0];
  const pr = prOf(t);
  const branch = (await ghApi("GET", `/pulls/${pr}`)).body.head.ref;
  await pushCommit(branch, `${D}-extra.txt`);
  const t0 = Date.now();
  const { ans, text } = await pressMerge(page, p.id, pr, "moved");
  note("moved.answer", { ans, ms: Date.now() - t0 });
  const want = `#${pr} changed after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks.`;
  check("the press answers the head move at once", ans.state === "refused" && ans.sentence === want, ans.sentence);
  check("the page never shows Merging #N", !text.includes(`Merging #${pr}`));
  await sleep(4000);
  const t2 = await R.step(page, "moved-after-4s");
  const row = (await rowsOf(p.id)).find((r) => r.number === pr);
  check("the row offers no Merge and says why", row?.merge?.canMerge === false && row?.merge?.sentence === want, JSON.stringify(row?.merge));
  check("GitHub: not merged", (await ghApi("GET", `/pulls/${pr}`)).body.merged === false);
  const cards = (await cardsOf(t.id)).filter((x) => x.status === "open");
  note("moved.cards", cards.map((x) => ({ title: x.title, details: x.details, choices: x.choices?.map((c) => c.label) })));
  check("one head-moved card", cards.length === 1);
  check("its title keeps the quoted title whole (L3-github-9)", cards[0]?.title === `"${title}" changed after the review`, cards[0]?.title);
  await go(page, "/inbox", "moved-inbox");
  await go(page, `/projects/${enc(p.id)}/tasks`, "moved-tasks");
  note("moved.label", (await tasksOf(p.id))[0]?.display?.label);
  // The person merges it on GitHub as the card says: the card closes at the next poll.
  const m = await ghApi("PUT", `/pulls/${pr}/merge`, { merge_method: "merge" });
  check("merged on GitHub", m.status === 200);
  await nextPoll("moved merged");
  const left = (await cardsOf(t.id)).filter((x) => x.status === "open");
  check("the head-moved card closes once merged on GitHub", left.length === 0, JSON.stringify(left.map((x) => x.title)));
  note("moved.closedOutcome", (await cardsOf(t.id)).map((x) => x.outcome));
}

async function squash(page, method = "squash") {
  const label = method === "squash" ? "squash" : "rebase";
  const { p, a, bb, prA, prB } = await chainProject(method === "squash" ? "Squash" : "Rebase");
  const k = method === "squash" ? "squash" : "rebase";
  note(`${label}.prs`, { prA, prB });
  // The person squash- (or rebase-) merges A on GitHub's website, then presses Merge on B in the
  // app before Forerunner's next look.
  const m = await ghApi("PUT", `/pulls/${prA}/merge`, { merge_method: method });
  check(`A ${method}-merged on GitHub`, m.status === 200, String(m.status));
  const { ans, text } = await pressMerge(page, p.id, prB, label);
  note(`${label}.answer`, ans);
  check(
    `Merge on B answers "Merging #B." (A ${method}-merged; nobody pushed to B)`,
    ans.state === "queued" && ans.sentence === `Merging #${prB}.`,
    ans.sentence,
  );
  check("the page does not say B changed after the review", !text.includes("changed after the review"), "");
  await R.until(async () => (await ghApi("GET", `/pulls/${prB}`)).body.merged === true, 60_000, 1000, "B merged").catch(() => undefined);
  await sleep(2000);
  await R.step(page, `${label}-after-merge`);
  check("B merged on GitHub", (await ghApi("GET", `/pulls/${prB}`)).body.merged === true);
  const files = mainFiles();
  check("main has A's and B's files", files.includes(`${D}/${k}.txt`) && files.includes(`${D}/${k}-day.txt`), JSON.stringify(files));
  const log = git("/tmp", ["--git-dir", bare, "log", "--format=%H", "main", "--", `${D}/${k}.txt`]).split("\n").filter(Boolean);
  check("A's change is on main once", log.length === 1, JSON.stringify(log));
  const cards = (await cardsOf(bb.id)).filter((c) => c.status === "open");
  check("no open card for B", cards.length === 0, JSON.stringify(cards.map((c) => c.title)));
  check("no task row waits to be merged", (await rowsOf(p.id)).filter((r) => r.kind === "task").length === 0, JSON.stringify((await rowsOf(p.id)).map((r) => [r.number, r.kind, r.merge?.sentence])));
  await go(page, "/inbox", `${label}-inbox`);
  const tasksText = await go(page, `/projects/${enc(p.id)}/tasks`, `${label}-tasks`);
  const labels = (await tasksOf(p.id)).map((t) => `${t.title}: ${t.display?.label}`);
  note(`${label}.labels`, labels);
  check("no Tasks row says changed after the review", !tasksText.includes("changed after the review"), labels.join(" | "));
  await nextPoll(label);
  check("B still merged after the next poll, no card", (await ghApi("GET", `/pulls/${prB}`)).body.merged === true && (await cardsOf(bb.id)).every((c) => c.status !== "open"));
  note(`${label}.aLabel`, (await tasksOf(p.id)).find((t) => t.id === a.id)?.display?.label);
}

async function squashpush(page) {
  // Sibling: a commit pushed to B's branch on GitHub, then A squash-merged, then Merge on B.
  const { p, bb, prA, prB } = await chainProject("Pushed");
  const branch = (await ghApi("GET", `/pulls/${prB}`)).body.head.ref;
  await pushCommit(branch, `${D}-theirs.txt`);
  const m = await ghApi("PUT", `/pulls/${prA}/merge`, { merge_method: "squash" });
  check("A squash-merged on GitHub", m.status === 200, String(m.status));
  const { ans, text } = await pressMerge(page, p.id, prB, "squashpush");
  note("squashpush.answer", ans);
  const want = `#${prB} changed after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks.`;
  check("the press answers the head move at once", ans.state === "refused" && ans.sentence === want, ans.sentence);
  check("the page shows it and never Merging", text.includes(want) && !text.includes(`Merging #${prB}`), "");
  await sleep(4000);
  check("B not merged", (await ghApi("GET", `/pulls/${prB}`)).body.merged === false);
  check("main has not the pushed file", !mainFiles().includes(`${D}-theirs.txt`), JSON.stringify(mainFiles()));
  const row = (await rowsOf(p.id)).find((r) => r.number === prB);
  check("B's row offers no Merge and says why", row?.merge?.canMerge === false && row?.merge?.sentence === want, JSON.stringify(row?.merge));
  const cards = (await cardsOf(bb.id)).filter((c) => c.status === "open");
  note("squashpush.cards", cards.map((c) => ({ title: c.title, choices: c.choices?.map((x) => x.label) })));
  check("one changed-after-the-review card", cards.length === 1 && cards[0].title === `"Write ${D}/pushed-day.txt after the pushed file" changed after the review`, JSON.stringify(cards.map((c) => c.title)));
  await go(page, "/inbox", "squashpush-inbox");
  await go(page, `/projects/${enc(p.id)}/tasks`, "squashpush-tasks");
  await nextPoll("squashpush");
  check("still one card and B not merged after a poll", (await cardsOf(bb.id)).filter((c) => c.status === "open").length === 1 && (await ghApi("GET", `/pulls/${prB}`)).body.merged === false);
}

async function cancel(page) {
  const p = await project("Club pages", [{ title: "Write the About page in about.html", file: "about.html" }]);
  const me = await R.api(NAME, "GET", "/me");
  const agents = await R.api(NAME, "GET", "/agents");
  await R.startSession(NAME, p.id, "review cancel");
  await R.until(
    async () => {
      const t = (await tasksOf(p.id))[0];
      return t?.display?.label === "Being reviewed" && t?.prUrl;
    },
    180_000,
    1000,
    "the task in review with its pull request",
  );
  const t = (await tasksOf(p.id))[0];
  const pr = prOf(t);
  // In the UI: the Chat tab.
  await page.goto(`${b().uiUrl}/projects/${enc(p.id)}/chat`);
  await page.waitForTimeout(2500);
  const box = page.getByLabel("Chat message").first();
  await box.fill("skip the About page task");
  await box.press("Enter");
  await page.waitForTimeout(4000);
  const readback = await R.step(page, "cancel-chat-readback");
  const want = `#${pr} stays open on GitHub: close it there if you do not want it.`;
  check("the read-back names the pull request", readback.includes(`Its review stops now; ${want}`), "");
  const say = (text) =>
    R.api(NAME, "POST", "/chat", { humanId: me.id, agentId: agents[0].id, projectId: p.id, projectTab: true, text, source: "text" });
  const yes = await say("yes");
  note("cancel.yes", yes.reply);
  check("the Yes line names it", (yes.reply ?? "").includes(want), yes.reply);
  await waitIdle(p.id).catch(() => undefined);
  check("its PR stays open on GitHub", (await ghApi("GET", `/pulls/${pr}`)).body.state === "open");
  const rows = await rowsOf(p.id);
  note("cancel.rows", rows.map((r) => ({ n: r.number, kind: r.kind, merge: r.merge })));
  const ov = await go(page, `/projects/${enc(p.id)}/summary`, "cancel-overview");
  check("Overview: Cancelled, still open on GitHub, with the PR", ov.includes("Cancelled, still open on GitHub") && ov.includes(`pull request #${pr}`), "");
  const merge = page.locator(`[data-testid=pr-cancelled][data-number="${pr}"] [data-testid=pr-merge]`);
  check("no Merge on the cancelled row", (await merge.count()) === 0);
  const where = await say("where are my files?");
  const calls = R.modelCalls(NAME, "chat");
  const sys = JSON.stringify(calls[calls.length - 1] ?? {});
  check("chat facts name it", sys.includes(`/pull/${pr}`) && sys.includes("Left open on GitHub when their task was cancelled"), "");
  note("cancel.where", where.reply?.slice(0, 300));
  await ghApi("PATCH", `/pulls/${pr}`, { state: "closed" });
  const ov2 = await go(page, `/projects/${enc(p.id)}/summary`, "cancel-overview-after-close");
  check("after the close on GitHub the heading is gone", !ov2.includes("Cancelled, still open on GitHub"));
  const where2 = await say("where are my files?");
  const calls2 = R.modelCalls(NAME, "chat");
  const sys2 = JSON.stringify(calls2[calls2.length - 1] ?? {});
  note("cancel.factsAfterClose", sys2.includes("Left open on GitHub when their task was cancelled"));
  note("cancel.where2", where2.reply?.slice(0, 200));
}

(async () => {
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    for (const ph of PHASES) {
      out(`phase ${ph}`);
      try {
        if (ph === "lock") await lock(page);
        if (ph === "stale") await stale(page);
        if (ph === "moved") await moved(page);
        if (ph === "squash") await squash(page, "squash");
        if (ph === "rebase") await squash(page, "rebase");
        if (ph === "squashpush") await squashpush(page);
        if (ph === "cancel") await cancel(page);
      } catch (e) {
        check(`phase ${ph} ran to its end`, false, String(e?.stack ?? e).slice(0, 800));
      }
    }
  } finally {
    save();
    await browser.close();
  }
})();
