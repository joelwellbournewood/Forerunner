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
    expect(await within(section).findByTestId("billing-order-default")).toHaveTextContent(
      "You have not chosen an order yet: tasks use the subscription first, and Chat, project setup and reviews use the API key first.",
    );
    const sub = within(section).getByTestId("billing-order-row-subscription");
    expect(sub).toHaveTextContent("1. Claude subscription");
    expect(within(sub).getByTestId("billing-order-how")).toHaveTextContent("Through Claude Code");
    expect(within(sub).getByTestId("billing-order-status")).toHaveTextContent(
      `Resting until ${formatDateTime(resting)} after a usage limit`,
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
