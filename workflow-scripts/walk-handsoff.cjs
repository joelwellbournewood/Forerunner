// AFTER walk: Make ready with "When work is ready" off (nothing starts, the line says so), then on
// (one session starts by itself), with screenshots of the Tasks tab and Settings.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_415a6fe9-606-1/scripts/bench/recorder.cjs");
const n = "fix-d1109-starts-engine";
const ui = () => require(`/tmp/frbench/${n}/bench.json`).uiUrl;
(async () => {
  const p = await R.api(n, "POST", "/projects", { name: "Hands off after", goal: "A page" });
  const pid = p.id;
  const draft = async (title) =>
    R.api(n, "POST", `/projects/${pid}/tasks`, {
      title,
      outcome: `${title} done`,
      acceptanceCriteria: [],
      specialist: "writer",
      status: "draft",
    });
  const sessions = async () => {
    const all = await R.api(n, "GET", "/sessions");
    return (all.sessions ?? all).filter((x) => x.projectId === pid);
  };
  const a = await draft("Write the intro in intro.md");
  const offLine = await R.api(n, "POST", `/tasks/${a.id}/action`, { version: a.version, action: "make_ready" });
  console.log(JSON.stringify({ off: offLine.change?.sentence, sessions: (await sessions()).length }));
  const { browser, page } = await R.openApp(n);
  await page.waitForTimeout(1500);
  await page.goto(`${ui()}/projects/${pid}/tasks`).catch(() => undefined);
  await page.waitForTimeout(2500);
  await R.step(page, "after-handsoff-off-tasks");
  // Settings: the project's "When work is ready", as the screen sends it (a yes).
  const asked = await R.api(n, "POST", "/commands/execute", {
    commands: [{ name: "settings.set", params: { key: "start_by_itself", value: true, project: pid } }],
    source: "ui",
  });
  const yes = await R.api(n, "POST", `/commands/${asked.pendingId}/confirm`, { answer: "yes" });
  console.log(JSON.stringify({ asked: asked.status, readback: asked.card?.ask ?? asked.readback ?? null, yes: yes.status }));
  await page.goto(`${ui()}/settings`).catch(() => undefined);
  await page.waitForTimeout(2500);
  await R.step(page, "after-handsoff-settings");
  const b = await draft("Write the outro in outro.md");
  const onLine = await R.api(n, "POST", `/tasks/${b.id}/action`, { version: b.version, action: "make_ready" });
  await page.waitForTimeout(4000);
  const all = await sessions();
  console.log(JSON.stringify({ on: onLine.change?.sentence, sessions: all.length, how: all.map((s) => [s.trigger, s.status]) }));
  for (const s of all) if (s.id) await R.waitForSession(n, s.id).catch(() => undefined);
  await page.goto(`${ui()}/projects/${pid}/sessions`).catch(() => undefined);
  await page.waitForTimeout(2500);
  await R.step(page, "after-handsoff-sessions");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
