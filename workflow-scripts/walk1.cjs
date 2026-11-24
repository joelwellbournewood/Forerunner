// Review walk 1: both people's Docs tabs; Bob's unmarked docs pull request on Ada's Overview.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");

const A = "review-w8-repo-guide";
const B = "review-w8-repo-guide-bob";
const GH = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
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

(async () => {
  const projects = (await R.api(A, "GET", "/projects")).projects ?? (await R.api(A, "GET", "/projects"));
  const list = Array.isArray(projects) ? projects : projects.projects;
  const team = list.find((p) => p.name === "Team site");
  console.log("team", team.id);
  const two = await R.openTwo(A, B);
  try {
    for (const [name, page] of [
      [A, two.a.page],
      [B, two.b.page],
    ]) {
      const b = JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8"));
      await page.goto(`${b.uiUrl}/projects/${team.id}/docs`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const t = await R.step(page, `review-docs-tab-${name.endsWith("bob") ? "bob" : "ada"}`);
      console.log(`---- ${name} docs tab\n${t.slice(0, 3000)}`);
    }
    // Bob pushes an unmarked fr/docs-scaffold and opens a pull request whose body names no project.
    const main = await gh("bob", "GET", "/repos/team/shared/git/ref/heads/main");
    await gh("bob", "POST", "/repos/team/shared/git/refs", {
      ref: "refs/heads/fr/docs-scaffold",
      sha: main.object.sha,
    });
    await gh("bob", "PUT", "/repos/team/shared/contents/docs/notes.md", {
      message: "docs: notes",
      content: Buffer.from("# Notes\n\nBob's notes.\n").toString("base64"),
      branch: "fr/docs-scaffold",
    });
    const pr = await gh("bob", "POST", "/repos/team/shared/pulls", {
      title: "docs: notes",
      body: "Bob's notes for the repository.",
      head: "fr/docs-scaffold",
      base: "main",
    });
    console.log("bob's unmarked PR", pr.number);
    fs.writeFileSync(
      "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/bobpr.json",
      JSON.stringify({ number: pr.number, team: team.id }),
    );
    const ab = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/bench.json`, "utf8"));
    await two.a.page.goto(`${ab.uiUrl}/projects/${team.id}`, { waitUntil: "domcontentloaded" });
    await two.a.page.waitForTimeout(4000);
    const t = await R.step(two.a.page, "review-overview-ada-unmarked-pr");
    const i = t.indexOf("Waiting for you to merge");
    console.log(`---- ada overview\n${t.slice(Math.max(0, i - 200), i + 1500)}`);
    const prs = await R.api(A, "GET", `/projects/${team.id}/pull-requests`);
    console.log(JSON.stringify((prs.waiting || []).filter((r) => r.kind === "docs"), null, 1).slice(0, 3000));
  } finally {
    await two.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
