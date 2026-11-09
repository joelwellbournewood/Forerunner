import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TASKS } from "./fixtures.ts";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * w15-words (wave 15 run B): what the screens say, read where the person reads it (design §5),
 * with the fake daemon wording rows and cards through the daemon's own words. Each case clicks
 * what the person clicks.
 */

const rowOf = async (id: string) =>
  (await screen.findAllByTestId("task-row")).find(
    (r) => r.getAttribute("data-task-id") === id,
  ) as HTMLElement;

function addTask(
  harness: Harness,
  id: string,
  title: string,
  extra: Partial<(typeof TASKS)[number]> = {},
) {
  harness.daemon.state.tasks.push({
    ...(TASKS[2] as (typeof TASKS)[number]),
    id,
    title,
    riskTier: 1,
    prUrl: null,
    ...extra,
  });
}

function addCard(
  harness: Harness,
  id: string,
  taskId: string,
  changeCard: object,
  extra: Partial<(typeof harness.daemon.state.requests)[number]> = {},
) {
  harness.daemon.state.requests.push({
    ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[number]),
    id,
    taskId,
    projectId: "proj_atlas",
    status: "open",
    why: "seed",
    changeCard: changeCard as never,
    ...extra,
  });
}

describe("w15-words, wave 15 run B", () => {
  describe("W15-56: a task paused before it wrote anything", () => {
    const seed = () => {
      const harness = createHarness();
      addTask(harness, "t_empty", "Write the guide for members", { status: "needs_human" });
      addCard(
        harness,
        "req_empty",
        "t_empty",
        {
          key: "task:budget_stop",
          task_id: "t_empty",
          title: '"Write the guide for members" paused at its budget of CHF 0.01',
          source: "task_budget",
          continue_usd_micro: 12_500,
          chf_per_usd: 0.8,
          done: "",
          left: [],
        },
        {
          why: '"Write the guide for members" paused at its budget of CHF 0.01.',
          options: ["Continue (CHF 0.01 more)", "Cancel task"],
        },
      );
      return harness;
    };

    it("the row, the dialog and the drawer say Drops it., never set aside", async () => {
      const user = userEvent.setup();
      const harness = seed();
      renderApp("/projects/proj_atlas/tasks?task=t_empty", harness);
      const drawer = await screen.findByTestId("task-drawer");
      expect(within(drawer).getByTestId("drawer-explain-cancel")).toHaveTextContent(/^Drops it\.$/);
      const row = await rowOf("t_empty");
      expect(within(row).getByTestId("task-status")).toHaveTextContent("Paused at its budget");
      expect(within(row).getByTestId("action-cancel")).toHaveAttribute("title", "Drops it.");
      await user.click(within(row).getByTestId("action-cancel"));
      const dialog = await screen.findByTestId("action-dialog");
      expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(/^Drops it\.$/);
      expect(dialog).not.toHaveTextContent(/set aside|so far/);
    });

    it("its Inbox card says it stopped before it wrote anything, and Cancel task only drops it", async () => {
      const harness = seed();
      renderApp("/inbox", harness);
      const card = (await screen.findAllByTestId("request")).find(
        (r) => r.getAttribute("data-request-id") === "req_empty",
      ) as HTMLElement;
      expect(within(card).getByTestId("request-body")).toHaveTextContent(
        "It stopped before it wrote anything.",
      );
      expect(card).not.toHaveTextContent(/so far is kept|set aside/);
      expect(
        within(card)
          .getAllByTestId("option-explain")
          .map((e) => e.textContent),
      ).toEqual([
        "Adds CHF 0.01 to its budget and starts a session that goes on from where it stopped.",
        "Drops it.",
      ]);
      expect(postedCalls(harness, "/requests/req_empty/answer")).toEqual([]);
    });
  });
});
