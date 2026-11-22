// After walk A: answer the questions card in the Inbox and see the task go on.
// node walk-a-answer.cjs <bench> <tag> <projectId>
const { R, benchOf, settle, openCards } = require("./walk-common.cjs");
const [name, tag, projectId] = process.argv.slice(2);

(async () => {
  const b = benchOf(name);
  const { browser, page } = await R.openApp(name);
  await R.skipSetup(page);
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForTimeout(1200);
  const fields = page.locator("textarea");
  await fields.nth(0).fill("Bern Garden Club");
  await fields.nth(1).fill("Keep the meeting time as it is.");
  await R.step(page, `${tag}-answers-typed`, { waitMs: 300 });
  await page.getByRole("button", { name: "Send answers", exact: true }).first().click();
  await page.waitForTimeout(1500);
  await R.step(page, `${tag}-answers-sent`, { waitMs: 300 });
  await new Promise((r) => setTimeout(r, 2000));
  await settle(name, projectId, 180_000);
  await page.goto(`${b.uiUrl}/projects/${projectId}/tasks`);
  await R.step(page, `${tag}-tasks-after-answers`, { waitMs: 1500 });
  await browser.close();
  const calls = R.modelCalls(name, "specialist").filter((c) => String(c.label).includes("Home page"));
  const last = calls.at(-1);
  const first = calls.find((c) => c.runId === last?.runId);
  const brief = JSON.stringify(first?.messages?.[0]?.content ?? "");
  console.log(
    JSON.stringify(
      {
        briefHasAnswers: brief.includes("Answers from the person") && brief.includes("Bern Garden Club"),
        lastReportAsks: /Questions for the person/.test(last?.reply?.text ?? ""),
        openCards: (await openCards(name, projectId)).length,
        tasks: (await R.api(name, "GET", `/projects/${projectId}/tasks`)).map((t) => [
          t.title,
          t.status,
        ]),
      },
      null,
      1,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
