// The two-person journey (w8-two-homes, wave 8; the owner's D9 of 2026-11-09: two people run
// their own Forerunners and meet on GitHub). Two benches, each its own home and SQLite store,
// on one stand-in GitHub with the users ada and bob and the organisation team:
//   node scripts/bench/start.mjs --name ada --daemon-port 49260 --ui-port 2860 --provider bench \
//        --githost 49262 --users ada,bob --org team --fresh
//   node scripts/bench/start.mjs --name bob --daemon-port 49261 --ui-port 2861 --provider bench \
//        --githost-shared ada --githost-user bob --fresh
//   node scripts/bench/journeys/two-people.cjs ada bob
//   node scripts/bench/stop.mjs --name bob --clean; node scripts/bench/stop.mjs --name ada --clean
// It walks every step of w8-journey's list (two-people-checks.cjs) with both apps open
// (recorder openTwo): screens of both people at each step, in each bench's steps/. The actions
// go through the daemon routes the UI calls (POST /projects, the intake, the Inbox answer,
// POST /sessions); the checks read the routes and the stand-in GitHub's request log. Checks
// marked `known` are D9's gaps on this code; the result (Ada's steps/two-people-result.json)
// lists them with the area that removes each mark. Exit 0 when every check that is not known
// passes; 1 otherwise.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { openTwo, step, api, apiRaw, bench, until } = require("../recorder.cjs");
const { STEPS, allChecks, privateOnGithub, summarize } = require("./two-people-checks.cjs");

const [A, B] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
if (!A || !B) {
  console.error("usage: node scripts/bench/journeys/two-people.cjs <ada bench> <bob bench>");
  process.exit(2);
}
const REPO = path.resolve(__dirname, "..", "..", "..");
const ada = bench(A);
const bob = bench(B);
const BRIEF =
  "A small static site for the team: a home page, an about page and a contact page; plain HTML and CSS; no build step";
const PROJECT = "Team site";
const GOAL = "A small site for the team";
const TOGETHER_LINE = "Shared on GitHub with another Forerunner: each keeps its own tasks.";

const declared = new Map(allChecks().map((c) => [c.id, c]));
const result = {
  benches: { ada: A, bob: B },
  startedAt: new Date().toISOString(),
  steps: [],
  checks: [],
  notes: [],
};
const out = (s) => console.log(`[two-people] ${s}`);
const check = (id, ok, detail = "") => {
  const c = declared.get(id);
  if (!c) throw new Error(`no check ${id} in two-people-checks.cjs`);
  result.checks.push({ ...c, ok: !!ok, detail: String(detail).slice(0, 600) });
  out(
    `${ok ? "ok  " : c.known ? "KNOWN" : "FAIL"} [${c.step}] ${c.name}${detail ? `: ${detail}` : ""}`,
  );
  return !!ok;
};

// The stand-in GitHub, read with a token of its own (stand-in tokens in Ada's githost.json).
const githostInfo = JSON.parse(
  fs.readFileSync(path.join(path.dirname(path.join(ada.home)), "githost.json"), "utf8"),
);
const readToken = githostInfo.users?.ada?.token ?? githostInfo.token;
async function github(route) {
  const res = await fetch(`${githostInfo.url}${route}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/vnd.github+json" },
  });
  return res.ok ? res.json() : [];
}
const requestLog = () =>
  fs
    .readFileSync(path.join(path.dirname(ada.home), "githost-requests.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const writesOf = (login) =>
  requestLog().filter(
    (r) => r.login === login && r.method !== "GET" && !/git-upload-pack$/.test(r.path),
  );

async function screens(two, label, paths = {}) {
  const shots = [];
  for (const [who, side, b] of [
    ["ada", two.a, ada],
    ["bob", two.b, bob],
  ]) {
    const p = paths[who];
    if (p) await side.page.goto(`${b.uiUrl}${p}`, { waitUntil: "domcontentloaded" });
    await step(side.page, `${label}-${who}`, { settleMs: 4000 });
    shots.push(`${who}: ${label}`);
  }
  return shots;
}

async function intakePlan(name, projectId) {
  return until(
    async () => {
      const s = await api(name, "GET", `/projects/${encodeURIComponent(projectId)}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    120_000,
    1000,
    "the plan card",
  );
}

async function approve(name, requestId) {
  const inbox = await api(name, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.id === requestId);
  if (!card) throw new Error(`plan card ${requestId} is not in the Inbox`);
  await api(name, "POST", `/requests/${encodeURIComponent(card.id)}/answer`, {
    version: card.version,
    answer: "approve",
  });
  return card;
}

