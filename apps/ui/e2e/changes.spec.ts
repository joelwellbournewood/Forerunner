import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("a settings change runs a command, shows the card, needs a yes, and lands in the change log with undo", async ({
  page,
  request,
}) => {
  await page.goto("/settings");
  // Each project's autonomy is under Advanced (design §6: Settings opens on Basics).
  await page.getByTestId("settings-advanced-summary").click();
  // The row shows its plain label (U-060); the key stays on the row for tests.
  // Atlas's row: the daemon lists every project's autonomy (settings-view.ts).
  const row = page
    .locator('[data-testid="setting-row"][data-key="project.autonomy"]')
    .filter({ has: page.getByTestId("setting-scope").getByText("Atlas", { exact: true }) });
  await expect(row.getByTestId("setting-label")).toHaveText("Autonomy");
  await row.getByTestId("setting-change").click();
  const dialog = page.getByTestId("setting-dialog");
  // By name (design §2, §6: one named autonomy control); the level is the command's value.
  await dialog.getByTestId("setting-value").selectOption("3");
  await dialog.getByTestId("setting-apply").click();
  await expect(dialog.getByTestId("command-pending")).toHaveAttribute("data-decision", "needs_yes");
  await expect(dialog.getByTestId("card-new")).toHaveText("3");
  await dialog.getByTestId("command-yes").click();
  // The spoken "Undo." is the dialog's Undo button in the app (U-074).
  await expect(dialog.getByTestId("command-sentence")).toHaveText(
    "Set autonomy for Atlas from 2 to 3.",
  );
  await expect(dialog.getByTestId("command-undo")).toBeVisible();
  await dialog.getByTestId("command-close").click();
  await expect(row.getByTestId("setting-value-cell")).toHaveText(
    "Trusted: also merges reviewed pull requests",
  );

  // Changes is behind More (design §6).
  await page.getByTestId("main-nav").getByTestId("more-nav").click();
  await page.getByRole("menuitem", { name: "Changes" }).click();
  // Never "Undo." as text beside the Undo button, and a click in Settings is nothing anyone said
  // (design §5 rule 6, later #90): no "Said:" line.
  await expect(page.getByTestId("change").first().getByTestId("change-sentence")).toHaveText(
    "Set autonomy for Atlas from 2 to 3.",
  );
  await expect(page.getByTestId("change").first().getByTestId("change-words")).toHaveCount(0);
  await expect(page.getByTestId("change").first().getByTestId("change-undo-state")).toHaveText(
    "Can be undone",
  );
  await page.getByTestId("change").first().getByTestId("change-undo").click();
  await expect(page.getByTestId("changes-note")).toContainText(
    "Undone: Set autonomy for Atlas from 2 to 3.",
  );
  await expect(page.getByTestId("change").first()).toHaveAttribute(
    "data-undo-state",
    "irreversible",
  );
  // The Undo's own row has no badge: "Cannot be undone" with no reason read like a refusal.
  await expect(page.getByTestId("change").first().getByTestId("change-undo-state")).toHaveCount(0);
  await expect(page.getByTestId("change").nth(1).getByTestId("change-undo-state")).toHaveText(
    "Undone",
  );
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/commands/execute")?.body).toEqual({
    commands: [{ name: "autonomy.set", params: { level: 3, project: "proj_atlas" } }],
    wordsUsed: "Settings: Autonomy to 3",
    projectId: "proj_atlas",
    source: "ui",
  });
  expect(calls.find((c) => /\/commands\/pend_\d+\/confirm$/.test(c.path))?.body).toEqual({
    answer: "tap",
  });
  expect(calls.some((c) => /\/changes\/chg_\d+\/undo$/.test(c.path))).toBe(true);
});
