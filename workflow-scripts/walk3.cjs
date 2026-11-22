// Reviewer's walk 3: clarifying questions in the model's words, and 'add a task to ...' with one
// project only.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-answers";
const UI = "http://127.0.0.1:2591";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-answers/walk3.json";

(async () => {
  const out = { steps: [] };
  const save = (k, v) => {
    out[k] = v;
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  };
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const settle = async (wait = 30_000) => {
    await page.waitForTimeout(900);
    const until = Date.now() + wait;
    while (Date.now() < until) {
      const busy = await page.getByRole("button", { name: "Stop", exact: true }).count();
      if (!busy) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(900);
  };
  const say = async (text) => {
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill(text);
    await box.press("Enter");
    await settle();
  };
  const last = async (id) => {
    const t = (await R.api(N, "GET", `/projects/${id}/conversation`)).turns.at(-1);
    return { human: t?.human?.text, reply: t?.reply?.text, question: t?.reply?.question ?? null };
  };
  try {
    await R.skipSetup(page).catch(() => undefined);
    const notes = await R.api(N, "POST", "/projects", { name: "Notes", goal: "A notes page" });
    await page.goto(`${UI}/projects/${notes.id}/chat`);
    await page.waitForTimeout(2500);
    // One project only: an ordinary 'add a task to ...' line.
    await say("add a task to re-check the prices");
    out.steps.push({ s: await R.step(page, "w3-01-one-project-add-recheck"), r: await last(notes.id) });
    save("steps", out.steps);
    // Clarifying questions in the model's words (the stand-in repeats 'say:' on every call).
    await say("say: Which task should I add the note to?");
    out.steps.push({ s: await R.step(page, "w3-02-which-task-should-i-add"), r: await last(notes.id) });
    save("steps", out.steps);
    await say("say: Add it to Notes or to Site?");
    out.steps.push({ s: await R.step(page, "w3-03-add-it-to-notes-or-site"), r: await last(notes.id) });
    save("steps", out.steps);
    save("calls", R.modelCalls(N, "chat").length);
  } catch (e) {
    save("error", String(e?.stack ?? e));
  } finally {
    save("done", true);
    await browser.close();
  }
})();