async function sessionsDone(name, projectId) {
  await until(
    async () => {
      const running = await api(name, "GET", "/running");
      return !running.some((r) => r.projectId === projectId) ? true : null;
    },
    300_000,
    2000,
    `${name}'s sessions to end`,
  );
}

const titlesOf = async (name, projectId) =>
  (await api(name, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`)).map((t) => ({
    title: t.title,
    status: t.status,
  }));

async function main() {
  const two = await openTwo(A, B);
  try {
    // 1 Set up: each sets their name in the setup assistant (its route).
    await api(A, "POST", "/setup/profile", { name: "Ada" });
    await api(B, "POST", "/setup/profile", { name: "Bob" });
    const [adaMe, bobMe] = [await api(A, "GET", "/me"), await api(B, "GET", "/me")];
    check(
      "own-person",
      adaMe.name === "Ada" && bobMe.name === "Bob",
      `${adaMe.name} / ${bobMe.name}`,
    );
    check(
      "install-ids-differ",
      adaMe.desktopDeviceId && adaMe.desktopDeviceId !== bobMe.desktopDeviceId,
      "",
    );
    check(
      "agent-names-differ",
      adaMe.agent?.name !== bobMe.agent?.name,
      `${adaMe.agent?.name} / ${bobMe.agent?.name}`,
    );
    result.steps.push({ n: 1, screens: await screens(two, "01-setup", { ada: "/", bob: "/" }) });

    // 2 Ada makes the project from a brief and approves her plan.
    const made = await api(A, "POST", "/projects", {
      name: PROJECT,
      goal: GOAL,
      brief: BRIEF,
      repos: ["team/shared"],
      intake: true,
      switch: true,
    });
    const projectId = made.id;
    const adaPlan = await intakePlan(A, projectId);
    await approve(A, adaPlan.requestId);
    const adaTasks = await until(
      async () => {
        const t = await titlesOf(A, projectId);
        return t.length ? t : null;
      },
      60_000,
      1000,
      "Ada's tasks",
    );
    check("ada-plan", adaTasks.length > 0, `${adaTasks.length} tasks`);
    const prs = await github("/repos/team/shared/pulls?state=all");
    const docsPr = prs.find((p) => /^fr\/(intake-.+-docs|docs-scaffold)$/.test(p.head?.ref ?? ""));
    const docFiles = docsPr
      ? (await github(`/repos/team/shared/pulls/${docsPr.number}/files`)).map((f) => f.filename)
      : [];
    check(
      "guide-in-docs-pr",
      docFiles.includes("AGENTS.md") &&
        docFiles.includes("CLAUDE.md") &&
        !docFiles.includes("docs/status.md"),
      docsPr ? `#${docsPr.number}: ${docFiles.join(", ")}` : "no docs pull request",
    );
    result.steps.push({
      n: 2,
      screens: await screens(two, "02-project", { ada: `/projects/${projectId}`, bob: "/" }),
    });

    // 3 Bob links the same repository: Work together.
    const bobWritesBefore = writesOf("bob").length;
    const offer = await apiRaw(B, "POST", "/projects", {
      name: PROJECT,
      goal: GOAL,
      repos: ["team/shared"],
      switch: true,
    });
    const details = offer.body?.error?.details ?? offer.body?.details ?? {};
    check(
      "offer-together-only",
      offer.status === 409 && details.canWorkTogether === true && details.canTakeOver === false,
      `${offer.status} ${JSON.stringify(details).slice(0, 200)}`,
    );
    const together = await apiRaw(B, "POST", "/projects", {
      name: PROJECT,
      goal: GOAL,
      repos: ["team/shared"],
      switch: true,
      together: { project: projectId },
    });
    check("together-same-id", together.body?.id === projectId, `${together.status}`);
    check(
      "press-writes-nothing",
      writesOf("bob").length === bobWritesBefore,
      `${writesOf("bob").length - bobWritesBefore} writes by bob`,
    );
    const bobCard = await api(B, "GET", `/projects/${encodeURIComponent(projectId)}`);
    check(
      "together-line",
      bobCard.repositoryElsewhere?.text === TOGETHER_LINE,
      bobCard.repositoryElsewhere?.text ?? "no line",
    );
    result.steps.push({
      n: 3,
      screens: await screens(two, "03-work-together", {
        ada: `/projects/${projectId}`,
        bob: `/projects/${projectId}`,
      }),
    });

    // 4 Nothing private crosses.
    await api(A, "POST", "/projects", { name: "Ada private", goal: "Notes for Ada only" });
    const bobProjects = await api(B, "GET", "/projects");
    check(
      "private-project-not-on-bob",
      !bobProjects.some((p) => p.name === "Ada private"),
      bobProjects.map((p) => p.name).join(", "),
    );
    result.steps.push({ n: 4, screens: await screens(two, "04-private", { ada: "/", bob: "/" }) });

    // 5 Both plan: Bob's plan-only plan in the together project, then both sessions run.
    const bobIntake = await api(B, "POST", `/projects/${encodeURIComponent(projectId)}/intake`, {
      brief: BRIEF,
    });
    const bobPlan = await intakePlan(B, projectId);
    await approve(B, bobPlan.requestId ?? bobIntake.requestId);
    await sessionsDone(A, projectId);
    await sessionsDone(B, projectId);
    const adaDone = await titlesOf(A, projectId);
    const bobDone = await titlesOf(B, projectId);
    const adaTitles = new Set(adaDone.map((t) => t.title.toLowerCase()));
    const overlap = bobDone.filter((t) => adaTitles.has(t.title.toLowerCase()));
    check(
      "bob-plan-leaves-out-ada",
      bobDone.length > 0 && overlap.length === 0,
      `Bob planned ${bobDone.length}, ${overlap.length} also in Ada's plan: ${overlap.map((t) => `"${t.title}"`).join(", ")}`,
    );
    const doneTwice = overlap.filter(
      (t) =>
        t.status === "done" &&
        adaDone.some((a) => a.title.toLowerCase() === t.title.toLowerCase() && a.status === "done"),
    );
    check("no-task-twice", doneTwice.length === 0, `${doneTwice.length} done by both`);
    const bobView = JSON.stringify(
      await api(B, "GET", `/projects/${encodeURIComponent(projectId)}`),
    );
    check(
      "on-github-names-other",
      /Ada/.test(bobView),
      /Ada/.test(bobView) ? "" : "Bob's project view names nothing of Ada's",
    );
    result.steps.push({
      n: 5,
      screens: await screens(two, "05-both-plan", {
        ada: `/projects/${projectId}/tasks`,
        bob: `/projects/${projectId}/tasks`,
      }),
    });

    // 6 Not walked yet: announcements do not exist on this code.
    check("earlier-keeps-it", false, "not walked: no announcements yet");
    result.steps.push({ n: 6, walked: false });

    // 7 Live: Ada's done tasks on Bob's Overview.
    const adaFinished = adaDone.filter((t) => t.status === "done").map((t) => t.title);
    check(
      "bob-sees-ada-live",
      adaFinished.some((title) => bobView.includes(title)) &&
        !bobDone.some((t) => adaFinished.includes(t.title)),
      `${adaFinished.length} of Ada's tasks done; Bob's view names none of them as Ada's`,
    );
    result.steps.push({
      n: 7,
      screens: await screens(two, "07-live", { bob: `/projects/${projectId}` }),
    });

    // 8 Pull requests.
    const all = await github("/repos/team/shared/pulls?state=all");
    const byLogin = (login) =>
      new Set(all.filter((p) => p.user?.login === login).map((p) => p.number));
    const adaListed = (await api(A, "GET", `/projects/${projectId}/pull-requests`)).waiting ?? [];
    const bobListed = (await api(B, "GET", `/projects/${projectId}/pull-requests`)).waiting ?? [];
    const adaPrs = byLogin("ada");
    const bobPrs = byLogin("bob");
    check(
      "own-prs-only",
      adaListed.every((w) => adaPrs.has(w.number)) && bobListed.every((w) => bobPrs.has(w.number)),
      `Ada lists ${adaListed.map((w) => w.number).join(",")}; Bob lists ${bobListed.map((w) => w.number).join(",")}`,
    );
    const touches = (login, others) =>
      writesOf(login).filter((r) => {
        const m = /\/(?:pulls|issues)\/(\d+)/.exec(r.path);
        return m && others.has(Number(m[1]));
      });
    const crossed = [...touches("bob", adaPrs), ...touches("ada", bobPrs)];
    check(
      "no-write-to-other",
      crossed.length === 0,
      crossed.map((r) => `${r.login} ${r.method} ${r.path}`).join("; "),
    );
    check(
      "bob-lists-ada-info",
      bobListed.some((w) => adaPrs.has(w.number)),
      "Bob's list holds none of Ada's pull requests",
    );
    const github_ = all.map((p) => `${p.title}\n${p.body ?? ""}`).join("\n");
    const leaked = privateOnGithub(github_);
    check(
      "nothing-private-on-github",
      leaked.length === 0,
      leaked.length ? leaked.join(", ") : `${all.length} pull requests read`,
    );
    result.steps.push({
      n: 8,
      screens: await screens(two, "08-pull-requests", {
        ada: `/projects/${projectId}`,
        bob: `/projects/${projectId}`,
      }),
    });

    // 9 The status issue.
    const issues = await github("/repos/team/shared/issues?state=all");
    check(
      "one-status-issue",
      issues.filter((i) => i.title === `Forerunner status: ${PROJECT}` && !i.pull_request)
        .length === 1,
      `${issues.length} issues on the host`,
    );
    result.steps.push({ n: 9 });

    // 10 to 12: not walked yet on this code.
    check("bob-brief-names-merged", false, "not walked: nothing reads merged work yet");
    check("bob-leaves-paused", false, "not walked: needs announced paused work");
    check("comment-quoted-not-obeyed", false, "not walked: there is no status issue to comment on");
    result.steps.push({ n: 10, walked: false }, { n: 11, walked: false }, { n: 12, walked: false });

    // 13 GitHub unreachable for Bob only.
    const cut = (state) =>
      spawnSync(
        process.execPath,
        [path.join(REPO, "scripts", "bench", "cut.mjs"), B, "github", state],
        {
          encoding: "utf8",
        },
      );
    const reads = (login) => requestLog().filter((r) => r.login === login).length;
    const off = cut("off");
    const [bobBefore, adaBefore] = [reads("bob"), reads("ada")];
    await apiRaw(B, "GET", `/projects/${projectId}/pull-requests`);
    await apiRaw(A, "GET", `/projects/${projectId}/pull-requests`);
    await new Promise((r) => setTimeout(r, 500));
    check(
      "cut-only-bob",
      off.status === 0 && reads("bob") === bobBefore && reads("ada") > adaBefore,
      `${off.stdout.trim()} bob +${reads("bob") - bobBefore}, ada +${reads("ada") - adaBefore}`,
    );
    const bobOffline = await screens(two, "13-github-off", { bob: `/projects/${projectId}` });
    const bobText = fs.readFileSync(
      path.join(
        bob.steps,
        fs.readdirSync(bob.steps).filter((f) => f.endsWith("-13-github-off-bob.txt"))[0] ?? "",
      ),
      "utf8",
    );
    check(
      "status-words-offline",
      /Status on GitHub: last updated .+; it updates when GitHub answers\./.test(bobText),
      "",
    );
    const on = cut("on");
    const bobAgain = reads("bob");
    await apiRaw(B, "GET", `/projects/${projectId}/pull-requests`);
    await new Promise((r) => setTimeout(r, 500));
    check("cut-on-restores", on.status === 0 && reads("bob") > bobAgain, on.stdout.trim());
    result.steps.push({ n: 13, screens: bobOffline });

    // 14, 15: not walked yet.
    check("chat-answers-from-github", false, "not walked: chat reads nothing of GitHub's yet");
    check("ada-told-once", false, "not walked: there is no other writer's comment yet");
    result.steps.push({ n: 14, walked: false }, { n: 15, walked: false });

    // 16 Restart both daemons.
    for (const name of [A, B]) {
      const r = spawnSync(
        process.execPath,
        [path.join(REPO, "scripts", "bench", "restart-daemon.mjs"), "--name", name],
        { encoding: "utf8", timeout: 180_000 },
      );
      if (r.status !== 0) result.notes.push(`restart of ${name}: ${r.stderr.slice(-400)}`);
    }
    const [a2, b2] = [await api(A, "GET", "/me"), await api(B, "GET", "/me")];
    check(
      "restart-keeps-people",
      a2.name === "Ada" && b2.name === "Bob",
      `${a2.name} / ${b2.name}`,
    );
    const again = await api(B, "GET", `/projects/${encodeURIComponent(projectId)}`);
    check(
      "restart-keeps-together",
      again.id === projectId && again.repositoryElsewhere?.kind === "together",
      again.repositoryElsewhere?.kind ?? "no line",
    );
    result.steps.push({ n: 16 });
  } finally {
    await two.close();
  }
}

main()
  .catch((e) => {
    result.notes.push(`the journey stopped: ${e.message}`);
    out(`stopped: ${e.stack ?? e.message}`);
  })
  .finally(() => {
    // Every declared check is in the result: one the walk never reached is recorded as not run.
    for (const c of allChecks())
      if (!result.checks.some((r) => r.id === c.id))
        result.checks.push({ ...c, ok: false, detail: "not reached" });
    result.stepsListed = STEPS.map((s) => ({ n: s.n, title: s.title, walked: s.walked !== false }));
    result.summary = summarize(result.checks);
    result.endedAt = new Date().toISOString();
    const file = path.join(ada.steps, "two-people-result.json");
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    out(
      `${result.summary.passed}/${result.summary.checks} passed; failed (not known): ${result.summary.failed.join(", ") || "none"}; known: ${result.summary.known.length}; known but passing: ${result.summary.knownPassing.join(", ") || "none"}`,
    );
    out(`result: ${file}`);
    process.exitCode = result.summary.ok ? 0 : 1;
  });
