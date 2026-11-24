// fixup-w8-repo-guide bench walk: Bob's unmarked docs pull request on Ada's Overview (B1) and
// a person task's Inbox card and its record file (B2). Stand-in model and stand-in GitHub only.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const WT = "/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-8";
const { openApp, step, api, bench, until } = require(`${WT}/scripts/bench/recorder.cjs`);

const ADA = "fixup-w8-repo-guide";
const BOB = "fixup-w8-repo-guide-bob";
const root = "/tmp/frbench";
const out = { checks: [] };
const check = (label, ok, detail) => {
  out.checks.push({ label, ok: !!ok, detail });
  console.log(`[walk] ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

async function main() {
  const gh = JSON.parse(fs.readFileSync(path.join(root, ADA, "githost.json"), "utf8"));
  const bobToken = gh.users.bob.token;
  const ghApi = async (method, route, body) => {
    const res = await fetch(`${gh.url}${route}`, {
      method,
      headers: {
        authorization: `token ${bobToken}`,
        "content-type": "application/json",
        accept: "application/vnd.github+json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const projects = await api(ADA, "GET", "/projects");
  const list = Array.isArray(projects) ? projects : projects.projects;
  const team = list.find((p) => p.name === "Team site");
  if (!team) throw new Error("no Team site on Ada's computer");

  if (process.env.SKIP_B1 !== "1") {
  // B1: as Bob on GitHub, a docs branch whose marker names no project, and a pull request
  // whose body names no project.
  const bare = path.join(root, ADA, "githost", "team", "shared.git");
  const work = fs.mkdtempSync(path.join(root, BOB, "bob-clone-"));
  git(work, "clone", "-q", bare, ".");
  git(work, "config", "user.name", "Bob");
  git(work, "config", "user.email", "bob@example.test");
  git(work, "checkout", "-q", "-b", "fr/docs-scaffold-notes");
  if (fs.existsSync(path.join(work, ".forerunner", "project.json")))
    git(work, "rm", "-q", ".forerunner/project.json");
  fs.mkdirSync(path.join(work, "docs"), { recursive: true });
  fs.writeFileSync(path.join(work, "docs", "notes.md"), "# Notes\n\nBob's notes.\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "docs: notes");
  git(work, "push", "-q", "origin", "fr/docs-scaffold-notes");
  const sha = git(work, "rev-parse", "HEAD");
  const opened = await ghApi("POST", "/repos/team/shared/pulls", {
    title: "docs: notes",
    body: "Bob's notes for the repository.",
    head: "fr/docs-scaffold-notes",
    base: "main",
  });
  check("Bob opened his unmarked docs pull request", opened.status === 201, `#${opened.body?.number}`);
  const n = opened.body.number;
  const logBefore = fs.readFileSync(path.join(root, ADA, "githost-requests.jsonl"), "utf8").split("\n").length;

  const prs = await api(ADA, "GET", `/projects/${team.id}/pull-requests`);
  const row = prs.waiting.find((r) => r.number === n);
  check(
    "Ada's pull request list has Bob's as its own kind with a neutral title",
    row && row.kind === "listed" && row.title === `Docs pull request #${n}` && row.merge?.canMerge === false,
    JSON.stringify(row && { kind: row.kind, title: row.title, merge: row.merge }),
  );
  const merge = await api(ADA, "POST", `/projects/${team.id}/pull-requests/${n}/merge`, {}).catch((e) => ({ error: String(e.message) }));
  check(
    "Merge on it is refused with its line",
    merge.state === "refused" &&
      merge.sentence === `#${n} names no project, so it is only listed here: open it on GitHub to see whose it is.`,
    JSON.stringify(merge),
  );

  const ada = await openApp(ADA, { path: `/projects/${team.id}` });
  const page = ada.page;
  await page.waitForSelector('[data-testid="prs-listed"]', { timeout: 30_000 });
  const listedText = await page.locator('[data-testid="prs-listed"]').innerText();
  const waitingText = (await page.locator('[data-testid="prs-waiting"]').count())
    ? await page.locator('[data-testid="prs-waiting"]').innerText()
    : "";
  await page.locator('[data-testid="prs-listed"]').scrollIntoViewIfNeeded();
  await step(page, "fixup-overview-ada-listed-pr");
  check(
    "Ada's Overview lists it under 'Also open on GitHub' as 'Docs pull request #N' with its line",
    listedText.startsWith("Also open on GitHub") &&
      listedText.includes(`Docs pull request #${n}`) &&
      listedText.includes(`#${n} names no project, so it is only listed here: open it on GitHub to see whose it is.`),
    JSON.stringify(listedText),
  );
  check(
    "and never under 'Waiting for you to merge' or as \"The project's standard docs\"",
    !waitingText.includes(`#${n}`) &&
      (await page.locator(`[data-testid="pr-listed"][data-number="${n}"] [data-testid="pr-merge"]`).count()) === 0,
    JSON.stringify(waitingText.slice(0, 400)),
  );
  const lines = fs.readFileSync(path.join(root, ADA, "githost-requests.jsonl"), "utf8").split("\n").slice(logBefore - 1).filter(Boolean).map((l) => JSON.parse(l));
  const adaWrites = lines.filter((l) => l.login === "ada" && l.method !== "GET" && String(l.path).includes(`/pulls/${n}`));
  check("Ada wrote nothing to Bob's pull request", adaWrites.length === 0, `${adaWrites.length} writes`);
  check("Bob's branch head unchanged", git(work, "ls-remote", "origin", "fr/docs-scaffold-notes").startsWith(sha), sha);
  await ghApi("PATCH", `/repos/team/shared/pulls/${n}`, { state: "closed" });
  fs.rmSync(work, { recursive: true, force: true });
  await ada.browser.close().catch(() => undefined);
  }

  // B2: a folder project with a task for the person: the card names the record file, and the
  // answers land in it.
  const made = await api(ADA, "POST", "/projects", { name: "Club meetings", goal: "Notes for the club", repos: [] });
  const projectId = made.id ?? made.project?.id;
  await api(ADA, "POST", `/projects/${projectId}/tasks`, {
    title: "Choose the meeting day",
    outcome: "The meeting day is chosen",
    specialist: "person",
    acceptanceCriteria: ["Which day should the club meet?"],
    status: "ready",
  });
  const me = await api(ADA, "GET", "/me");
  const card = await until(async () => {
    const inbox = await api(ADA, "GET", `/inbox`);
    return (inbox.requests || []).find((r) => r.projectId === projectId && r.status === "open");
  }, 60_000, 1000, "the person card");
  const day = new Date().toISOString().slice(0, 10);
  const file = `docs/decisions/${day}-project-decisions.md`;
  check(
    "the Inbox card names the record's file",
    String(card.why).includes(`Your answers are written to the project's decision record (${file}).`),
    card.why,
  );
  const inboxPage = (await openApp(ADA, { path: "/inbox" })).page;
  await inboxPage.waitForTimeout(1500);
  await step(inboxPage, "fixup-inbox-card-names-record");
  await api(ADA, "POST", `/requests/${card.id}/answer`, {
    version: card.version,
    answer: { answers: [{ question: "Which day should the club meet?", answer: "Thursday" }] },
  });
  const ws = path.join(bench(ADA).projectsRoot, projectId, "workspace", "docs", "decisions");
  const names = fs.existsSync(ws) ? fs.readdirSync(ws).sort() : [];
  check("the answers are in that file, and only there", names.includes(`${day}-project-decisions.md`) && fs.readFileSync(path.join(ws, `${day}-project-decisions.md`), "utf8").includes("Thursday"), JSON.stringify(names));
  void me;
  fs.writeFileSync(path.join(root, ADA, "steps", "fixup-walk-b2-result.json"), JSON.stringify(out, null, 1));
  process.exit(out.checks.every((c) => c.ok) ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
