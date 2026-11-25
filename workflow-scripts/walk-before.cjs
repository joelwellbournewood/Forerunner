// w8-together BEFORE walk: Bob's "Site" on team/shared, whose marker names Ada's "Team site",
// gets only Take it over on its Overview; Add to waits on "Adding..." with no drafting state.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const REPO = process.env.REPO;
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const A = "fix-w8-together";
const B = "fix-w8-together-bob";
const label = process.argv[2] || "before";
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

(async () => {
  const made = await R.api(A, "POST", "/projects", {
    name: "Team site",
    goal: "A small site for the team",
    repos: ["team/shared"],
  });
  console.log("ada made", made.id ?? made);
  const prs = await github("GET", "/repos/team/shared/pulls?state=all");
  console.log(
    "prs",
    prs.map((p) => [p.number, p.head.ref, p.user.login]),
  );
  const docs = prs.find((p) => p.head.ref.startsWith("fr/docs-scaffold"));
  if (docs) {
    const m = await github("PUT", `/repos/team/shared/pulls/${docs.number}/merge`, {
      merge_method: "squash",
    });
    console.log("merged", m.merged ?? m);
  }
  // Bob's "Site" on the same repository, made while his GitHub API was cut (the one fail-open
  // place): a project here whose repository is another Forerunner's.
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
  // Bob's session end refreshes his copy; nudge it by reading the project a few times.
  await new Promise((r) => setTimeout(r, 2000));
  const two = await R.openTwo(A, B);
  try {
    for (const [side, b, p] of [
      [two.a, R.bench(A), `/projects/${made.id}/summary`],
      [two.b, R.bench(B), `/projects/${site.id}/summary`],
    ]) {
      await side.page.goto(`${b.uiUrl}${p}`, { waitUntil: "domcontentloaded" });
      await side.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
      await R.skipSetup(side.page).catch(() => undefined);
    }
    const bobText = await R.step(two.b.page, `${label}-bob-site-overview`, { settleMs: 4000 });
    console.log("BOB OVERVIEW:", bobText.slice(0, 1500));
    await R.step(two.a.page, `${label}-ada-team-site-overview`, { settleMs: 3000 });
    // Add to: Ada's New project on team/shared with a brief, then Add to it.
    const page = two.a.page;
    await page.goto(`${R.bench(A).uiUrl}/`, { waitUntil: "domcontentloaded" });
    await R.skipSetup(page).catch(() => undefined);
    const card = await R.api(A, "GET", `/projects/${made.id}`);
    console.log("ada line", JSON.stringify(card.repositoryElsewhere ?? null));
    const bobCard = await R.api(B, "GET", `/projects/${site.id}`);
    console.log("bob line", JSON.stringify(bobCard.repositoryElsewhere ?? null));
    fs.writeFileSync(
      `/tmp/frbench/${A}/steps/${label}-ids.json`,
      JSON.stringify({ made: made.id, site: site.id }),
    );
  } finally {
    await two.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
