// l4-cred-engine AFTER walk (stand-in Messages API, a refused key): chat's hold reply, chat's
// start, the Start dialog and the Inbox, with screenshots in the bench's steps folder.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_a90568bf-2a3-1/scripts/bench/recorder.cjs");

const NAME = process.argv[2] || "fix-l4-cred-engine";
const LABEL = process.argv[3] || "after";
const enc = encodeURIComponent;
const result = { label: LABEL, checks: [], texts: {} };
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

(async () => {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", {
    name: "Field notes",
    goal: "A short note on the field",
  });
  await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write notes/field.md",
    outcome: "notes/field.md exists with a short note",
    acceptanceCriteria: ["notes/field.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "writer",
    riskTier: 0,
  });
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/chat`);
    const input = page.getByTestId("chat-input");
    await input.waitFor({ timeout: 20_000 });
    const say = async (text, label) => {
      await input.fill(text);
      await page.getByTestId("chat-send").click();
      await page.waitForTimeout(4000);
      const t = await R.step(page, `${LABEL} ${label}`);
      result.texts[label] = t.slice(0, 4000);
      return t;
    };
    const asked = await say("What is next on this project?", "chat question refused key");
    check(
      "chat says what to do with a refused key and promises no start",
      asked.includes(
        "Anthropic refused your API key, so I have not answered. Save a new key in Settings; until then I can still add and change tasks.",
      ) && !asked.includes("add, move and start tasks"),
    );
    const start = await say("start a session", "chat start refused key");
    check(
      "chat's start gets the Start dialog's sentence, no read-back",
      start.includes("Nothing can run until you save a new API key in Settings.") &&
        !/Start a session on Field notes/.test(start),
    );
    const sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`).catch(
      () => [],
    );
    result.sessions = Array.isArray(sessions) ? sessions.length : sessions;
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}`);
    await page.waitForTimeout(2500);
    const startBtn = page.getByRole("button", { name: /^Start/ }).first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click().catch(() => undefined);
      await page.waitForTimeout(2000);
    }
    result.texts.dialog = (await R.step(page, `${LABEL} start dialog refused key`)).slice(0, 4000);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    result.texts.inbox = (await R.step(page, `${LABEL} inbox refused key`)).slice(0, 4000);
  } finally {
    await browser.close();
  }
  const file = path.join(path.dirname(R.bench(NAME).logs.daemon), "steps", `${LABEL}-l4.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`result: ${file}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
