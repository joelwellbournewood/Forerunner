// Review walk 4 (L4i-left-8): a take-over made with a brief; GitHub cut for Ada when she approves
// the plan; the Overview's no-pull-request line with Try again, after a restart too; Try again opens it.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const A = "review-w8-repo-guide";
const WT = "/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7";
const GH = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
const OLD2 = "01a1b000-0000-7000-8000-0000000002d0";
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
  if (res.status >= 400) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const put = (path, text) =>
  gh("ada", "PUT", `/repos/team/club/contents/${path}`, {
    message: "seed",
    content: Buffer.from(text).toString("base64"),
    branch: "main",
  });
const cut = (state) =>
  execFileSync("node", [`${WT}/scripts/bench/cut.mjs`, A, "github", state], { stdio: "inherit" });
const up = () =>
  R.until(
    async () => {
      try {
        return (await R.apiRaw(A, "GET", "/health")).status === 200;
      } catch {
        return false;
      }
    },
    90_000,
    1000,
    "daemon up",
  );

(async () => {
  await gh("ada", "POST", "/orgs/team/repos", { name: "club", private: true });
  await put("README.md", "# club\n");
  await put(
    ".forerunner/project.json",
    `${JSON.stringify({ schema: 1, project: OLD2, name: "Club page" }, null, 2)}\n`,
  );
  const made = await R.api(A, "POST", "/projects", {
    name: "Club page again",
    goal: "The club page, kept going",
    repos: ["team/club"],
    switch: true,
    takeOver: { projects: [OLD2] },
    brief: "A one-page site for the club: plain HTML and CSS.",
    intake: true,
  });
  const id = made.id;
  const pending = await R.until(
    async () => {
      const s = await R.api(A, "GET", `/projects/${id}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    120_000,
    1000,
    "the plan",
  );
  const inbox = await R.api(A, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.id === pending.requestId);
  cut("off");
  const ans = await R.apiRaw(A, "POST", `/requests/${card.id}/answer`, {
    version: card.version,
    answer: "Approve and start",
  });
  console.log("approve:", ans.status, JSON.stringify(ans.body).slice(0, 300));
  await new Promise((r) => setTimeout(r, 8000));
  cut("on");
  const b = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/bench.json`, "utf8"));
  let app = await R.openApp(A);
  try {
    await app.page.goto(`${b.uiUrl}/projects/${id}`, { waitUntil: "domcontentloaded" });
    await app.page.waitForTimeout(4000);
    const t = await R.step(app.page, "review-l4i8-overview");
    const k = t.indexOf("Took over");
    console.log("---- overview\n", k >= 0 ? t.slice(k, k + 400) : t.slice(0, 2000));
  } finally {
    await app.browser.close();
  }
  console.log("PRs on team/club:", JSON.stringify((await gh("ada", "GET", "/repos/team/club/pulls?state=all")).map((p) => [p.number, p.head.ref, p.state])));
  // Stop any session the approval started, so the restart is clean.
  execFileSync("node", [`${WT}/scripts/bench/restart-daemon.mjs`, "--name", A], { stdio: "inherit" });
  await up();
  const b2 = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/bench.json`, "utf8"));
  app = await R.openApp(A);
  try {
    await app.page.goto(`${b2.uiUrl}/projects/${id}`, { waitUntil: "domcontentloaded" });
    await app.page.waitForTimeout(4000);
    let t = await R.step(app.page, "review-l4i8-overview-after-restart");
    let k = t.indexOf("Took over");
    console.log("---- after restart\n", k >= 0 ? t.slice(k, k + 400) : "(no take-over line)");
    if (k >= 0) {
      await app.page.getByTestId("repository-try-again-button").click();
      await app.page.waitForTimeout(8000);
      t = await R.step(app.page, "review-l4i8-try-again");
      k = t.indexOf("Your files");
      console.log("---- after Try again\n", t.slice(k, k + 1500));
    }
  } finally {
    await app.browser.close();
  }
  console.log("PRs on team/club:", JSON.stringify((await gh("ada", "GET", "/repos/team/club/pulls?state=all")).map((p) => [p.number, p.head.ref, p.state, p.user.login])));
})().catch((e) => {
  console.error(e);
  try {
    cut("on");
  } catch {}
  process.exit(1);
});
