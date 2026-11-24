// Review walk A2: a planned project at Standard; the session's task check splits "Style the page in
// styles.css" by itself (SC-13: the session review's line; the session page's change line).
// Usage: node walkA2.cjs <repo> <bench> <label> <projectName>
const fs = require("node:fs");
const path = require("node:path");
const [repo, n, label, projectName] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { label, checks: {}, texts: {} };

(async () => {
  const created = await R.api(n, "POST", "/projects", {
    name: projectName,
    goal: "A one-page site that shows a random quote",
    brief:
      "Build a one-page website that shows a random quote each time it is opened.\nIt needs an index.html page, a styles.css stylesheet and a script.js that picks the quote.\nAdd a check that the three files work together and a README that says how to open it.\nKeep it small and plain.",
    intake: true,
    autonomyLevel: 2,
  });
  const pid = created.id;
  const pending = await R.until(
    async () => {
      const s = await R.api(n, "GET", `/projects/${pid}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    120_000,
    1000,
    "plan",
  );
  const inbox = await R.api(n, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.id === pending.requestId);
  await R.api(n, "POST", `/requests/${card.id}/answer`, { version: card.version, answer: card.options[0] });
  out.planAnswer = card.options[0];
  // Wait for the project's sessions to end.
  const sid = await R.until(
    async () => {
      const list = await R.api(n, "GET", `/projects/${pid}/sessions`).catch(() => null);
      const rows = Array.isArray(list) ? list : (list?.sessions ?? []);
      return rows[0]?.id ?? null;
    },
    60_000,
    1000,
    "a session",
  );
  out.sessionId = sid;
  await R.waitForSession(n, sid, 600_000);
  await sleep(6000);
  out.tasks = (await R.api(n, "GET", `/projects/${pid}/tasks`)).map((t) => [t.title, t.status]);
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/sessions/${sid}`);
    await sleep(3000);
    out.texts.session = await R.step(page, `${label}-session`);
    const details = page.getByRole("button", { name: "Details" });
    if (await details.count()) {
      await details.first().click().catch(() => {});
      await sleep(1500);
      out.texts.sessionDetails = await R.step(page, `${label}-session-details`);
    }
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/tasks`);
    await sleep(2000);
    out.texts.tasks = await R.step(page, `${label}-tasks`);
  } finally {
    await browser.close();
  }
  const all = `${out.texts.session}\n${out.texts.sessionDetails ?? ""}`;
  out.reviewLines = all.split("\n").filter((l) => /review|replaced|planned|finding|grade|Split|split/i.test(l));
  out.projectId = pid;
  out.problems = R.problems(n).slice(-10);
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tasks: out.tasks, reviewLines: out.reviewLines, sid }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
