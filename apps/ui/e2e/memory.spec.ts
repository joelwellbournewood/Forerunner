import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("memory: views per agent, critic and shared; edit, pin and delete a lesson", async ({
  page,
  request,
}) => {
  await page.goto("/memory");
  const views = page.getByTestId("memory-views");
  await expect(views.getByRole("tab")).toHaveCount(4);
  await expect(views.getByRole("tab").nth(0)).toContainText("Alice's agent");
  await expect(views.getByRole("tab").nth(1)).toContainText("Bob's agent");
  await expect(page.getByTestId("lesson")).toHaveCount(2);
  const second = page.getByTestId("lesson").nth(1);
  await expect(second).toHaveAttribute("data-lesson-id", "les_2");
  await second.getByTestId("lesson-edit").click();
  await second
    .getByTestId("lesson-text-input")
    .fill("Ask for the acceptance criteria before estimating, every time.");
  await second.getByTestId("lesson-save").click();
  await expect(second.getByTestId("lesson-text")).toContainText("every time.");
  await second.getByTestId("lesson-pin").click();
  await expect(second).toHaveAttribute("data-pinned", "true");
  await second.getByTestId("lesson-delete").click();
  await second.getByTestId("lesson-delete-confirm").click();
  await expect(page.getByTestId("lesson")).toHaveCount(1);
  await page.getByTestId("memory-view-agent-agent_bob").click();
  await expect(page.getByTestId("memory-not-readable")).toContainText(
    "not readable by this install",
  );
  await page.getByTestId("memory-view-shared").click();
  await expect(page.getByTestId("lesson")).toContainText("Keep PRs under 400");
  const calls = await recordedCalls(request);
  expect(
    calls.find((c) => c.path === "/memory/lessons/les_2" && c.method === "PUT")?.body,
  ).toMatchObject({
    text: "Ask for the acceptance criteria before estimating, every time.",
  });
  expect(calls.find((c) => c.path === "/memory/lessons/les_2/pin")?.body).toEqual({ pinned: true });
  expect(calls.some((c) => c.path === "/memory/lessons/les_2" && c.method === "DELETE")).toBe(true);
});
