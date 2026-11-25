// w8-together AFTER walk (stand-in model, stand-in GitHub): Bob's "Site" on team/shared, whose
// marker names Ada's "Team site", gets Work together on its Overview; the dialog, the press, the
// joined page; Ada's Add to answers at once and her page says "Drafting the plan...".
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const REPO = process.env.REPO;
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const A = "w8t-after";
const B = "w8t-after-bob";
const label = "after";
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
async function github(method, route, body, token = gh.users.ada.token) {
  const res = await fetch(`${gh.url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const cut = (b, state) =>
  spawnSync("node", [path.join(REPO, "scripts/bench/cut.mjs"), b, "github", state], {
    stdio: "inherit",
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const made = await R.api(A, "POST", "/projects", {
    name: "Team site",
    goal: "A small site for the team",
    repos: ["team/shared"],
  });
  console.log("ada made", made.id ?? made);
  await wait(3000);
  const prs = await github("GET", "/repos/team/shared/pulls?state=all");
  console.log("prs", JSON.stringify(prs.map((p) => [p.number, p.head.ref, p.user.login])));
  const docs = prs.find((p) => p.head.ref.startsWith("fr/docs-scaffold"));
  if (docs) {
    const m = await github("PUT", `/repos/team/shared/pulls/${docs.number}/merge`, {
      merge_method: "squash",
    });
    console.log("merged", m.merged ?? m);
  }
  cut(B, "off");
  const site = await R.api(B, "POST", "/projects", {
    name: "Site",
    goal: "The team's site",
    repos: ["team/shared"],
  });
  console.log("bob made", site.id ?? site);
  cut(B, "on");
  for (const t of ["Write the home page", "Write the contact page"])
    await R.api(B, "POST", `/projects/${site.id}/tasks`, {
      title: t,
      outcome: `${t} is done`,
      riskTier: 1,
      specialist: "coder",
    }).catch((e) => console.log("task", e.message));
  fs.writeFileSync(
    `/tmp/frbench/${A}/steps/${label}-ids.json`,
    JSON.stringify({ made: made.id, site: site.id }),
  );
  // Bob's copy follows the default branch (the watcher's poll): wait for the line.
  const end = Date.now() + 120_000;
  let line = null;
  while (Date.now() < end) {
    line = (await R.api(B, "GET", `/projects/${site.id}`)).repositoryElsewhere ?? null;
    if (line) break;
    await wait(3000);
  }
  console.log("bob line", JSON.stringify(line));
  const writesBefore = (await github("GET", "/repos/team/shared/pulls?state=all")).map((p) => [
    p.number,
    p.head.ref,
    p.state,
    p.user.login,
  ]);
  const two = await R.openTwo(A, B);
  try {
    const bob = two.b.page;
    await bob.goto(`${R.bench(B).uiUrl}/projects/${site.id}/summary`, {
      waitUntil: "domcontentloaded",
    });
    await bob.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await R.skipSetup(bob).catch(() => undefined);
    const over = await R.step(bob, `${label}-bob-site-work-together`, { settleMs: 4000 });
    console.log("BOB OVERVIEW:", over.slice(over.indexOf("On GitHub"), over.indexOf("On GitHub") + 700));
    await bob.getByTestId("repository-work-together").click();
    await bob.getByTestId("join-together-confirm").waitFor({ timeout: 15000 });
    const dialog = await R.step(bob, `${label}-bob-work-together-dialog`, { settleMs: 2000 });
    const at = dialog.indexOf("Work together");
    console.log("DIALOG:", dialog.slice(at, at + 900));
    await bob.getByTestId("join-together-confirm").click();
    await wait(4000);
    const joined = await R.step(bob, `${label}-bob-after-join`, { settleMs: 3000 });
    console.log("AFTER JOIN:", joined.slice(0, 900));
    const projects = await R.api(B, "GET", "/projects");
    console.log(
      "bob projects",
      JSON.stringify(projects.map((p) => [p.name, p.id === made.id ? "repository id" : p.id])),
    );
    const writesAfter = (await github("GET", "/repos/team/shared/pulls?state=all")).map((p) => [
      p.number,
      p.head.ref,
      p.state,
      p.user.login,
    ]);
    console.log("pulls before", JSON.stringify(writesBefore));
    console.log("pulls after ", JSON.stringify(writesAfter));

    // Add to it on Ada's project, through the route the dialog now uses.
    const t0 = Date.now();
    const r = await R.apiRaw(A, "POST", `/projects/${made.id}/intake`, {
      brief: "Add a contact form page with a short thank-you note after sending",
      background: true,
    });
    const ms = Date.now() - t0;
    console.log("add-to answered after ms", ms, "status", r.status, JSON.stringify(r.body).slice(0, 200));
    const ada = two.a.page;
    await ada.goto(`${R.bench(A).uiUrl}/projects/${made.id}/summary`, {
      waitUntil: "domcontentloaded",
    });
    await R.skipSetup(ada).catch(() => undefined);
    const drafting = await R.step(ada, `${label}-ada-add-to-drafting`, { settleMs: 200 });
    console.log("ADA PAGE has drafting line:", /Drafting the plan/.test(drafting));
    fs.writeFileSync(
      `/tmp/frbench/${A}/steps/${label}-add-to-timing.txt`,
      `AFTER (w8-together): POST /projects/:id/intake with background answered ${r.status} after ${ms} ms with state ${r.body?.state}; the page showed "Drafting the plan" at once: ${/Drafting the plan/.test(drafting)}.\n`,
    );
    await wait(6000);
    await R.step(ada, `${label}-ada-plan-waits`, { settleMs: 2000 });
  } finally {
    await two.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
