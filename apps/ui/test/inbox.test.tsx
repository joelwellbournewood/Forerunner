import { ANSWER_CARD_KEYS } from "@forerunner/runtime/wiring/request-answers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

  it("renders requests blocking first with their options and context", async () => {
    renderApp("/inbox");
    const requests = await screen.findAllByTestId("request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveAttribute("data-blocking", "true");
    expect(requests[0]).toHaveAttribute("data-request-id", "req_1");
    expect(requests[1]).toHaveAttribute("data-blocking", "false");
    const first = within(requests[0] as HTMLElement);
    expect(first.getByText(/Deploy the search preview/)).toBeInTheDocument();
    expect(first.getAllByTestId("option").map((b) => b.textContent)).toEqual([
      "Approve",
      "Reject",
      "Ask me later",
    ]);
    expect(first.getByText("medium risk")).toBeInTheDocument();
    expect(screen.getByTestId("blocking-count")).toHaveTextContent("1 blocking");
  });

  it("posts the chosen option with the request version and drops the request from the list", async () => {
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
    expect(screen.getByTestId("blocking-count")).toHaveTextContent("0 blocking");
    expect(screen.queryByTestId("inbox-badge")).not.toBeInTheDocument();
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

  it("a typed answer that is none of a card's options shows the options under the card, which stays open (U-034)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const requests = await screen.findAllByTestId("request");
    const card = requests[0] as HTMLElement;
    expect(card).toHaveAttribute("data-request-id", "req_1");
    const shown = within(card)
      .getAllByTestId("option")
      .map((b) => b.textContent);
    await user.type(within(card).getByTestId("free-text"), "maybe next week");
    await user.click(within(card).getByTestId("send-free-text"));
    // The person reads what happened and what to do, under the card they answered.
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      `Choose one of: ${shown.join(", ")}`,
    );
    expect(postedCalls(harness, "/requests/req_1/answer")[0]?.body).toEqual({
      version: 1,
      answer: "maybe next week",
    });
    expect(harness.daemon.state.requests.find((r) => r.id === "req_1")?.status).toBe("open");
    expect(screen.getAllByTestId("request")).toHaveLength(2);
    expect(screen.getByTestId("blocking-count")).toHaveTextContent("1 blocking");

    // The same card takes a typed option, whatever its case.
    await user.clear(within(card).getByTestId("free-text"));
    await user.type(within(card).getByTestId("free-text"), "approve");
    await user.click(within(card).getByTestId("send-free-text"));
    await waitFor(() => expect(screen.getAllByTestId("request")).toHaveLength(1));
    expect(harness.daemon.state.requests.find((r) => r.id === "req_1")?.status).toBe("answered");
  });

  it("reloads when the install stream reports a new blocking count", async () => {
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
    harness.store.dispatch({ type: "blockingCount", count: 0 });
    await waitFor(() => expect(screen.getAllByTestId("request")).toHaveLength(1));
    expect(screen.getByTestId("blocking-count")).toHaveTextContent("0 blocking");
    expect(screen.getAllByTestId("request")[0]).toHaveAttribute("data-request-id", "req_2");
  });

  it("renders an intake proposal (spec A.2) as a readable plan card with its options", async () => {
    const harness = createHarness();
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
    const milestones = within(card).getByTestId("intake-milestones");
    expect(milestones).toHaveTextContent("Foundations");
    expect(milestones).toHaveTextContent("by 2026-11-01");
    expect(milestones).toHaveTextContent("Scaffold the repository");
    expect(milestones).toHaveTextContent("project default review, priority high, coder");
    expect(milestones).toHaveTextContent("Set up CI");
    expect(milestones).toHaveTextContent(
      'full review (tier 2), priority medium, after "Scaffold the repository"',
    );
    const docs = within(card).getByTestId("intake-docs");
    expect(docs).toHaveTextContent("Docs (2): README.md, docs/overview.md");
    expect(docs).toHaveTextContent("as a pull request");
    const first = within(card).getByTestId("intake-first-session");
    // Money in CHF (U-074).
    expect(first).toHaveTextContent("First session (CHF 0.52): Scaffold first.");
    expect(first).toHaveTextContent("Scaffold the repository (~CHF 0.32)");
    expect(first).toHaveTextContent("Set up CI (~CHF 0.20)");
    expect(card).toHaveTextContent(
      "Planning call: CHF 0.01. Nothing is written until you approve.",
    );
    expect(card).not.toHaveTextContent("USD");
    // The request keeps its ordinary controls: the options and the raw card behind details.
    const request = card.closest('[data-testid="request"]') as HTMLElement;
    expect(request).toHaveAttribute("data-request-id", "req_intake");
    expect(
      within(request)
        .getAllByTestId("option")
        .map((b) => b.textContent),
    ).toEqual(["approve", "reject"]);
    expect(within(request).getByText("Change card")).toBeInTheDocument();
    // Other requests render no intake card.
    expect(screen.getAllByTestId("intake-card")).toHaveLength(1);
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
      expect(request).toHaveTextContent('"Choose the hosting" needs your answers');
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

    it('"Cancel the task" sends the option the card shows and cancels the task', async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      harness.daemon.state.requests.unshift(questionsCard());
      renderApp("/inbox", harness);
      const form = await screen.findByTestId("person-questions");
      const request = form.closest('[data-testid="request"]') as HTMLElement;
      const options = within(request).getAllByTestId("option");
      expect(options.map((b) => b.textContent)).toEqual(["Cancel the task"]);
      await user.click(options[0] as HTMLElement);
      await waitFor(() =>
        expect(postedCalls(harness, "/requests/req_questions/answer")[0]?.body).toEqual({
          version: 1,
          answer: "Cancel the task",
        }),
      );
      await waitFor(() =>
        expect(harness.daemon.state.tasks.find((t) => t.id === "task_1")?.status).toBe("cancelled"),
      );
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
