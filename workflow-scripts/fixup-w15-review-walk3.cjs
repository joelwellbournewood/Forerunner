// Fix-up walk 3 (W15-24): what is tried of a command line tool from criteria said in words.
// "Running node hello.js from the command line ..." is tried (as on the base); "node wc.js on a
// file containing ..." is not run bare and is told as not tried.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_442cea1d-150-11/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "fixup-w15-review";
const STEPS = "/tmp/frbench/fixup-w15-review/steps";
const enc = encodeURIComponent;
const out = {};
(async () => {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: "Tools walk",
    goal: "Two small command line tools",
  });
  out.projectId = project.id;
  const create = (title, outcome, criteria) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome,
      acceptanceCriteria: criteria,
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist: "coder",
      riskTier: 1,
    });
  const hello = await create("Write the greeting tool in hello.js", "hello.js prints a greeting", [
    "Running node hello.js from the command line prints a greeting",
  ]);
  const wc = await create("Write the word counter in wc.js", "wc.js counts the words of a file", [
    "node wc.js on a file containing 'a b c' prints 3",
  ]);
  out.tasks = { hello: hello.id, wc: wc.id };
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "tools walk",
  });
  const session = await R.waitForSession(NAME, started.session.id, 300_000);
  out.session = { id: session.id, status: session.status, summary: session.summary };
  out.helloDetail = await R.api(NAME, "GET", `/tasks/${enc(hello.id)}`);
  out.wcDetail = await R.api(NAME, "GET", `/tasks/${enc(wc.id)}`);
  const { browser, page } = await R.openApp(NAME);
  try {
    for (const [t, label] of [
      [hello, "hello"],
      [wc, "wc"],
    ]) {
      await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks?task=${enc(t.id)}`);
      await page.waitForTimeout(2500);
      const checked = page.getByText("See what was checked").first();
      if (await checked.count()) await checked.click().catch(() => undefined);
      await page.waitForTimeout(1000);
      out[`${label}Drawer`] = await R.step(page, `w3 ${label} drawer checked`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(`${STEPS}/walk3.json`, JSON.stringify(out, null, 1));
  console.log("done", session.status, session.summary);
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${STEPS}/walk3-error.json`, JSON.stringify({ error: String(e?.stack ?? e), out }, null, 1));
  process.exit(1);
});
