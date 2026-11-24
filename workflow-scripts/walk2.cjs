// Review walk 2: Ada takes over team/old (marked by "Old site", on no computer here) while Bob's
// unmarked docs pull request is open on its fr/docs-scaffold; Try again; Try again with GitHub cut.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const A = "review-w8-repo-guide";
const OUT = "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad";
const GH = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
const OLD = "01a1b000-0000-7000-8000-0000000001d0";
const gh = async (login, method, route, body) => {
  const res = await fetch(`${GH.url}${route}`, {
    method,
    headers: {
      authorization: `token ${GH.users[login].token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (res.status >= 400) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};
const put = (login, path, text, branch, message) =>
  gh(login, "PUT", `/repos/team/old/contents/${path}`, {
    message,
    content: Buffer.from(text).toString("base64"),
    branch,
  });
const writesBy = (login) =>
  fs
    .readFileSync(`/tmp/frbench/${A}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.login === login && r.method !== "GET");

(async () => {
  await gh("ada", "POST", "/orgs/team/repos", { name: "old", private: true });
  await put("ada", "README.md", "# old\n", "main", "seed");
  await put(
    "ada",
    ".forerunner/project.json",
    `${JSON.stringify({ schema: 1, project: OLD, name: "Old site" }, null, 2)}\n`,
    "main",
    "seed marker",
  );
  const main = await gh("bob", "GET", "/repos/team/old/git/ref/heads/main");
  await gh("bob", "POST", "/repos/team/old/git/refs", {
    ref: "refs/heads/fr/docs-scaffold",
    sha: main.object.sha,
  });
  await put("bob", "docs/notes.md", "# Notes\n\nBob's notes.\n", "fr/docs-scaffold", "docs: notes");
  const bobPr = await gh("bob", "POST", "/repos/team/old/pulls", {
    title: "docs: notes",
    body: "Bob's notes for the repository.",
    head: "fr/docs-scaffold",
    base: "main",
  });
  const bobHead = (await gh("bob", "GET", "/repos/team/old/git/ref/heads/fr/docs-scaffold")).object.sha;
  console.log("bob's PR on team/old", bobPr.number, bobHead);
  const adaWritesBefore = writesBy("ada").length;

  // Ada: New project on team/old, typed as a web address. First the refusal, then Take it over.
  const first = await R.apiRaw(A, "POST", "/projects", {
    name: "Old site again",
    goal: "The old site, kept going",
    repos: ["http://127.0.0.1:49274/team/old"],
  });
  console.log("first POST /projects", first.status, JSON.stringify(first.body).slice(0, 600));
  const made = await R.api(A, "POST", "/projects", {
    name: "Old site again",
    goal: "The old site, kept going",
    repos: ["https://github.com/team/old"],
    switch: true,
    takeOver: { projects: [OLD] },
  });
  const id = made.id ?? made.project?.id;
  console.log("made", id);
  fs.writeFileSync(`${OUT}/took.json`, JSON.stringify({ id, bobPr: bobPr.number, bobHead }));
  const b = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/bench.json`, "utf8"));
  const app = await R.openApp(A);
  try {
    const page = app.page;
    await page.goto(`${b.uiUrl}/projects/${id}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    let t = await R.step(page, "review-takeover-overview");
    console.log("---- overview\n", t.slice(0, 2500));
    await page.getByTestId("repository-try-again-button").click();
    await page.waitForTimeout(4000);
    t = await R.step(page, "review-takeover-try-again");
    const k = t.indexOf("Took over");
    console.log("---- after Try again\n", t.slice(Math.max(0, k - 100), k + 900));
    // GitHub cut for Ada only, then Try again.
    execFileSync("node", ["/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7/scripts/bench/cut.mjs", A, "github", "off"], { stdio: "inherit" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.getByTestId("repository-try-again-button").click();
    await page.waitForTimeout(8000);
    t = await R.step(page, "review-takeover-try-again-github-off");
    const k2 = t.indexOf("Took over");
    console.log("---- after Try again (GitHub off)\n", t.slice(Math.max(0, k2 - 100), k2 + 900));
    execFileSync("node", ["/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7/scripts/bench/cut.mjs", A, "github", "on"], { stdio: "inherit" });
  } finally {
    await app.browser.close();
  }
  const after = (await gh("bob", "GET", "/repos/team/old/git/ref/heads/fr/docs-scaffold")).object.sha;
  console.log("bob's branch unchanged:", after === bobHead);
  const comments = await gh("bob", "GET", `/repos/team/old/issues/${bobPr.number}/comments`);
  console.log("comments on bob's PR:", JSON.stringify(comments).slice(0, 400));
  console.log(
    "ada's writes since:",
    JSON.stringify(writesBy("ada").slice(adaWritesBefore).map((r) => `${r.method} ${r.path ?? r.url}`)),
  );
  const prs = await gh("ada", "GET", "/repos/team/old/pulls?state=all");
  console.log("PRs on team/old:", JSON.stringify(prs.map((p) => [p.number, p.head.ref, p.user.login, p.state])));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
