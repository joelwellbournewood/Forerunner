import { devices, expect, test } from "@playwright/test";
import {
  fakeState,
  injectAndroidShell,
  pairPhone,
  resetState,
  stateCalls,
} from "./mobile-helpers.ts";

test.use({ ...devices["Pixel 7"] });

test.beforeEach(async ({ page, request }) => {
  await resetState(request);
  await injectAndroidShell(page);
});

const SENTENCE =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";

test("scenario 9: one sentence, one change card, confirm, the PC starts, the change log shows it with undo", async ({
  page,
  request,
}) => {
  await pairPhone(page, request);
  await page.getByTestId("m-nav").getByText("Remote").click();
  await expect(page.getByTestId("m-remote-active")).toHaveText("PharmaWatch");
  await page.getByTestId("m-say").fill(SENTENCE);
  await page.getByTestId("m-say-submit").click();

  // ONE card for the combined request, three parts, nothing sent yet.
  const card = page.getByTestId("m-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-parts", "3");
  await expect(card).toHaveAttribute("data-risk", "medium");
  await expect(page.getByTestId("m-card-text")).toContainText("Plan of 3 changes:");
  await expect(page.getByTestId("m-card-text")).toContainText(
    "the active project: PharmaWatch to Space game.",
  );
  await expect(page.getByTestId("m-card-text")).toContainText(
    "tonight's session budget for Space game: the current budget to CHF 15, until 06:00.",
  );
  await expect(page.getByTestId("m-card-text")).toContainText(
    "a session on Space game on your PC: no session to running.",
  );
  expect((await stateCalls(request)).filter((c) => c.path === "/remote/commands")).toHaveLength(0);

  await page.getByTestId("m-confirm").click();
  await expect(page.getByTestId("m-card")).toHaveCount(0);
  await expect(page.getByTestId("m-remote-active")).toHaveText("Space game");

  // The fake service recorded ONE signed remote command carrying the three commands.
  const sent = (await stateCalls(request)).filter((c) => c.path === "/remote/commands");
  expect(sent).toHaveLength(1);
  const body = sent[0]?.body as {
    target: string;
    command: string;
    params: {
      kind: string;
      wordsUsed: string;
      plan: { name: string; params: Record<string, unknown> }[];
    };
  };
  expect(sent[0]?.signed).toBe(true);
  expect(body.target).toBe("pc");
  expect(body.command).toBe("start");
  expect(body.params.kind).toBe("plan");
  expect(body.params.wordsUsed).toBe(SENTENCE);
  expect(body.params.plan.map((c) => c.name)).toEqual([
    "project.switch",
    "budget.set",
    "session.start",
  ]);
  expect(body.params.plan[1]?.params).toMatchObject({
    scope: "session",
    amountChf: 15,
    project: "proj_game",
  });
  expect(body.params.plan[2]?.params).toEqual({ project: "proj_game", runner: "pc" });

  // The (simulated) PC picks it up, runs it and starts the session.
  await expect(page.getByTestId("m-result")).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("m-result-detail")).toContainText(
    '"executed":["project.switch","budget.set","session.start"]',
  );
  await expect(page.getByTestId("m-session")).toHaveCount(1);
  const started = await fakeState(request);
  expect(started.sessions).toHaveLength(1);
  expect(started.sessions[0]).toMatchObject({ status: "running", projectId: "proj_game" });
  expect(started.remoteCommands[0]?.status).toBe("done");

  // The change log shows it with undo; undo sends the inverse plan and marks the entry undone.
  await page.getByRole("link", { name: "Change log" }).click();
  const entry = page.getByTestId("m-change-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveAttribute("data-status", "done");
  await expect(entry).toContainText(`J said: “${SENTENCE}”`);
  await expect(entry).toContainText("Commands: project.switch, budget.set, session.start");
  const originalId = await entry.getAttribute("data-entry-id");
  await entry.getByTestId("m-change-undo").click();
  await expect(page.getByTestId("m-change-entry")).toHaveCount(2);
  // Newest first: the undo entry is on top; the original is marked undone and loses its button.
  const original = page.locator(`[data-entry-id="${originalId}"]`);
  await expect(original).toHaveAttribute("data-status", "undone");
  await expect(original.getByTestId("m-change-undo")).toHaveCount(0);
  await expect(page.getByTestId("m-change-entry").first()).toContainText(`undo: ${SENTENCE}`);
  const all = (await stateCalls(request)).filter((c) => c.path === "/remote/commands");
  expect(all).toHaveLength(2);
  const undo = all[1]?.body as { params: { undoOf?: string; plan: { name: string }[] } };
  expect(undo.params.undoOf).toBeTruthy();
  expect(undo.params.plan.map((c) => c.name)).toEqual([
    "session.stop",
    "budget.set",
    "project.switch",
  ]);
  await expect
    .poll(async () => (await fakeState(request)).sessions[0]?.status, { timeout: 15_000 })
    .toBe("killed");
});

test("the controls build the same plan and the question path asks which project", async ({
  page,
  request,
}) => {
  await pairPhone(page, request);
  await page.goto("/m/remote");
  await page.getByTestId("m-controls").locator("summary").click();
  await page.getByTestId("m-switch").selectOption("proj_game");
  await page.getByTestId("m-amount").fill("15");
  await page.getByTestId("m-until").selectOption("tomorrow");
  await page.getByTestId("m-start-session").check();
  await page.getByTestId("m-preview").click();
  await expect(page.getByTestId("m-card")).toHaveAttribute("data-parts", "3");
  await page.getByTestId("m-cancel").click();
  await page.getByTestId("m-say").fill("switch to the moon base");
  await page.getByTestId("m-say-submit").click();
  await expect(page.getByTestId("m-question")).toContainText('No project named "moon base"');
  expect((await stateCalls(request)).filter((c) => c.path === "/remote/commands")).toHaveLength(0);
});
