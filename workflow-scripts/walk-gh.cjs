// Walk of the github-result journeys on bench fix-github-result (stand-in model + fake GitHub).
// node walk-gh.cjs <phase>   phase: before | after
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const REPO = process.env.REPO_DIR;
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const N = "fix-github-result";
const phase = process.argv[2] || "before";

async function makeProject(repo, label) {
  const created = await R.api(N, "POST", "/projects", {
    name: `${label} ${phase}`,
    goal: "A small web page that shows a random quote",
    brief: "A page that shows a random quote each time it loads.",
    repos: repo ? [repo] : [],
    intake: true,
  });
  const id = created.id;
  const pending = await R.until(
    async () => {
      const s = await R.api(N, "GET", `/projects/${id}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    90_000,
    1000,
    "plan",
  );
  return { id, pending };
}

async function approveInUi(page, id) {
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  const btn = page.getByRole("button", { name: "Approve and start" }).first();
  await btn.click();
  await page.waitForTimeout(1500);
}

async function waitSessionsEnd(id, ms = 240_000) {
  await R.until(
    async () => {
      const sessions = await R.api(N, "GET", `/sessions?projectId=${id}`).catch(() => null);
      const list = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? []);
      if (!list.length) return null;
      return list.every((s) => s.status !== "running" && s.status !== "queued") ? list : null;
    },
    ms,
    2000,
    "sessions end",
  );
}

function hostGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: phase === "before" });
  await page.goto(R.bench(N).uiUrl);
  await page.waitForTimeout(1500);
  await R.skipSetup(page).catch(() => {});
  const out = {};
  for (const [repo, label] of [
    ["bench/empty", "Empty repo"],
    ["bench/seeded", "Seeded repo"],
    [null, "Folder"],
  ]) {
    const { id } = await makeProject(repo, label);
    out[label] = { id };
    await approveInUi(page, id);
    await R.step(page, `${label}-inbox-after-approve`);
    await waitSessionsEnd(id);
    const tasks = await R.api(N, "GET", `/projects/${id}/tasks`);
    out[label].tasks = tasks.map((t) => ({
      title: t.title,
      status: t.status,
      prUrl: t.prUrl ?? null,
      branch: t.branch ?? null,
      reason: t.reason ?? null,
    }));
    await page.goto(`${R.bench(N).uiUrl}/projects/${id}`);
    await page.waitForTimeout(2000);
    await R.step(page, `${label}-overview`);
    await page.goto(`${R.bench(N).uiUrl}/projects/${id}/tasks`);
    await page.waitForTimeout(2000);
    await R.step(page, `${label}-tasks`);
    await page.goto(`${R.bench(N).uiUrl}/projects/${id}/docs`);
    await page.waitForTimeout(2000);
    await R.step(page, `${label}-docs`);
    const sessions = await R.api(N, "GET", `/sessions?projectId=${id}`).catch(() => []);
    const list = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? []);
    if (list[0]) {
      await page.goto(`${R.bench(N).uiUrl}/sessions/${list[0].id}`);
      await page.waitForTimeout(2000);
      await R.step(page, `${label}-session`);
    }
    out[label].summary = await R.api(N, "GET", `/projects/${id}/summary`).catch((e) => String(e));
    out[label].pullRequests = await R.api(N, "GET", `/projects/${id}/pull-requests`).catch((e) =>
      String(e),
    );
    // Chat: "where are my files?" (the stand-in says what context it was given).
    await page.goto(`${R.bench(N).uiUrl}/projects/${id}/chat`);
    await page.waitForTimeout(1500);
    try {
      await page.getByTestId("chat-input").fill("where are my files?");
      await page.getByTestId("chat-send").click();
      await page.waitForTimeout(4000);
      await R.step(page, `${label}-chat`);
      const calls = R.modelCalls(N, "chat");
      const last = calls.at(-1);
      const content = JSON.stringify(last?.messages ?? []);
      const at = content.indexOf("# Your files");
      out[label].chatFiles = at >= 0 ? content.slice(at, at + 600) : "(no # Your files block)";
    } catch (e) {
      out[label].chatFiles = `chat step failed: ${String(e).slice(0, 200)}`;
    }
  }
  await page.goto(`${R.bench(N).uiUrl}/changes`);
  await page.waitForTimeout(2000);
  await R.step(page, "changes");
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  await R.step(page, "inbox");
  // The repositories on the stand-in host: branches and what each PR branch holds.
  const root = path.join("/tmp/frbench", N, "githost");
  for (const name of ["empty", "seeded"]) {
    const bare = path.join(root, "bench", `${name}.git`);
    try {
      out[`host:${name}:branches`] = hostGit(["--git-dir", bare, "branch", "-a"]);
      out[`host:${name}:log`] = hostGit(["--git-dir", bare, "log", "--all", "--oneline", "--name-status", "-n", "40"]);
    } catch (e) {
      out[`host:${name}`] = String(e.message).slice(0, 400);
    }
  }
  const folder = out.Folder?.id ? R.workspaceOf(N, out.Folder.id) : null;
  if (folder) {
    try {
      out["folder:status"] = hostGit(["-C", folder, "status", "--short"]);
      out["folder:log"] = hostGit(["-C", folder, "log", "--oneline", "-n", "20"]);
    } catch (e) {
      out["folder"] = String(e.message).slice(0, 400);
    }
  }
  fs.writeFileSync(path.join("/tmp/frbench", N, `walk-${phase}.json`), JSON.stringify(out, null, 2));
  await browser.close();
  console.log(JSON.stringify(out, null, 2).slice(0, 6000));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
