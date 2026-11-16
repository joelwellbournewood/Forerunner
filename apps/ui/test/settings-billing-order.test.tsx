import { clockTime } from "@forerunner/runtime/session/credential-wait";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * Settings and the person's Claude credentials (U-078, ADR 0100; d1109-cred-screens CS-1 and CS-2,
 * ADR 0120 amended 2026-11-16). Before run C's C6, "Claude: which to use first" under Advanced
 * listed the credentials with Move up / Move down; that order is now one of the presets of
 * Basics' "Which Claude does the work" (credential-policy.test.tsx clicks them), whose rows say each
 * credential's role, its state now and its month. Advanced keeps "What each can do here".
 */
const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

describe("Settings: the person's Claude credentials (U-078; d1109-cred-screens)", () => {
  it("each credential's state now and its month, in the section's rows", async () => {
    const resting = new Date(Date.now() + 40 * 60_000).toISOString();
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
    const section = await screen.findByTestId("credential-policy");
    const sub = await within(section).findByTestId("credential-row-subscription");
    // Before (C3-left-9): "Resting until 15:40 (its usage limit); your session that waits for it
    // goes on then", whether or not a session waited.
    expect(within(sub).getByTestId("credential-row-state")).toHaveTextContent(
      `At its limit until ${clockTime(resting, "UTC", Date.now())}`,
    );
    expect(sub).not.toHaveTextContent("your session that waits for it goes on then");
    expect(within(sub).getByTestId("credential-row-month")).toHaveTextContent(
      "42% of this month's allowance used",
    );
    const key = within(section).getByTestId("credential-row-api_key");
    expect(within(key).getByTestId("credential-row-state")).toHaveTextContent("Works now");
    expect(within(key).getByTestId("credential-row-month")).toHaveTextContent(
      "CHF 4.20 this month",
    );
  });

  it("a key or sign-in Anthropic refused reads Refused, with where to save a new one", async () => {
    const harness = createHarness({
      billingOrder: {
        sources: [
          { kind: "subscription", usable: false, blocked: "refused" },
          { kind: "api_key", usable: false, blocked: "refused" },
        ],
      },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const key = await within(section).findByTestId("credential-row-api_key");
    expect(within(key).getByTestId("credential-row-state")).toHaveTextContent(
      "Refused: save a new key",
    );
    expect(within(key).getByRole("link", { name: "Save a new key" })).toHaveAttribute(
      "href",
      "/setup",
    );
    const sub = within(section).getByTestId("credential-row-subscription");
    expect(within(sub).getByTestId("credential-row-state")).toHaveTextContent(
      "Refused: save a new sign-in",
    );
  });

  it("the share and a key's monthly cap: until when, and where the allowance is changed", async () => {
    const harness = createHarness({
      billingOrder: {
        sources: [
          { kind: "subscription", usable: false, blocked: "allowance", planShare: 0.96 },
          { kind: "api_key", usable: false, blocked: "monthly_cap" },
          { kind: "plan_credits", usable: false, blocked: "no_credential" },
        ],
      },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const day = clockTime(nextMonth(), "UTC", Date.now()).replace(/, \d\d:\d\d$/, "");
    const sub = await within(section).findByTestId("credential-row-subscription");
    expect(within(sub).getByTestId("credential-row-state")).toHaveTextContent(
      `Share used until ${day}`,
    );
    expect(within(sub).getByRole("link", { name: "Change the allowance" })).toHaveAttribute(
      "href",
      "/settings#plan-allowance",
    );
    expect(within(section).getByTestId("credential-row-api_key")).toHaveTextContent(
      `Monthly cap reached until ${day}`,
    );
    // Plan credits nobody saved are not listed.
    expect(within(section).queryByTestId("credential-row-plan_credits")).toBeNull();
  });

  it("What each can do here, under Advanced: one row per need, one column per credential, the daemon's words (U-078)", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness());
    await user.click(await screen.findByTestId("settings-advanced-summary"));
    const abilities = await screen.findByTestId("credential-abilities");
    const table = await within(abilities).findByTestId("credential-table");
    expect(within(table).getByTestId("credential-table-api_key")).toHaveTextContent("API key");
    expect(within(table).getByTestId("credential-table-subscription")).toHaveTextContent(
      "Claude subscription",
    );
    const rows = within(table)
      .getAllByTestId("credential-table-row")
      .map((r) => [...r.querySelectorAll("th, td")].map((c) => c.textContent));
    expect(rows).toEqual([
      // Forerunner's page reader on the subscription too ('sites'; before: "Not yet").
      ["Read web pages", "Yes", "Yes"],
      // Anthropic's web search on the API key ('web-search', the owner's decision of 2026-11-02).
      ["Search the web", "Yes", "Yes"],
      ["Run commands (its tests)", "Yes, in the sandbox", "No"],
      ["Ask you while it works", "Yes", "No: it lists its questions in its report"],
      ["What it costs", "Money per use", "Your plan's limits, no money per use"],
    ]);
  });

  it("with only the API key saved the table says the subscription is not saved", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness({ billingOrder: { sources: [{ kind: "api_key" }] } }));
    await user.click(await screen.findByTestId("settings-advanced-summary"));
    const table = await screen.findByTestId("credential-table");
    expect(within(table).getByTestId("credential-table-subscription")).toHaveTextContent(
      "Claude subscription (not saved)",
    );
    expect(within(table).getByTestId("credential-table-api_key")).toHaveTextContent(/^API key$/);
  });

  it("no credential saved while the app answers with the model it was started with: it says so (U-078)", async () => {
    renderApp("/settings", createHarness({ billingOrder: { sources: [] }, startedWith: "bench" }));
    expect(await screen.findByTestId("credential-policy-single")).toHaveTextContent(
      "No Claude credential is saved here; this app answers with a model of its own for now. Save your Claude subscription or an API key to choose which does the work.",
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
    const harness = createHarness({ missingRoutes: ["/settings/credential-policy"] });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    expect(await within(section).findByTestId("route-missing")).toHaveAttribute(
      "data-route",
      "credentialPolicy",
    );
  });
});
