import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ZERO_REFUSED } from "../../../packages/commands/src/commands/budget.ts";
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
  describe("W15B-17: the questions card reads without markdown; the answer keeps the question", () => {
    const asked = [
      "Can `developer.mozilla.org` be added to the project's websites?",
      "Which **hosting** should the page use, _Cloudflare Pages_ or GitHub Pages?",
    ];
    const seed = () => {
      const harness = createHarness();
      addTask(harness, "t_hosts", "Compare the hosts", { status: "needs_human" });
      addCard(
        harness,
        "req_hosts",
        "t_hosts",
        {
          key: "person_questions:t_hosts",
          task_id: "t_hosts",
          task_title: "Compare the hosts",
          questions: asked,
          source: "specialist",
          on_answer: "resume",
          context: "The **researcher** reads only `github.io` pages so far.",
          applied_at: null,
        },
        { kind: "decision", why: '"Compare the hosts" needs your answers.', steps: asked },
      );
      return harness;
    };

    it("the labels and the context are plain; Send answers sends the questions as asked", async () => {
      const user = userEvent.setup();
      const harness = seed();
      renderApp("/inbox", harness);
      const form = await screen.findByTestId("person-questions");
      const request = form.closest('[data-testid="request"]') as HTMLElement;
      expect(
        within(form).getByText("Can developer.mozilla.org be added to the project's websites?"),
      ).toBeVisible();
      expect(
        within(form).getByText(
          "Which hosting should the page use, Cloudflare Pages or GitHub Pages?",
        ),
      ).toBeVisible();
      // What the person reads of the card: no tick, no star, no underscore of markdown.
      expect(request.textContent).not.toMatch(/[`*]|_Cloudflare/);
      expect(request).toHaveTextContent("The researcher reads only github.io pages so far.");
      const fields = within(form).getAllByTestId("person-answer");
      await user.type(fields[0] as HTMLElement, "Yes");
      await user.type(fields[1] as HTMLElement, "Cloudflare Pages");
      await user.click(within(form).getByTestId("send-answers"));
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_hosts/answer")).toHaveLength(1),
      );
      expect(postedCalls(harness, "/requests/req_hosts/answer")[0]?.body).toMatchObject({
        answer: {
          answers: [
            { question: asked[0], answer: "Yes" },
            { question: asked[1], answer: "Cloudflare Pages" },
          ],
        },
      });
    });
  });
  describe("W15B-16: on and off; CHF 0.00 with what to do", () => {
    it("Settings: the session budget's 0 says CHF 0.00 and what to do; a negative amount says CHF 0.00 too", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      renderApp("/settings", harness);
      const cap = (await screen.findAllByTestId("setting-row")).find(
        (r) => r.dataset.key === "project.session_cap",
      ) as HTMLElement;
      await user.click(within(cap).getByTestId("setting-change"));
      const dialog = await screen.findByTestId("setting-dialog");
      const input = within(dialog).getByTestId("setting-value");
      await user.clear(input);
      await user.type(input, "0");
      expect(within(dialog).getByTestId("setting-value-problem")).toHaveTextContent(
        ZERO_REFUSED.session,
      );
      expect(ZERO_REFUSED.session).toBe(
        "The budget per session must be more than CHF 0.00: a session plans its work within it. Enter the most a session may spend.",
      );
      await user.clear(input);
      await user.type(input, "-3");
      expect(within(dialog).getByTestId("setting-value-problem")).toHaveTextContent(
        "The amount must be CHF 0.00 or more.",
      );
      expect(within(dialog).getByTestId("setting-apply")).toBeDisabled();
    });

    it("the Start dialog's budget of 0 says CHF 0.00", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      renderApp("/projects/proj_atlas", harness);
      await screen.findByTestId("summary");
      await user.click(screen.getByTestId("start-session"));
      const dialog = await screen.findByTestId("start-session-dialog");
      const budget = within(dialog).getByLabelText(/Session budget/);
      for (const typed of ["0", "-5"]) {
        await user.clear(budget);
        await user.type(budget, typed);
        expect(within(dialog).getByTestId("start-session-budget-error")).toHaveTextContent(
          "The budget must be more than CHF 0.00.",
        );
      }
    });

    it("the fake daemon's budget and yes/no sentences are the daemon's", async () => {
      const harness = createHarness();
      const run = (name: string, params: Record<string, unknown>) =>
        harness.client.executeCommands({
          commands: [{ name, params }],
          wordsUsed: "Settings",
          source: "ui",
          confirm: "tap",
        });
      const zero = await run("budget.set", { scope: "session", amountChf: 0 });
      expect(zero.status).toBe("refused");
      expect(zero.reason).toBe(ZERO_REFUSED.session);
      // The same literals real-daemon.test.ts "w15-words, wave 15 run B" reads from the daemon.
      expect(
        (await run("budget.set", { scope: "session", amountChf: 8, project: "proj_atlas" }))
          .sentence,
      ).toBe("Raised the session budget for Atlas from CHF 5.00 to CHF 8.00. Undo.");
      expect((await run("budget.set", { scope: "month", amountChf: 3 })).sentence).toBe(
        "Lowered the monthly cap from CHF 150.00 to CHF 3.00. Undo.",
      );
      const fast = await run("settings.set", {
        key: "fast_mode",
        value: true,
        project: "proj_atlas",
      });
      expect(fast.sentence).toMatch(/^Set Opus fast mode for Atlas from off to on: /);
    });
  });
});
