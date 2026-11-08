import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../src/lib/time.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings -> Claude: which to use first (U-078, ADR 0100). The person sees their Claude
 * credentials in the order every call uses them, how each is used (a subscription through
 * Claude Code; an API key straight to the API, where promotional credits apply), whether it
 * can be used now and what it spent this month; Move up / Move down sends the new order, which
 * the daemon stores (and Changes lists with Undo).
 */
const rowsInOrder = (section: HTMLElement) =>
  within(section)
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-testid"));

describe("Settings -> Claude: which to use first (U-078)", () => {
  it("lists the credentials with how they are used, whether they can be used now and what they spent", async () => {
    const resting = "2026-10-31T14:00:00.000Z";
    const harness = createHarness({
      billingOrder: {
        sources: [
          {
            kind: "subscription",
            usable: false,
            blocked: "resting",
            restingUntil: resting,
            planShare: 0.42,
          },
          {
            kind: "api_key",
            monthSpent: { usdMicro: 5_250_000, chfMicro: 4_200_000 },
            monthlyCap: { usdMicro: 62_500_000, chfMicro: 50_000_000 },
          },
        ],
      },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("billing-order-section");
    expect(
      within(section).getByRole("heading", { name: "Claude: which to use first" }),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent("When one cannot be used, the next one is.");
    // U-078 (the owner's decision of 2026-11-02, which replaced C-64's "research on the API key
    // first"): the person's order decides; another one only when the first cannot do a task.
    expect(section).toHaveTextContent(
      "A task goes to another one only when the first cannot do it properly (research that must read web pages, a task that must ask you while it works); the plan card and New task say so.",
    );
    expect(section).not.toHaveTextContent("research task uses the API key first");
    expect(await within(section).findByTestId("billing-order-default")).toHaveTextContent(
      "You have not chosen an order yet: tasks use the subscription first, and Chat, project setup and reviews use the API key first. Moving one sets this order for everything.",
    );
    const sub = within(section).getByTestId("billing-order-row-subscription");
    expect(sub).toHaveTextContent("1. Claude subscription");
    expect(within(sub).getByTestId("billing-order-how")).toHaveTextContent("Through Claude Code");
    expect(within(sub).getByTestId("billing-order-status")).toHaveTextContent(
      // U-078: what happens to the work that waits for it.
      `Resting until ${formatDateTime(resting)} (its usage limit); waiting work starts by itself then`,
    );
    expect(within(sub).getByTestId("billing-order-spent")).toHaveTextContent(
      "42% of the allowance used this month",
    );
    const key = within(section).getByTestId("billing-order-row-api_key");
    expect(key).toHaveTextContent("2. API key");
    expect(within(key).getByTestId("billing-order-how")).toHaveTextContent(
      "Straight to the API: promotional credits apply",
    );
    expect(within(key).getByTestId("billing-order-status")).toHaveTextContent("Can be used now");
    expect(within(key).getByTestId("billing-order-spent")).toHaveTextContent(
      "CHF 4.20 this month of CHF 50.00",
    );
    // The first row cannot move up, the last cannot move down.
    expect(
      within(section).getByRole("button", { name: "Move Claude subscription up" }),
    ).toBeDisabled();
    expect(within(section).getByRole("button", { name: "Move API key down" })).toBeDisabled();
  });

  it("a key Anthropic refused reads Refused, with where to save a new one (U-078)", async () => {
    const harness = createHarness({
      billingOrder: {
        sources: [
          { kind: "subscription", usable: false, blocked: "refused" },
          { kind: "api_key", usable: false, blocked: "refused" },
        ],
      },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("billing-order-section");
    const key = await within(section).findByTestId("billing-order-row-api_key");
    expect(within(key).getByTestId("billing-order-status")).toHaveTextContent(
      "Refused: Anthropic did not accept this key. Save a new one under Accounts and keys",
    );
    const sub = within(section).getByTestId("billing-order-row-subscription");
    expect(within(sub).getByTestId("billing-order-status")).toHaveTextContent(
      "Refused: Anthropic did not accept this sign-in. Save a new one under Accounts and keys",
    );
  });

  it("Move up puts the API key first, sends the order the daemon expects and shows it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("billing-order-section");
    await within(section).findByTestId("billing-order-row-api_key");
    expect(rowsInOrder(section)).toEqual([
      "billing-order-row-subscription",
      "billing-order-row-api_key",
    ]);

    await user.click(within(section).getByRole("button", { name: "Move API key up" }));
    expect(await within(section).findByTestId("billing-order-saved")).toHaveTextContent(
      "Saved: the API key, then the Claude subscription. It is in Changes, where you can undo it.",
    );
    expect(postedCalls(harness, "/settings/billing-order").map((c) => c.body)).toEqual([
      { order: ["api_key", "subscription"] },
    ]);
    expect(rowsInOrder(section)).toEqual([
      "billing-order-row-api_key",
      "billing-order-row-subscription",
    ]);
    expect(within(section).getByTestId("billing-order-row-api_key")).toHaveTextContent(
      "1. API key",
    );
    // The order is chosen now: the note about the defaults is gone.
    expect(within(section).queryByTestId("billing-order-default")).toBeNull();

    // Move down on the first row puts it back.
    await user.click(within(section).getByRole("button", { name: "Move API key down" }));
    await waitFor(() =>
      expect(rowsInOrder(section)).toEqual([
        "billing-order-row-subscription",
        "billing-order-row-api_key",
      ]),
    );
    expect(postedCalls(harness, "/settings/billing-order").map((c) => c.body)).toEqual([
      { order: ["api_key", "subscription"] },
      { order: ["subscription", "api_key"] },
    ]);
  });

  it("says why a credential cannot be used now", async () => {
    const harness = createHarness({
      billingOrder: {
        order: ["api_key", "subscription", "plan_credits"],
        sources: [
          { kind: "subscription", usable: false, blocked: "allowance", planShare: 0.96 },
          { kind: "api_key", usable: false, blocked: "monthly_cap" },
          { kind: "plan_credits", usable: false, blocked: "no_credential" },
        ],
      },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("billing-order-section");
    const status = async (kind: string) =>
      within(await within(section).findByTestId(`billing-order-row-${kind}`)).getByTestId(
        "billing-order-status",
      );
    expect(await status("subscription")).toHaveTextContent(
      "Not now: this month's allowance is reached",
    );
    expect(await status("api_key")).toHaveTextContent("Not now: its monthly cap is reached");
    expect(await status("plan_credits")).toHaveTextContent("Not now: no key is saved");
    expect(rowsInOrder(section)).toEqual([
      "billing-order-row-api_key",
      "billing-order-row-subscription",
      "billing-order-row-plan_credits",
    ]);
  });

  it("What each can do here: one row per need, one column per credential, the daemon's words (U-078)", async () => {
    renderApp("/settings", createHarness());
    const section = await screen.findByTestId("billing-order-section");
    const table = await within(section).findByTestId("credential-table");
    expect(
      within(table).getByRole("heading", { name: "What each can do here", hidden: true }),
    ).toBeInTheDocument();
    expect(within(table).getByTestId("credential-table-api_key")).toHaveTextContent("API key");
    expect(within(table).getByTestId("credential-table-subscription")).toHaveTextContent(
      "Claude subscription",
    );
    const rows = within(table)
      .getAllByTestId("credential-table-row")
      .map((r) => [...r.querySelectorAll("th, td")].map((c) => c.textContent));
    expect(rows).toEqual([
      ["Read web pages", "Yes", "Not yet"],
      ["Search the web", "Not yet", "Yes"],
      ["Run commands (its tests)", "Yes, in the sandbox", "No"],
      ["Ask you while it works", "Yes", "No: it lists its questions in its report"],
      ["What it costs", "Money per use", "Your plan's limits, no money per use"],
    ]);
  });

  it("with only the API key saved the table says the subscription is not saved", async () => {
    renderApp("/settings", createHarness({ billingOrder: { sources: [{ kind: "api_key" }] } }));
    const table = await screen.findByTestId("credential-table");
    expect(within(table).getByTestId("credential-table-subscription")).toHaveTextContent(
      "Claude subscription (not saved)",
    );
    expect(within(table).getByTestId("credential-table-api_key")).toHaveTextContent(/^API key$/);
  });

  it("no credential saved while the app answers with the model it was started with: it says so, not only 'none saved' (U-078)", async () => {
    renderApp("/settings", createHarness({ billingOrder: { sources: [] }, startedWith: "bench" }));
    const section = await screen.findByTestId("billing-order-section");
    expect(await within(section).findByTestId("billing-order-empty")).toHaveTextContent(
      "No Claude credential is saved here. This app was started with a model of its own, which answers for now, so there is no order to choose. To use your own, add your subscription token or an API key under Accounts and keys.",
    );
  });

  it("Accounts and keys does not say 'connected' for a key Anthropic refused, and offers Save a new key (U-078)", async () => {
    const harness = createHarness({
      billingOrder: { sources: [{ kind: "api_key", usable: false, blocked: "refused" }] },
      setup: { credentials: { github: false, anthropicApiKey: true, subscription: false } },
    });
    renderApp("/settings", harness);
    const accounts = await screen.findByTestId("settings-accounts");
    const refused = await within(accounts).findByTestId("account-claude-refused");
    expect(refused).toHaveTextContent("Anthropic refused your API key.");
    expect(within(refused).getByRole("link", { name: "Save a new key" })).toHaveAttribute(
      "href",
      "/setup",
    );
    expect(within(accounts).getByTestId("account-claude")).toHaveTextContent(
      "Claude: not connected",
    );
    expect(within(accounts).getByTestId("account-claude")).not.toHaveTextContent("connected (");
  });

  it("a refused API key beside a working subscription: connected through the subscription, the key refused", async () => {
    const harness = createHarness({
      billingOrder: {
        sources: [{ kind: "subscription" }, { kind: "api_key", usable: false, blocked: "refused" }],
      },
      setup: { credentials: { github: true, anthropicApiKey: true, subscription: true } },
    });
    renderApp("/settings", harness);
    const accounts = await screen.findByTestId("settings-accounts");
    await within(accounts).findByTestId("account-claude-refused");
    expect(within(accounts).getByTestId("account-claude")).toHaveTextContent(
      "Claude: connected (subscription)",
    );
  });

  it("a daemon without the route shows what is missing, not an empty section", async () => {
    const harness = createHarness({ missingRoutes: ["/settings/billing-order"] });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("billing-order-section");
    expect(await within(section).findByTestId("route-missing")).toHaveAttribute(
      "data-route",
      "billingOrder",
    );
  });
});
