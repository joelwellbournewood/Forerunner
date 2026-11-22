// After walk D: answer the bakery's content card and see the build run with the answers.
// node walk-d-answer.cjs <bench> <tag> <projectId>
const { R, benchOf, settle } = require("./walk-common.cjs");
const [name, tag, projectId] = process.argv.slice(2);

(async () => {
  const b = benchOf(name);
  const { browser, page } = await R.openApp(name);
  await R.skipSetup(page);
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForTimeout(1200);
  const card = page.locator("article, section, div").filter({ hasText: "Give the real menu, hours and address\" needs your answers" }).last();
  const fields = card.locator("textarea");
  await fields.nth(0).fill("Zopf CHF 6, Nussgipfel CHF 3.20, Bauernbrot CHF 7");
  await fields.nth(1).fill("Tue-Sat 7:00-18:30, Sun 8:00-12:00");
  await fields.nth(2).fill("Kramgasse 12, 3011 Bern");
  await R.step(page, `${tag}-content-typed`, { waitMs: 300 });
  await card.getByRole("button", { name: "Send answers", exact: true }).first().click();
  await page.waitForTimeout(2500);
  await R.step(page, `${tag}-content-sent`, { waitMs: 300 });
  await settle(name, projectId, 240_000);
  await page.goto(`${b.uiUrl}/projects/${projectId}/tasks`);
  await R.step(page, `${tag}-tasks-after-content`, { waitMs: 1500 });
  await browser.close();
  const calls = R.modelCalls(name, "specialist").filter((c) => String(c.label).includes("Build the page"));
  const first = calls[0];
  const brief = JSON.stringify(first?.messages?.[0]?.content ?? "");
  console.log(
    JSON.stringify(
      {
        buildBriefHasAnswers: brief.includes("Answers from the person to") && brief.includes("Kramgasse 12"),
        tasks: (await R.api(name, "GET", `/projects/${projectId}/tasks`)).map((t) => [t.title, t.status]),
      },
      null,
      1,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
