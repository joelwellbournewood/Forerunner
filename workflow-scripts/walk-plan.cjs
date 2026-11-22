// Person-level walk for the credential-limits fixup: a refused key met by planning first.
"use strict";
const R = require(process.argv[2] + "/scripts/bench/recorder.cjs");
const NAME = "fixup-credential-limits";
const out = (s) => console.log(`[walk] ${s}`);
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

async function main() {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/`);
    await page.waitForTimeout(1500);
    // New project with a one-line brief, as a person.
    await page.getByTestId("new-project").first().click();
    const dialog = page.getByTestId("new-project-dialog");
    await dialog.locator('input[name="name"]').fill("Quote page");
    await dialog.locator('textarea[name="brief"]').fill("A page that shows a random quote.");
    await dialog.getByTestId("create-project").click();
    await page.waitForURL(/\/projects\//, { timeout: 15000 });
    const projectId = decodeURIComponent(page.url().split("/projects/")[1].split("/")[0]);
    out(`project ${projectId}`);
    const banner = page.getByTestId("intake-banner");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="intake-banner"]')?.getAttribute("data-state") === "waiting",
      null,
      { timeout: 60000 },
    ).catch(() => undefined);
    const state1 = await banner.getAttribute("data-state").catch(() => null);
    const text1 = await banner.innerText().catch(() => "");
    await R.step(page, "plan-refused project page");
    check("the project page says planning waits for a new key", state1 === "waiting", `${state1}: ${text1}`);
    check("no Try again on the banner", (await banner.getByTestId("intake-retry").count()) === 0);
    // Home: the project's status sentence.
    await page.goto(`${b.uiUrl}/`);
    await page.waitForTimeout(2000);
    const home = await R.step(page, "plan-refused home");
    check("Home says Planning waits for a new API key", /Planning waits for a new API key/.test(home));
    // Inbox: one card.
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2000);
    const inbox = await R.step(page, "plan-refused inbox");
    const cards = page.getByTestId("request").filter({ hasText: "Anthropic refused your API key" });
    check("one refused card", (await cards.count()) === 1);
    // The Start dialog on the project.
    await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(projectId)}`);
    await page.waitForTimeout(1500);
    const start = page.getByTestId("start-session");
    if (await start.count()) {
      await start.first().click();
      await page.waitForTimeout(1500);
      const blocked = await page.getByTestId("start-session-blocked").innerText().catch(() => "");
      await R.step(page, "plan-refused start dialog");
      check("the Start dialog names the planning wait", /Planning waits for a new API key/.test(blocked), blocked);
      await page.keyboard.press("Escape");
    }
    // Quit and reopen (the daemon restarts): the wait is kept.
    require("node:child_process").execSync(
      `node ${process.argv[2]}/scripts/bench/restart-daemon.mjs --name ${NAME}`,
      { stdio: "inherit" },
    );
    await R.reconnect(page, NAME);
    await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(projectId)}`);
    await page.waitForTimeout(2500);
    const state1b = await banner.getAttribute("data-state").catch(() => null);
    await R.step(page, "plan-refused after restart");
    check("after a restart the plan still waits", state1b === "waiting", String(state1b));
    // The card's link: the setup assistant.
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(1500);
    await cards.first().getByTestId("option-link").click();
    await page.waitForTimeout(1500);
    await R.step(page, "setup assistant from the card");
    const nameBox = page.getByTestId("setup-name");
    if (await nameBox.count()) {
      if (!(await nameBox.inputValue())) await nameBox.fill("Bench");
      await page.getByTestId("setup-next").first().click();
      await page.waitForTimeout(1500);
    }
    const key = `sk-ant-api03-bench-ok-${require("node:crypto").randomBytes(24).toString("hex")}`;
    await page.getByTestId("setup-anthropic-input").fill(key);
    await page.getByTestId("setup-anthropic-check").click();
    await page.waitForTimeout(3000);
    const saved = await R.step(page, "setup assistant key saved");
    check("the key is saved", /Key works|works/i.test(saved));
    // Back to the project: the plan is drafted by itself.
    await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(projectId)}`);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="intake-banner"]')?.getAttribute("data-state") === "pending",
      null,
      { timeout: 120000 },
    ).catch(() => undefined);
    const state2 = await banner.getAttribute("data-state").catch(() => null);
    await R.step(page, "plan drafted after the key");
    check("the plan was drafted by itself", state2 === "pending", String(state2));
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2000);
    const inbox2 = await R.step(page, "inbox after the key");
    check("the refused card is answered", /A new one is saved; the work that waited for it goes on\./.test(inbox2));
    const plan = page.getByTestId("request").filter({ hasText: "Plan for" });
    if (await plan.count()) {
      await plan.first().getByRole("button", { name: "Approve and start", exact: true }).click();
      await page.waitForTimeout(2500);
      await R.step(page, "inbox after approve");
      const done = await R.until(
        async () => {
          const t = await R.api(NAME, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`);
          return t.length && t.every((x) => x.status === "done") ? t : null;
        },
        300000,
        3000,
        "the plan's tasks to finish",
      ).catch(() => null);
      check("the plan's tasks finished", !!done, done ? done.map((t) => t.title).join(", ") : "");
      await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(projectId)}/tasks`);
      await page.waitForTimeout(2500);
      await R.step(page, "tasks done after approve");
    } else check("the plan card is in the Inbox", false);
  } finally {
    await browser.close();
  }
  require("node:fs").writeFileSync(
    `${b.steps}/walk-plan.json`,
    JSON.stringify({ checks }, null, 2),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
