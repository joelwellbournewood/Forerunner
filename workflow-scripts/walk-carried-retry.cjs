// Bench walk for l4-github-carried: Try again on the take-over's no-pull-request line
// (L4e-left-1). bench/empty gets a main naming another Forerunner project (its marker); a
// pre-receive hook refuses every push, so the take-over's docs pull request cannot be opened;
// the Overview says so with Try again; with the hook gone, Try again opens it.
// Usage: node walk-carried-retry.cjs <bench name> <label> <repo root>
const [name, label, repo] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const benchDir = `/tmp/frbench/${name}`;
const bare = `${benchDir}/githost/bench/empty.git`;
const hook = path.join(bare, "hooks", "pre-receive");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const KITE_ID = "01a1a000-0000-7000-8000-00000000c1ab";

(async () => {
  const out = { label, checks: {} };
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "fr-walk-retry-"));
  // main names "Kite club", a project of another computer.
  git("init", "-q", "-b", "main", seed);
  fs.writeFileSync(path.join(seed, "README.md"), "# empty\n");
  fs.mkdirSync(path.join(seed, ".forerunner"));
  fs.writeFileSync(
    path.join(seed, ".forerunner", "project.json"),
    `${JSON.stringify({ schema: 1, project: KITE_ID, name: "Kite club" }, null, 2)}\n`,
  );
  git("-C", seed, "-c", "user.name=Bench", "-c", "user.email=bench@example.test", "add", "-A");
  git("-C", seed, "-c", "user.name=Bench", "-c", "user.email=bench@example.test", "commit", "-q", "-m", "seed");
  git("-C", seed, "push", "-q", bare, "main");
  out.mainBefore = git("--git-dir", bare, "rev-parse", "main");
  fs.writeFileSync(hook, "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 });
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    // The offer first (as New project shows it), then Take it over.
    out.offer = await R.api(name, "POST", "/projects", {
      name: "Kite flyers",
      goal: "Fly kites",
      repos: ["bench/empty"],
    }).catch((e) => String(e));
    const made = await R.api(name, "POST", "/projects", {
      name: "Kite flyers",
      goal: "Fly kites",
      repos: ["bench/empty"],
      switch: true,
      takeOver: { projects: [KITE_ID] },
    });
    out.project = made.id;
    const card = await R.until(
      async () => {
        const c = await R.api(name, "GET", `/projects/${made.id}`);
        return c.repositoryElsewhere?.outcome ? c : null;
      },
      60_000,
      1000,
      "the no-pull-request line",
    );
    out.lineBefore = card.repositoryElsewhere;
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/projects/${made.id}/summary`);
    await page.waitForSelector('[data-testid="repository-try-again-button"]', { timeout: 30_000 });
    out.overviewLine = (await R.step(page, `${label}-1-overview-try-again`)).slice(0, 2000);
    // GitHub still refuses: the refusal shows beside the button, the line stays.
    await page.click('[data-testid="repository-try-again-button"]');
    await page.waitForSelector('[data-testid="repository-try-again-refused"]', { timeout: 30_000 });
    out.overviewRefused = (await R.step(page, `${label}-2-overview-still-refused`)).slice(0, 2000);
    await page.goto(`${ui}/projects/${made.id}/docs`);
    await page.waitForSelector('[data-testid="docs-try-again-button"]', { timeout: 30_000 });
    out.docsLine = (await R.step(page, `${label}-3-docs-try-again`)).slice(0, 2000);
    // The push works again: Try again opens the docs pull request.
    fs.rmSync(hook);
    await page.goto(`${ui}/projects/${made.id}/summary`);
    await page.waitForSelector('[data-testid="repository-try-again-button"]', { timeout: 30_000 });
    await page.click('[data-testid="repository-try-again-button"]');
    await page.waitForSelector('[data-testid="repository-try-again-opened"]', { timeout: 60_000 });
    out.overviewOpened = (await R.step(page, `${label}-4-overview-opened`)).slice(0, 2000);
    const after = await R.api(name, "GET", `/projects/${made.id}`);
    out.lineAfter = after.repositoryElsewhere ?? null;
    out.refs = git("--git-dir", bare, "for-each-ref", "--format=%(refname)").split("\n");
    out.mainAfter = git("--git-dir", bare, "rev-parse", "main");
    out.checks.lineHadTryAgain = out.lineBefore?.outcome === "took_over_no_pull_request";
    out.checks.lineGone = out.lineAfter === null;
    out.checks.mainUntouched = out.mainAfter === out.mainBefore;
    out.checks.ownBranch = out.refs.some((r) => r.startsWith("refs/heads/fr/docs-scaffold"));
  } catch (e) {
    out.error = String(e?.stack ?? e);
  } finally {
    if (fs.existsSync(hook)) fs.rmSync(hook);
    fs.rmSync(seed, { recursive: true, force: true });
    fs.writeFileSync(`${benchDir}/steps/${label}-retry.json`, JSON.stringify(out, null, 2));
    await browser.close();
    console.log(JSON.stringify(out.checks), out.error ?? "");
  }
})();
