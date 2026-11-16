import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-cred-screens, run C (CS-8, C5-left-3; CE-9, the owner's 7b): while the person's first
 * choice is stopped and their policy waits, chat says so and offers 'Use API key' for that one
 * question, with what it costs; the press sends the same question once with the one-off flag, is
 * disabled while the answer comes, and a held reply offers no Think it through (before: the hold
 * reply carried no press at all, and offered Think it through, whose press got the hold reply
 * again). The daemon writes every word.
 */
const HOLD =
  "Your Claude subscription is at its limit until 15:40, so I have not answered. I can still add, move and start tasks.";
const ONE_OFF = {
  label: "Use API key",
  explain: "Answers this question on your API key: about CHF 0.02.",
};

async function heldChat(where: "chat" | "conversation") {
  const user = userEvent.setup();
  const harness = createHarness();
  renderApp("/projects/proj_atlas/chat", harness);
  let scope: HTMLElement = document.body;
  if (where === "conversation") {
    await user.click(await screen.findByTestId("talk-open"));
    scope = await screen.findByTestId("conversation");
  }
  const input = await within(scope).findByTestId(`${where}-input`);
  await waitFor(() => expect(input).toBeEnabled());
  harness.daemon.state.nextChatTurn = { reply: HOLD, oneOff: ONE_OFF };
  await user.type(input, "what is left on the page?");
  await user.click(within(scope).getByTestId(`${where}-send`));
  return { user, harness, scope };
}

describe("d1109-cred-screens, run C: chat's one-off press under a hold reply (CS-8, C5-left-3)", () => {
  for (const where of ["chat", "conversation"] as const) {
    it(`${where === "chat" ? "the Chat tab" : "Talk"}: the hold reply shows Use API key with its cost; one press asks the same question once on the key`, async () => {
      const { user, harness, scope } = await heldChat(where);
      const press = await within(scope).findByTestId(`${where}-one-off`);
      expect(press).toHaveTextContent("Use API key");
      expect(within(scope).getByTestId(`${where}-one-off-explain`)).toHaveTextContent(
        "Answers this question on your API key: about CHF 0.02.",
      );
      expect(within(scope).getByText(HOLD)).toBeInTheDocument();
      // A hold reply is no answer to think longer about.
      expect(within(scope).queryByTestId(`${where}-think`)).toBeNull();
      // The press: the same question, with the one-off flag; the answer is held in flight so
      // the press can be seen disabled until it arrives.
      harness.daemon.state.nextChatTurn = { hold: true, reply: "The page has three tasks left." };
      await user.click(press);
      await waitFor(() => expect(harness.daemon.state.answering).not.toBeNull());
      const again = within(scope).queryByTestId(`${where}-one-off`);
      if (again) expect(again).toBeDisabled();
      harness.daemon.state.answering?.release();
      await waitFor(() => expect(scope.textContent).toContain("The page has three tasks left."));
      const sent = postedCalls(harness, "/chat/stream").map(
        (c) => c.body as { text?: string; oneOff?: boolean },
      );
      expect(sent.map((b) => [b.text, b.oneOff === true])).toEqual([
        ["what is left on the page?", false],
        ["what is left on the page?", true],
      ]);
      // The answer is not held: no press under it.
      expect(within(scope).queryByTestId(`${where}-one-off`)).toBeNull();
    });
  }
});

/**
 * CS-8's Inbox half (coverage: it passed at once, since d1109-cred-engine's ask card already
 * renders through the generic card; it guards the words and what goes over the wire): the ask
 * card shows its title, body and both options with their consequence lines, Use API key first
 * (the lean of "then ask me"), and a click sends the option's string exactly.
 */
describe("d1109-cred-screens, run C: the Inbox's ask card (CS-8)", () => {
  it("title, body, both options with their consequence lines; Use API key sends exactly that", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.requests.unshift({
      id: "req_ask",
      projectId: null,
      projectName: null,
      taskId: null,
      taskTitle: null,
      sessionId: null,
      kind: "approval",
      why: "Use your API key until your Claude subscription can work again?",
      steps: [],
      options: ["Use API key", "Wait"],
      blocking: true,
      risk: "medium",
      changeCard: {
        key: "credential:ask",
        source_id: "bs_subscription_1",
        stop_key: "limit:bs_subscription_1:2026-10-31T14:00:00.000Z",
        credential_kind: "subscription",
        reason: "limit",
        until: "2026-10-31T14:00:00.000Z",
        estimate_usd_micro: 400_000,
        chf_per_usd: 0.8,
        filed_at: "2026-10-31T09:00:00.000Z",
        applied_at: null,
      },
      status: "open",
      answer: null,
      createdAt: "2026-10-31T09:00:00.000Z",
      version: 1,
    } as never);
    renderApp("/inbox", harness);
    const card = (await screen.findAllByTestId("request")).find(
      (r) => r.getAttribute("data-request-id") === "req_ask",
    ) as HTMLElement;
    expect(within(card).getByTestId("request-title")).toHaveTextContent(
      "Use your API key until 15:00?",
    );
    expect(within(card).getByTestId("request-body").textContent).toMatch(
      /^Your Claude subscription is at its limit until 15:00\. /,
    );
    const options = within(card).getAllByTestId("option");
    expect(options.map((b) => b.textContent)).toEqual(["Use API key", "Wait"]);
    const explains = within(card)
      .getAllByTestId("option-explain")
      .map((e) => e.textContent ?? "");
    expect(explains).toHaveLength(2);
    expect(explains[0]).toMatch(/^Your work and chat use your API key until 15:00: about CHF /);
    expect(explains[1]).toMatch(/^Nothing moves until 15:00/);
    await user.click(options[0] as HTMLElement);
    await screen.findByTestId("done-line");
    const answers = postedCalls(harness, "/requests/req_ask/answer").map(
      (c) => (c.body as { answer?: unknown }).answer,
    );
    expect(answers).toEqual(["Use API key"]);
  });
});
