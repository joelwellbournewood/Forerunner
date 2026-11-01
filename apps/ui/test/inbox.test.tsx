import { ANSWER_CARD_KEYS } from "@forerunner/runtime/wiring/request-answers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { actionsFor } from "../src/lib/task-actions.ts";
import {
  intakeCardOf,
  PERSON_QUESTIONS_KEY_PREFIX,
  sortMessages,
  sortRequests,
} from "../src/pages/InboxPage.tsx";
import { MESSAGES, REQUESTS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Inbox", () => {
  it("sorts blocking requests first, then newest; unread messages first", () => {
    expect(sortRequests(REQUESTS).map((r) => r.id)).toEqual(["req_1", "req_2"]);
    expect(sortMessages(MESSAGES).map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });

  it("Needs you lists the cards blocking first, each with its options; no risk or kind badges, no change-card JSON (design §3.8)", async () => {
    renderApp("/inbox");
    const requests = await screen.findAllByTestId("request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveAttribute("data-blocking", "true");
    expect(requests[0]).toHaveAttribute("data-request-id", "req_1");
    expect(requests[1]).toHaveAttribute("data-blocking", "false");
    const first = within(requests[0] as HTMLElement);
    // The card's title is its first sentence, the rest its body.
    expect(first.getByTestId("request-title")).toHaveTextContent(
      "Deploy the search preview to staging",
    );
    expect(first.getByTestId("request-body")).toHaveTextContent(
      "This costs about CHF 0.40 of runner time.",
    );
    expect(first.getAllByTestId("option").map((b) => b.textContent)).toEqual([
      "Approve",
      "Reject",
      "Ask me later",
    ]);
    // Risk and kind are not badges any more; the card JSON is never shown.
    expect(first.queryByText("medium risk")).toBeNull();
    expect(first.queryByText("approval")).toBeNull();
    expect(screen.queryByText("Change card")).toBeNull();
    expect(screen.queryByText(/"reversible"/)).toBeNull();
    // Every open card needs you, and the heading counts them all.
    expect(screen.getByTestId("needs-you-heading")).toHaveTextContent("Needs you (2)");
  });

  it("a text box only where free text is accepted: a question takes words, an approval only its options (design §3.8)", async () => {
    renderApp("/inbox");
    const requests = await screen.findAllByTestId("request");
    const byId = (id: string) =>
      requests.find((r) => r.getAttribute("data-request-id") === id) as HTMLElement;
    expect(within(byId("req_1")).queryByTestId("free-text")).toBeNull();
    expect(within(byId("req_2")).getByTestId("free-text")).toBeInTheDocument();
  });

  it("every card names its task and its project (U-073)", async () => {
    renderApp("/inbox");
    const requests = await screen.findAllByTestId("request");
    const byId = (id: string) =>
      requests.find((r) => r.getAttribute("data-request-id") === id) as HTMLElement;
    expect(within(byId("req_1")).getByTestId("request-task")).toHaveTextContent(
      "Task: Add the search box to the header",
    );
    expect(within(byId("req_2")).getByTestId("request-task")).toHaveTextContent(
      "Task: Decide the versioning scheme",
    );
    for (const r of requests) {
      expect(within(r).getByRole("link", { name: "Atlas" })).toHaveAttribute(
        "href",
        "/projects/proj_atlas",
      );
    }
    // The task opens its drawer on the project's Tasks tab.
    expect(
      within(within(byId("req_1")).getByTestId("request-task")).getByRole("link"),
    ).toHaveAttribute("href", "/projects/proj_atlas/tasks?task=task_2");
  });

  it("posts the chosen option with the request version; the card is replaced by its Done line and listed under Answered", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const requests = await screen.findAllByTestId("request");
    await user.click(within(requests[0] as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(postedCalls(harness, "/requests/req_1/answer")).toHaveLength(1));
    expect(postedCalls(harness, "/requests/req_1/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Approve",
    });
    await waitFor(() => expect(screen.getAllByTestId("request")).toHaveLength(1));
    expect(screen.getByTestId("done-line")).toHaveTextContent('Done: You answered "Approve".');
    expect(screen.getByTestId("needs-you-heading")).toHaveTextContent("Needs you (1)");
    expect(screen.getByTestId("inbox-badge")).toHaveTextContent("1");
    // What was answered stays readable under Answered.
    const answered = within(screen.getByTestId("answered"));
    expect(answered.getByText("Answered (1)")).toBeInTheDocument();
    expect(answered.getByTestId("answered-request")).toHaveTextContent(
      "Deploy the search preview to staging",
    );
    expect(answered.getByTestId("answered-request")).toHaveTextContent('You answered "Approve".');
  });

  it("sends a free-text answer", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const requests = await screen.findAllByTestId("request");
    const second = within(requests[1] as HTMLElement);
    await user.type(second.getByTestId("free-text"), "Use dates, please");
    await user.click(second.getByTestId("send-free-text"));
    await waitFor(() => expect(postedCalls(harness, "/requests/req_2/answer")).toHaveLength(1));
    expect(postedCalls(harness, "/requests/req_2/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Use dates, please",
    });
  });

  it("an answer the card cannot act on shows its options under the card, which stays open (U-034)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const requests = await screen.findAllByTestId("request");
    const card = requests[0] as HTMLElement;
    expect(card).toHaveAttribute("data-request-id", "req_1");
    // An approval takes only its options: there is no box to type something else into.
    expect(within(card).queryByTestId("free-text")).toBeNull();
    // The card changed behind the page (another device): the clicked option is none of its
    // options now, and the daemon refuses it with the ones it has.
    const stored = harness.daemon.state.requests.find((r) => r.id === "req_1");
    if (stored) stored.options = ["Approve now", "Reject", "Later"];
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    // The person reads what happened and what to do, under the card they answered.
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Choose one of: Approve now, Reject, Later",
    );
    expect(postedCalls(harness, "/requests/req_1/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Approve",
    });
    expect(harness.daemon.state.requests.find((r) => r.id === "req_1")?.status).toBe("open");
    expect(screen.getAllByTestId("request")).toHaveLength(2);
    expect(screen.getByTestId("needs-you-heading")).toHaveTextContent("Needs you (2)");
  });

  it("reloads when the install stream reports a new count", async () => {
    const harness = createHarness();
    renderApp("/inbox", harness);
    expect(await screen.findAllByTestId("request")).toHaveLength(2);
    // Answered elsewhere (phone, chat): the daemon state changes behind the page's back ...
    const answered = await harness.daemon.app.fetch(
      new Request("http://127.0.0.1:9/requests/req_1/answer", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, answer: "Approve" }),
      }),
    );
    expect(answered.status).toBe(200);
    expect(screen.getAllByTestId("request")).toHaveLength(2);
    // ... and the only signal the UI gets is `inbox.changed` on /events, which the provider
    // turns into this dispatch.
    harness.store.dispatch({ type: "blockingCount", count: 1 });
    await waitFor(() => expect(screen.getAllByTestId("request")).toHaveLength(1));
    expect(screen.getByTestId("needs-you-heading")).toHaveTextContent("Needs you (1)");
    expect(screen.getAllByTestId("request")[0]).toHaveAttribute("data-request-id", "req_2");
  });

  it("the plan card shows the plan once: the tasks in order, who does each, the cost, Needs Docker; options that say what they do (design §3.3)", async () => {
    // Docker is not running on this computer: a full-review task says it needs it.
    const harness = createHarness({ sandbox: { state: "not_running" } });
    harness.daemon.state.requests.unshift({
      id: "req_intake",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: null,
      sessionId: "sess_9",
      kind: "approval",
      why: 'Intake for "Atlas": 1 milestone(s), 2 task(s), 2 doc(s) and a first-session plan.',
      steps: ["Milestone: Foundations (2 task(s), by 2026-11-01)"],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      changeCard: {
        key: "intake:proj_atlas",
        project_id: "proj_atlas",
        docs_target: "repository",
        cost_usd_micro: 12_000,
        applied_at: null,
        proposal: {
          plan: {
            reason: "planned from the brief",
            milestones: [
              {
                name: "Foundations",
                successCriteria: ["CI green"],
                targetDate: "2026-11-01",
                tasks: [
                  {
                    key: "scaffold",
                    title: "Scaffold the repository",
                    outcome: "skeleton",
                    acceptanceCriteria: [],
                    priority: 8,
                    dependsOn: [],
                    specialist: "coder",
                  },
                  {
                    key: "ci",
                    title: "Set up CI",
                    outcome: "tests run",
                    acceptanceCriteria: [],
                    priority: 6,
                    dependsOn: ["scaffold"],
                    riskTier: 2,
                  },
                ],
              },
            ],
            tasks: [],
          },
          docs: { "README.md": "# Atlas\n", "docs/overview.md": "# Overview\n" },
          firstSession: {
            summary: "Scaffold first.",
            items: [
              { key: "scaffold", estimateUsdMicro: 400_000 },
              { key: "ci", estimateUsdMicro: 250_000 },
            ],
          },
        },
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-19T22:00:00.000Z",
      version: 1,
    });
    renderApp("/inbox", harness);
    const card = await screen.findByTestId("intake-card");
    const request = card.closest('[data-testid="request"]') as HTMLElement;
    expect(request).toHaveAttribute("data-request-id", "req_intake");
    // Design §3.3: the card names the project and says nothing is written before approval.
    expect(within(request).getByTestId("request-title")).toHaveTextContent(
      'Plan for "Atlas": 2 tasks',
    );
    expect(within(request).getByTestId("request-body")).toHaveTextContent(
      "Nothing is written until you approve it.",
    );
    // The plan once: the tasks in order, who does each, what each costs (CHF, U-074), what it
    // comes after, and "Needs Docker" beside a full-review task while Docker is not ready.
    const tasks = within(card).getAllByTestId("intake-task");
    expect(tasks.map((t) => t.textContent)).toEqual([
      "Scaffold the repository · coder · about CHF 0.32",
      'Set up CI · the agent chooses who · about CHF 0.20 · after "Scaffold the repository"Needs Docker',
    ]);
    expect(within(card).getByTestId("intake-total")).toHaveTextContent(
      "About CHF 0.52 for these tasks; the docs go to the project's repository as a pull request.",
    );
    // Not three times (the steps, the milestones, the first session), no doc list, no JSON.
    expect(request).not.toHaveTextContent("Milestone:");
    expect(request).not.toHaveTextContent("First session");
    expect(request).not.toHaveTextContent("docs/overview.md");
    expect(request).not.toHaveTextContent("USD");
    expect(within(request).queryByText("Change card")).toBeNull();
    // Each option says what it does (design §3.3).
    const options = within(request).getAllByTestId("option");
    expect(options.map((b) => b.textContent)).toEqual([
      "Approve and start",
      "Change the plan",
      "Reject",
    ]);
    expect(
      within(request)
        .getAllByTestId("option-explain")
        .map((e) => e.textContent),
    ).toEqual([
      "Writes these 2 tasks and starts working on them now.",
      "Tell the agent what to change; it drafts a new plan for you to approve.",
      "Nothing is written. You can draft a new plan later from the project page.",
    ]);
    // Other requests render no intake card.
    expect(screen.getAllByTestId("intake-card")).toHaveLength(1);
  });

  it("the plan card shows the drafted decision as text, never raw markdown, before you approve (U-073, design §3.3)", async () => {
    const harness = createHarness();
    const decision =
      "# 0001: Stack and hosting\n\nWe use **TypeScript** with Hono, hosted on Cloudflare Workers,\nbecause the brief asks for a small API close to its users.\n\n## Why\n\n- Small\n- Close to users";
    harness.daemon.state.requests.unshift({
      id: "req_intake_doc",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: null,
      taskTitle: null,
      sessionId: null,
      kind: "approval",
      why: 'Intake for "Atlas": 1 milestone(s), 1 task(s), 2 doc(s) and a first-session plan.',
      steps: [],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      changeCard: {
        key: "intake:proj_atlas",
        docs_target: "workspace",
        applied_at: null,
        proposal: {
          plan: {
            milestones: [{ name: "Start", tasks: [{ key: "a", title: "Scaffold", priority: 5 }] }],
            tasks: [],
          },
          docs: {
            "README.md": "# Atlas\n\nA search for the docs.",
            "docs/decisions/0001-stack.md": decision,
          },
          firstSession: { summary: "Scaffold.", items: [{ key: "a", estimateUsdMicro: 100_000 }] },
        },
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-19T23:00:00.000Z",
      version: 1,
    });
    renderApp("/inbox", harness);
    const card = await screen.findByTestId("intake-card");
    // The decision is open and readable without a click, as text.
    const text = within(card).getByTestId("intake-decision");
    expect(text).toHaveAttribute("open");
    expect(within(text).getByText(/hosted on Cloudflare Workers/)).toBeVisible();
    expect(text).toHaveTextContent("0001: Stack and hosting");
    expect(text).toHaveTextContent("• Small");
    expect(text).not.toHaveTextContent("#");
    expect(text).not.toHaveTextContent("**");
    // The other drafted docs are scaffolded without being listed.
    expect(card).not.toHaveTextContent("A search for the docs.");
  });

  describe("questions only you can answer (U-022)", () => {
    /** The card the daemon files for a planned person task, as `/inbox` serves it. */
    const questionsCard = () => ({
      id: "req_questions",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: "task_1",
      sessionId: null,
      kind: "decision",
      why: '"Choose the hosting" needs your answers. No specialist works on it: answer the questions below.',
      steps: ["Which hosting provider should the site use?", "Which domain should it live on?"],
      options: ["Cancel the task"],
      blocking: true,
      risk: "low" as const,
      changeCard: {
        key: `${ANSWER_CARD_KEYS.personQuestionsPrefix}task_1`,
        task_id: "task_1",
        task_title: "Choose the hosting",
        questions: [
          "Which hosting provider should the site use?",
          "Which domain should it live on?",
        ],
        source: "planned",
        on_answer: "done",
        context: null,
        applied_at: null,
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-31T09:00:00.000Z",
      version: 1,
    });

    it("uses the runtime's card key", () => {
      expect(PERSON_QUESTIONS_KEY_PREFIX).toBe(ANSWER_CARD_KEYS.personQuestionsPrefix);
    });

    it("shows one answer field per question and sends the answers the person typed", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.requests.unshift(questionsCard());
      renderApp("/inbox", harness);
      const form = await screen.findByTestId("person-questions");
      const request = form.closest('[data-testid="request"]') as HTMLElement;
      // The card names the task as it is now (its title on the Tasks tab).
      expect(request).toHaveTextContent('"Index the documentation pages" needs your answers');
      const fields = within(form).getAllByTestId("person-answer");
      expect(fields).toHaveLength(2);
      expect(within(form).getByText("Which hosting provider should the site use?")).toBeVisible();
      // Nothing typed, nothing to send; the generic one-line answer is not offered here.
      expect(within(form).getByTestId("send-answers")).toBeDisabled();
      expect(within(request).queryByTestId("free-text")).toBeNull();
      await user.type(fields[0] as HTMLElement, "Cloudflare Pages");
      await user.type(fields[1] as HTMLElement, "atlas.example");
      await user.click(within(form).getByTestId("send-answers"));
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_questions/answer")).toHaveLength(1),
      );
      expect(postedCalls(harness, "/requests/req_questions/answer")[0]?.body).toEqual({
        version: 1,
        answer: {
          answers: [
            { question: "Which hosting provider should the site use?", answer: "Cloudflare Pages" },
            { question: "Which domain should it live on?", answer: "atlas.example" },
          ],
        },
      });
      await waitFor(() => expect(screen.queryByTestId("person-questions")).toBeNull());
      expect(harness.daemon.state.tasks.find((t) => t.id === "task_1")?.status).toBe("done");
    });

    it("Cancel task asks once, names what waits on the task, then sends the option and cancels it (design §3.8)", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.requests.unshift(questionsCard());
      // "Add the search box to the header" waits on the task.
      const after = harness.daemon.state.tasks.find((t) => t.id === "task_2");
      if (after) after.dependsOn = ["task_1"];
      const t1 = harness.daemon.state.tasks.find((t) => t.id === "task_1");
      if (t1) t1.status = "needs_human";
      renderApp("/inbox", harness);
      const form = await screen.findByTestId("person-questions");
      const request = form.closest('[data-testid="request"]') as HTMLElement;
      // A planned question for you: no specialist to go ahead without the answers.
      const options = within(request).getAllByTestId("option");
      expect(options.map((b) => b.textContent)).toEqual(["Cancel task"]);
      expect(within(request).getByTestId("option-explain")).toHaveTextContent(
        'Drops it; "Add the search box to the header" after it will be stuck.',
      );
      await user.click(options[0] as HTMLElement);
      // Asked once, with what it does to what waits; nothing is sent yet.
      expect(within(request).getByTestId("choice-confirm")).toHaveTextContent(
        'Cancel "Index the documentation pages"? "Add the search box to the header" waits on it and will be stuck.',
      );
      expect(postedCalls(harness, "/requests/req_questions/answer")).toHaveLength(0);
      await user.click(within(request).getByTestId("choice-confirm-yes"));
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_questions/answer")[0]?.body).toEqual({
          version: 1,
          answer: "Cancel task",
        }),
      );
      await waitFor(() =>
        expect(harness.daemon.state.tasks.find((t) => t.id === "task_1")?.status).toBe("cancelled"),
      );
      expect(await screen.findByTestId("done-line")).toHaveTextContent(
        'Done: "Index the documentation pages" was cancelled.',
      );
    });

    it("a specialist's questions offer Go ahead without, which sends the option and the task goes on (design §3.8)", async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      const card = questionsCard();
      harness.daemon.state.requests.unshift({
        ...card,
        changeCard: {
          ...card.changeCard,
          source: "specialist",
          on_answer: "ready",
          context: "I need to know where the site will be hosted before I write the config.",
        },
      });
      const t1 = harness.daemon.state.tasks.find((t) => t.id === "task_1");
      if (t1) t1.status = "needs_human";
      renderApp("/inbox", harness);
      const form = await screen.findByTestId("person-questions");
      const request = form.closest('[data-testid="request"]') as HTMLElement;
      // The specialist's own words, once.
      expect(within(request).getByTestId("request-body")).toHaveTextContent(
        'The specialist said: "I need to know where the site will be hosted before I write the config."',
      );
      expect(within(request).getAllByText(/where the site will be hosted before/).length).toBe(1);
      const options = within(request).getAllByTestId("option");
      expect(options.map((b) => b.textContent)).toEqual(["Go ahead without", "Cancel task"]);
      expect(within(request).getAllByTestId("option-explain")[0]).toHaveTextContent(
        "The specialist decides and says what it assumed.",
      );
      await user.click(options[0] as HTMLElement);
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_questions/answer")[0]?.body).toEqual({
          version: 1,
          answer: "Go ahead without",
        }),
      );
      await waitFor(() =>
        expect(harness.daemon.state.tasks.find((t) => t.id === "task_1")?.status).toBe("ready"),
      );
      expect(await screen.findByTestId("done-line")).toHaveTextContent(
        'Done: "Index the documentation pages" goes on without your answers: a session started.',
      );
    });
  });

  it("answers that came after their task finished: the Answered entry says so and offers Redo with these answers (design §3.8)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // task_1 is done; its questions were answered after it finished.
    harness.daemon.state.requests.unshift({
      id: "req_late",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: "task_1",
      taskTitle: "Index the documentation pages",
      sessionId: null,
      kind: "decision",
      why: "Which pages first?",
      steps: ["Which pages first?"],
      options: ["Cancel the task"],
      blocking: true,
      risk: "low",
      changeCard: {
        key: "person_questions:task_1",
        task_id: "task_1",
        questions: ["Which pages first?"],
        source: "specialist",
        on_answer: "ready",
        applied_at: "2026-10-31T10:00:00.000Z",
        outcome: "task_moved_on",
      },
      status: "answered",
      answer: { answers: [{ question: "Which pages first?", answer: "The guides." }] },
      createdAt: "2026-10-31T09:00:00.000Z",
      version: 2,
    });
    renderApp("/inbox", harness);
    await user.click(await screen.findByText(/^Answered \(\d+\)$/));
    const entry = (await screen.findAllByTestId("answered-request")).find(
      (e) => e.getAttribute("data-request-id") === "req_late",
    ) as HTMLElement;
    expect(entry).toHaveTextContent(
      'Your answers came after "Index the documentation pages" had finished.',
    );
    await user.click(within(entry).getByTestId("follow-up"));
    await waitFor(() => expect(postedCalls(harness, "/tasks/task_1/action")).toHaveLength(1));
    expect(postedCalls(harness, "/tasks/task_1/action")[0]?.body).toMatchObject({ action: "redo" });
    expect(await within(entry).findByTestId("follow-up-done")).toBeInTheDocument();
  });

  describe("a task that failed after its tries (design §3.8)", () => {
    /** The retry card the critic files after the last try, as `/inbox` serves it. */
    const retryCard = () => ({
      id: "req_retry",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: "task_3",
      taskTitle: "Decide the versioning scheme",
      sessionId: "sess_1",
      kind: "approval",
      why: '"Decide the versioning scheme" failed 4 times. The writer said: "The work needs something I do not have here."',
      steps: ["[high] The worker changed nothing: Do the work the brief asks for."],
      options: ["Try again", "Mark done anyway", "Cancel task"],
      blocking: true,
      risk: "high" as const,
      changeCard: {
        key: "critic:signoff",
        task_id: "task_3",
        review_id: "rev_1",
        run_id: "run_1",
        finding_ids: ["f_1"],
        reason: "retry_ladder_exhausted",
        title: '"Decide the versioning scheme" failed 4 times',
        said: "The work needs something I do not have here.",
        said_by: "writer",
        applied_at: null,
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-31T09:00:00.000Z",
      version: 1,
    });
    const setUp = () => {
      const harness = createHarness();
      harness.daemon.state.requests.unshift(retryCard());
      const t3 = harness.daemon.state.tasks.find((t) => t.id === "task_3");
      if (t3) t3.status = "needs_human";
      // "Add the search box to the header" waits on it.
      const t2 = harness.daemon.state.tasks.find((t) => t.id === "task_2");
      if (t2) {
        t2.dependsOn = ["task_1", "task_3"];
        t2.status = "ready";
      }
      return harness;
    };
    const cardOf = async () =>
      (await screen.findAllByTestId("request")).find(
        (r) => r.getAttribute("data-request-id") === "req_retry",
      ) as HTMLElement;

    it("names the task and how often it failed, quotes the specialist, says what waits; each option says what it does", async () => {
      renderApp("/inbox", setUp());
      const card = await cardOf();
      expect(within(card).getByTestId("request-title")).toHaveTextContent(
        '"Decide the versioning scheme" failed 4 times',
      );
      expect(within(card).getByTestId("request-body")).toHaveTextContent(
        'The writer said: "The work needs something I do not have here." "Add the search box to the header" waits on it.',
      );
      expect(card).not.toHaveTextContent(/ladder|ceiling|attempt\(s\)|\[high\]|high risk/i);
      expect(
        within(card)
          .getAllByTestId("option")
          .map((b) => b.textContent),
      ).toEqual(["Try again", "Mark done anyway", "Cancel task"]);
      expect(
        within(card)
          .getAllByTestId("option-explain")
          .map((e) => e.textContent),
      ).toEqual([
        "Starts a session that tries again; add a note if you know what to change.",
        'Closes it although nothing passed review. "Add the search box to the header" after it will run.',
        'Drops it; "Add the search box to the header" after it will be stuck.',
      ]);
      // The critic's findings are under Details, in plain words; no reply box.
      expect(within(card).getByTestId("request-details")).toHaveTextContent(
        "The worker changed nothing: Do the work the brief asks for.",
      );
      expect(within(card).queryByTestId("free-text")).toBeNull();
    });

    it("Try again sends the note with it; the card is replaced by its Done line and a session starts", async () => {
      const user = userEvent.setup();
      const harness = setUp();
      renderApp("/inbox", harness);
      const card = await cardOf();
      await user.type(within(card).getByTestId("choice-note"), "Use dates.");
      await user.click(within(card).getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_retry/answer")[0]?.body).toEqual({
          version: 1,
          answer: { choice: "Try again", note: "Use dates." },
        }),
      );
      expect(await screen.findByTestId("done-line")).toHaveTextContent(
        'Done: Trying "Decide the versioning scheme" again: a session started.',
      );
      expect(
        screen.queryAllByTestId("request").map((r) => r.getAttribute("data-request-id")),
      ).not.toContain("req_retry");
      expect(harness.daemon.state.tasks.find((t) => t.id === "task_3")?.status).toBe("ready");
    });

    it("Mark done anyway asks once, then the task is Done: accepted without review", async () => {
      const user = userEvent.setup();
      const harness = setUp();
      renderApp("/inbox", harness);
      const card = await cardOf();
      await user.click(within(card).getByRole("button", { name: "Mark done anyway" }));
      expect(within(card).getByTestId("choice-confirm")).toHaveTextContent(
        'Mark "Decide the versioning scheme" done although nothing passed review?',
      );
      expect(postedCalls(harness, "/requests/req_retry/answer")).toHaveLength(0);
      await user.click(within(card).getByTestId("choice-confirm-yes"));
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_retry/answer")[0]?.body).toEqual({
          version: 1,
          answer: "Mark done anyway",
        }),
      );
      expect(await screen.findByTestId("done-line")).toHaveTextContent(
        'Done: "Decide the versioning scheme" is done: accepted without review.',
      );
      // The Tasks tab says so too (design §2).
      const tasks = await harness.client.tasks("proj_atlas");
      expect(tasks.find((t) => t.id === "task_3")?.display?.label).toBe(
        "Done: accepted without review",
      );
    });

    it("on the Tasks tab the task reads Needs your decision and offers Answer, Try again and Cancel, never Go ahead without", async () => {
      const harness = setUp();
      const tasks = await harness.client.tasks("proj_atlas");
      const row = tasks.find((t) => t.id === "task_3");
      expect(row?.display).toMatchObject({
        key: "answer",
        label: "Needs your decision",
        blocker: { kind: "card", requestId: "req_retry", cardKind: "retry" },
      });
      expect(actionsFor("answer", row)).toEqual(["answer", "try_again", "cancel"]);
    });
  });

  it("intakeCardOf reads only intake cards that carry a proposal", () => {
    expect(intakeCardOf(null)).toBeNull();
    expect(intakeCardOf({ target: "staging", reversible: true })).toBeNull();
    expect(intakeCardOf({ key: "intake:p", proposal: "not an object" })).toBeNull();
    const view = intakeCardOf({
      key: "intake:p",
      proposal: {
        plan: { milestones: [], tasks: [{ title: "Loose", priority: 3 }] },
        docs: {},
        firstSession: { summary: "s", items: [{ key: "ghost", estimateUsdMicro: 5 }] },
      },
    });
    expect(view?.looseTasks.map((t) => t.title)).toEqual(["Loose"]);
    expect(view?.firstSession.items).toEqual([
      { key: "ghost", title: "ghost", estimateUsdMicro: 5 },
    ]);
    expect(view?.docsTarget).toBeNull();
    expect(view?.costUsdMicro).toBeNull();
  });

  it("marks a message read", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const messages = await screen.findAllByTestId("message");
    expect(messages[0]).toHaveAttribute("data-read", "false");
    await user.click(within(messages[0] as HTMLElement).getByTestId("mark-read"));
    await waitFor(() => expect(postedCalls(harness, "/messages/msg_1/read")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getAllByTestId("message")[0]).toHaveAttribute("data-read", "true"),
    );
  });

  it("marks every unread message read with one click (U-020)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // A second unread message beside msg_1; msg_2 is already read.
    const second = { ...MESSAGES[0], id: "msg_3", readAt: null } as (typeof MESSAGES)[number];
    harness.daemon.state.messages.push(second);
    renderApp("/inbox", harness);
    await screen.findAllByTestId("message");
    await user.click(screen.getByTestId("mark-all-read"));
    await waitFor(() => {
      expect(postedCalls(harness, "/messages/msg_1/read")).toHaveLength(1);
      expect(postedCalls(harness, "/messages/msg_3/read")).toHaveLength(1);
    });
    // A message that was already read is left alone.
    expect(postedCalls(harness, "/messages/msg_2/read")).toHaveLength(0);
    await waitFor(() => {
      for (const m of screen.getAllByTestId("message"))
        expect(m).toHaveAttribute("data-read", "true");
    });
    // Nothing unread is left, so the button goes away.
    expect(screen.queryByTestId("mark-all-read")).toBeNull();
  });
});
