import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("a settings change runs a command, shows the card, needs a yes, and lands in the change log with undo", async ({
  page,
  request,
}) => {
  await page.goto("/settings");
  const row = page.getByTestId("setting-row").filter({ hasText: "project.autonomy" });
  await row.getByTestId("setting-change").click();
  const dialog = page.getByTestId("setting-dialog");
  await dialog.getByTestId("setting-value").fill("3");
  await dialog.getByTestId("setting-apply").click();
  await expect(dialog.getByTestId("command-pending")).toHaveAttribute("data-decision", "needs_yes");
  await expect(dialog.getByTestId("card-new")).toHaveText("3");
  await dialog.getByTestId("command-yes").click();
  await expect(dialog.getByTestId("command-sentence")).toHaveText(
    "Set autonomy for Atlas from 2 to 3. Undo.",
  );
  await dialog.getByTestId("command-close").click();
  await expect(row.getByTestId("setting-value-cell")).toHaveText("3");

  await page.getByTestId("main-nav").getByText("Changes").click();
  await expect(page.getByTestId("change").first().getByTestId("change-sentence")).toHaveText(
    "Set autonomy for Atlas from 2 to 3. Undo.",
  );
  await expect(page.getByTestId("change").first().getByTestId("change-words")).toContainText(
    "Settings: project.autonomy to 3",
  );
  await page.getByTestId("change").first().getByTestId("change-undo").click();
  await expect(page.getByTestId("changes-note")).toContainText(
    "Undone: Set autonomy for Atlas from 2 to 3.",
  );
  await expect(page.getByTestId("change").first()).toHaveAttribute(
    "data-undo-state",
    "irreversible",
  );
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/commands/execute")?.body).toEqual({
    commands: [{ name: "autonomy.set", params: { level: 3, project: "proj_atlas" } }],
    wordsUsed: "Settings: project.autonomy to 3",
    projectId: "proj_atlas",
    source: "ui",
  });
  expect(calls.find((c) => /\/commands\/pend_\d+\/confirm$/.test(c.path))?.body).toEqual({
    answer: "tap",
  });
  expect(calls.some((c) => /\/changes\/chg_\d+\/undo$/.test(c.path))).toBe(true);
});
