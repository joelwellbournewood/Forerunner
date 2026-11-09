import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { aboutChf, chfWords, formatMoney } from "../src/lib/money.ts";
import { money, TASKS } from "./fixtures.ts";
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

  describe("W15-74 (W15B-18): money under a centime never reads CHF 0.00 on screen", () => {
    it("chfWords and aboutChf: 'less than CHF 0.01' above zero, 'CHF 0.00' for nothing", () => {
      expect(chfWords(3_200)).toBe("less than CHF 0.01");
      expect(chfWords(0)).toBe("CHF 0.00");
      expect(chfWords(5_000)).toBe("CHF 0.01");
      expect(aboutChf(3_200)).toBe("less than CHF 0.01");
      expect(aboutChf(400_000)).toBe("about CHF 0.40");
      expect(formatMoney(money(4_000))).toBe("less than CHF 0.01");
      expect(formatMoney(money(0))).toBe("CHF 0.00");
    });

    it("a running task's spend on its Tasks row and in its drawer", async () => {
      const harness = createHarness();
      addTask(harness, "t_run", "Write the note", {
        status: "in_progress",
        spent: money(4_000),
        actual: money(4_000),
      });
      renderApp("/projects/proj_atlas/tasks?task=t_run", harness);
      const row = await rowOf("t_run");
      expect(row).toHaveTextContent("less than CHF 0.01");
      expect(row).not.toHaveTextContent("CHF 0.00");
      const drawer = await screen.findByTestId("task-drawer");
      expect(drawer).toHaveTextContent("spent less than CHF 0.01");
    });

    it("the session's budget meter and the log's cost column", async () => {
      const harness = createHarness();
      const session = harness.daemon.state.sessions[0];
      if (session) session.spent = money(4_000);
      const event = harness.daemon.state.events.find((e) => e.id === "ev_5");
      if (event) event.cost = money(4_000);
      renderApp("/sessions/sess_1", harness);
      const header = await screen.findByTestId("session-header");
      await waitFor(() =>
        expect(within(header).getByTestId("session-spend")).toHaveTextContent(
          "less than CHF 0.01 of CHF 5.00",
        ),
      );
      const rows = await screen.findAllByTestId("event-row");
      const finished = rows.find((r) => r.getAttribute("data-seq") === "5") as HTMLElement;
      expect(finished).toHaveTextContent("less than CHF 0.01");
      expect(finished).not.toHaveTextContent("CHF 0.00");
    });
  });
  describe("W15B-15: the session log shows no raw level word", () => {
    it("a warning, an escalation and an error keep their tone, named in words, with no level word on the line", async () => {
      const harness = createHarness();
      harness.daemon.state.events.push({
        id: "ev_err",
        sessionId: "sess_1",
        seq: 6,
        type: "session.error",
        text: "Claude did not answer (network).",
        payload: {},
        cost: money(0),
        at: "2026-10-19T21:09:30.000Z",
        level: "error",
        audience: "person",
      });
      renderApp("/sessions/sess_1", harness);
      const rows = await screen.findAllByTestId("event-row");
      const of = (level: string) =>
        rows.find((r) => r.getAttribute("data-level") === level) as HTMLElement;
      for (const [level, name] of [
        ["warning", "Worth a look"],
        ["escalation", "Needs you"],
        ["error", "Something went wrong"],
      ] as const) {
        const row = of(level);
        expect(row, level).toBeDefined();
        expect(within(row).getByTestId("level-badge")).toHaveAccessibleName(name);
        expect(within(row).getByTestId("level-badge")).toHaveTextContent("");
        expect(row.textContent ?? "", level).not.toMatch(/\b(warning|escalation|error)\b/);
      }
    });
  });
  describe("W15-43: a specialist is named in words on the Tasks tab and the plan card", () => {
    /** A plan card as the daemon files it, with two tasks and their first-session estimates. */
    const planCard = (
      tasks: { key: string; title: string; specialist?: string; usd: number }[],
    ) => ({
      id: "req_intake",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: null,
      sessionId: "sess_9",
      kind: "approval",
      why: 'Intake for "Atlas"',
      steps: [],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium" as const,
      changeCard: {
        key: "intake:proj_atlas",
        project_id: "proj_atlas",
        docs_target: "workspace",
        cost_usd_micro: 12_000,
        applied_at: null,
        proposal: {
          plan: {
            reason: "planned from the brief",
            milestones: [
              {
                name: "Launch",
                successCriteria: [],
                targetDate: null,
                tasks: tasks.map((t) => ({
                  key: t.key,
                  title: t.title,
                  outcome: "done",
                  acceptanceCriteria: [],
                  priority: 5,
                  dependsOn: [],
                  ...(t.specialist ? { specialist: t.specialist } : {}),
                })),
              },
            ],
            tasks: [],
          },
          docs: { "README.md": "# Atlas\n" },
          firstSession: {
            summary: "First.",
            items: tasks.map((t) => ({ key: t.key, estimateUsdMicro: t.usd })),
          },
        },
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-19T22:00:00.000Z",
      version: 1,
    });

    it("the plan card says 'writer', never 'writer-marketing'", async () => {
      const harness = createHarness();
      harness.daemon.state.requests.unshift(
        planCard([
          { key: "a", title: "Write the flyer", specialist: "writer-marketing", usd: 250_000 },
          { key: "b", title: "Build the page", specialist: "coder", usd: 400_000 },
        ]) as never,
      );
      renderApp("/inbox", harness);
      const card = await screen.findByTestId("intake-card");
      const tasks = within(card).getAllByTestId("intake-task");
      expect(tasks[0]).toHaveTextContent("Write the flyer · writer · about CHF 0.20");
      expect(card).not.toHaveTextContent("writer-marketing");
    });

    it("the Who column, its filter and the drawer say 'writer'", async () => {
      const harness = createHarness();
      addTask(harness, "t_flyer", "Write the flyer", {
        status: "ready",
        specialist: "writer-marketing",
      });
      renderApp("/projects/proj_atlas/tasks?task=t_flyer", harness);
      const row = await rowOf("t_flyer");
      expect(within(row).getByText("writer")).toBeInTheDocument();
      expect(row).not.toHaveTextContent("writer-marketing");
      const drawer = await screen.findByTestId("task-drawer");
      expect(drawer).not.toHaveTextContent("writer-marketing");
      const options = Array.from(document.querySelectorAll("option")).map((o) => o.textContent);
      expect(options).not.toContain("writer-marketing");
    });
  });
});
