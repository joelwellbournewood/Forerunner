import { clockTime } from "@forerunner/runtime/session/credential-wait";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-cred-screens (run C, C6), CS-1 and CS-2 (ADR 0120 amended 2026-11-16; the owner's answer 4
 * of 2026-11-09: "it should use the order that the user specifies ... There should be a nice
 * clean options menu", and 7a: "give a framework for what to use when, and then the system just
 * does it"): Settings -> Basics -> "Which Claude does the work" is the one place for the choice.
 * Each case clicks what a person clicks and asserts what appears and what is sent.
 */

const executed = (harness: ReturnType<typeof createHarness>) =>
  postedCalls(harness, "/commands/execute").map(
    (c) => (c.body as { commands: { params: unknown }[] }).commands[0]?.params,
  );

describe("d1109-cred-screens, run C: Which Claude does the work (CS-1)", () => {
  it("not chosen yet: the default preset selected and marked as used until you choose; the rows in its order", async () => {
    renderApp("/settings", createHarness());
    const section = await screen.findByTestId("credential-policy");
    // Right under Accounts and keys, in Basics.
    const basics = screen.getByTestId("settings-basics");
    expect(within(basics).getByTestId("credential-policy")).toBe(section);
    expect(
      within(section).getByRole("heading", { name: "Which Claude does the work" }),
    ).toBeTruthy();
    const radios = await within(section).findAllByRole("radio");
    expect(radios).toHaveLength(5);
    const labels = [
      "subscription_then_wait",
      "subscription_then_ask",
      "subscription_then_key",
      "key_then_subscription",
      "key_only",
    ].map(
      (id) =>
        within(section).getByTestId(`credential-preset-${id}`).querySelector(".font-medium")
          ?.textContent,
    );
    expect(labels).toEqual([
      "Subscription first, then wait",
      "Subscription first, ask before API key",
      "Subscription first, then API key",
      "API key first, then subscription",
      "API key only",
    ]);
    const wait = within(section).getByTestId("credential-preset-subscription_then_wait");
    expect(within(wait).getByRole("radio")).toBeChecked();
    expect(within(wait).getByTestId("credential-policy-default")).toHaveTextContent(
      "Used until you choose: your subscription first for everything it can do here; when it runs out, the work waits.",
    );
    const rows = within(section)
      .getAllByTestId(/^credential-row-(subscription|api_key)$/)
      .map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["credential-row-subscription", "credential-row-api_key"]);
    const sub = within(section).getByTestId("credential-row-subscription");
    expect(within(sub).getByTestId("credential-row-role")).toHaveTextContent("Does the work");
    expect(within(sub).getByTestId("credential-row-state")).toHaveTextContent("Works now");
    expect(within(sub).getByTestId("credential-row-month")).toHaveTextContent(
      "0% of this month's allowance used",
    );
    const key = within(section).getByTestId("credential-row-api_key");
    expect(within(key).getByTestId("credential-row-role")).toHaveTextContent(
      "Only for a task your subscription cannot do",
    );
    expect(within(key).getByTestId("credential-row-month")).toHaveTextContent(
      "CHF 0.00 this month",
    );
    expect(within(section).getByTestId("credential-policy-now")).toHaveTextContent(
      "If your subscription runs out, the work waits for it.",
    );
    expect(section).toHaveTextContent(
      "Runs out means: its usage limit is reached, the share of your subscription Forerunner may use is used, or Anthropic refuses it.",
    );
  });

  it("choosing the default stores it as your choice: one change, no yes, and the 'used until' line goes", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const wait = await within(section).findByTestId("credential-preset-subscription_then_wait");
    await user.click(within(wait).getByRole("radio"));
    expect(await within(section).findByTestId("credential-policy-saved")).toHaveTextContent(
      "Saved. It is in Changes, where you can undo it.",
    );
    expect(executed(harness)).toEqual([
      { key: "credential_policy", value: "subscription_then_wait" },
    ]);
    expect(within(section).queryByTestId("credential-policy-confirm")).toBeNull();
    await waitFor(() =>
      expect(within(section).queryByTestId("credential-policy-default")).toBeNull(),
    );
    expect(harness.daemon.state.settingValues.credential_policy).toBe("subscription_then_wait");
  });

  it("a preset that moves less money acts at once and the section shows its new now line without a reload", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ credentialPolicy: { stored: "subscription_then_key" } });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    expect(await within(section).findByTestId("credential-policy-now")).toHaveTextContent(
      "If your subscription runs out, the work goes on with your API key (costs money).",
    );
    const ask = within(section).getByTestId("credential-preset-subscription_then_ask");
    await user.click(within(ask).getByRole("radio"));
    await waitFor(() =>
      expect(within(section).getByTestId("credential-policy-now")).toHaveTextContent(
        "If your subscription runs out, you are asked before your API key is used.",
      ),
    );
    expect(within(ask).getByRole("radio")).toBeChecked();
    expect(executed(harness)).toEqual([
      { key: "credential_policy", value: "subscription_then_ask" },
    ]);
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({ source: "ui" });
    expect(within(section).getByTestId("credential-row-api_key")).toHaveTextContent(
      "After you say yes, when your subscription runs out",
    );
  });

  it("a preset that moves more money shows the change card's yes and changes nothing until Change", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const key = await within(section).findByTestId("credential-preset-subscription_then_key");
    await user.click(within(key).getByRole("radio"));
    const confirm = await within(section).findByTestId("credential-policy-confirm");
    expect(within(confirm).getByTestId("credential-policy-readback")).toHaveTextContent(
      "Set which Claude does the work to Subscription first, then API key? When your subscription runs out, work goes on with your API key at once, at a cost per use.",
    );
    // Nothing stored yet: the default is still the one selected.
    expect(harness.daemon.state.settingValues.credential_policy).toBeUndefined();
    expect(within(key).getByRole("radio")).not.toBeChecked();
    await user.click(within(confirm).getByRole("button", { name: "Change" }));
    await waitFor(() => expect(within(key).getByRole("radio")).toBeChecked());
    expect(harness.daemon.state.settingValues.credential_policy).toBe("subscription_then_key");
    const confirms = harness.daemon.state.calls.filter((c) => c.path.endsWith("/confirm"));
    expect(confirms.map((c) => c.body)).toEqual([{ answer: "tap" }]);
  });

  it("Cancel on the yes sends no and keeps the preset", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const only = await within(section).findByTestId("credential-preset-key_only");
    await user.click(within(only).getByRole("radio"));
    const confirm = await within(section).findByTestId("credential-policy-confirm");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(within(section).queryByTestId("credential-policy-confirm")).toBeNull(),
    );
    expect(harness.daemon.state.settingValues.credential_policy).toBeUndefined();
    expect(
      within(within(section).getByTestId("credential-preset-subscription_then_wait")).getByRole(
        "radio",
      ),
    ).toBeChecked();
  });

  it("an earlier 'API key first' with use the other one reads as 'API key first, then subscription', with no new change", async () => {
    const harness = createHarness({
      billingOrder: { order: ["api_key", "subscription"] },
      credentialPolicy: { midSessionLimit: "use_other" },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const d = await within(section).findByTestId("credential-preset-key_then_subscription");
    expect(within(d).getByRole("radio")).toBeChecked();
    expect(within(section).queryByTestId("credential-policy-default")).toBeNull();
    expect(postedCalls(harness, "/commands/execute")).toHaveLength(0);
    expect(within(section).getAllByTestId(/^credential-row-/)[0]).toHaveAttribute(
      "data-testid",
      "credential-row-api_key",
    );
  });

  it("an earlier 'API key first' with wait selects none and says the earlier choice", async () => {
    const harness = createHarness({
      billingOrder: { order: ["api_key", "subscription"] },
      credentialPolicy: { midSessionLimit: "wait" },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    expect(await within(section).findByTestId("credential-policy-earlier")).toHaveTextContent(
      "Your earlier choice: your API key first, your subscription only for a task your key cannot do here. When your key runs out, the work waits.",
    );
    for (const r of within(section).getAllByRole("radio")) expect(r).not.toBeChecked();
  });

  it("with a yes standing the now line says so, and Stop using it ends it (the next pick waits)", async () => {
    const user = userEvent.setup();
    const until = new Date(Date.now() + 40 * 60_000).toISOString();
    const harness = createHarness({
      billingOrder: {
        sources: [
          {
            kind: "subscription",
            usable: false,
            blocked: "resting",
            restingUntil: until,
            planShare: 0.34,
          },
          { kind: "api_key", monthSpent: { usdMicro: 2_625_000, chfMicro: 2_100_000 } },
        ],
      },
      credentialPolicy: { stored: "subscription_then_ask", grant: true },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("credential-policy");
    const at = clockTime(until, "UTC", Date.now());
    const now = await within(section).findByTestId("credential-policy-now");
    expect(now).toHaveTextContent(`Your work and chat use your API key until ${at}: you said yes.`);
    const sub = within(section).getByTestId("credential-row-subscription");
    expect(within(sub).getByTestId("credential-row-state")).toHaveTextContent(
      `At its limit until ${at}`,
    );
    expect(within(sub).getByTestId("credential-row-month")).toHaveTextContent(
      "34% of this month's allowance used",
    );
    expect(within(section).getByTestId("credential-row-api_key")).toHaveTextContent(
      "CHF 2.10 this month",
    );
    await user.click(within(now).getByRole("button", { name: "Stop using it" }));
    await waitFor(() =>
      expect(within(section).getByTestId("credential-policy-now")).toHaveTextContent(
        `Your subscription is at its limit until ${at}; the work waits for it.`,
      ),
    );
    expect(postedCalls(harness, "/settings/credential-policy/grant/end")).toHaveLength(1);
  });

  it("with only the subscription saved the presets fold into one sentence with where to save a key", async () => {
    renderApp(
      "/settings",
      createHarness({ billingOrder: { sources: [{ kind: "subscription" }] } }),
    );
    const single = await screen.findByTestId("credential-policy-single");
    expect(single).toHaveTextContent(
      "Only your Claude subscription is saved: it does the work; when it runs out the work waits for its reset, and a session you started goes on then. Save an API key to choose what happens then.",
    );
    expect(within(single).getByRole("link", { name: "Save an API key" })).toHaveAttribute(
      "href",
      "/setup",
    );
    expect(within(screen.getByTestId("credential-policy")).queryAllByRole("radio")).toHaveLength(0);
  });
});

describe("d1109-cred-screens, run C: Advanced keeps what each can do here (CS-2)", () => {
  it("no order list, no Move up, no 'When my first choice runs out' row; the table and its summary words", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness());
    const advanced = await screen.findByTestId("settings-advanced");
    expect(within(advanced).getByTestId("settings-advanced-summary")).toHaveTextContent(
      "models, what each Claude credential can do here, the subscription allowance",
    );
    expect(within(advanced).getByTestId("settings-advanced-summary")).not.toHaveTextContent(
      "which Claude credential is used first",
    );
    await user.click(within(advanced).getByTestId("settings-advanced-summary"));
    expect(await within(advanced).findByTestId("credential-table")).toBeTruthy();
    expect(within(advanced).queryByRole("button", { name: /Move .* up/ })).toBeNull();
    expect(screen.queryByTestId("billing-order-section")).toBeNull();
    expect(document.body).not.toHaveTextContent("When my first choice runs out mid-session");
    expect(document.body).not.toHaveTextContent("Claude: which to use first");
  });
});
