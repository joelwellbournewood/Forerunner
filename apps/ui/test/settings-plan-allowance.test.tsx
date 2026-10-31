import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings -> Claude subscription allowance (U-052): 1.0.4 fixed the allowance at the USD 50
 * default in the installed app, so a Max subscriber's tasks stopped early. The section shows the
 * allowance in CHF, the person types what the plan covers and Save sends CHF; the daemon stores
 * USD. When FORERUNNER_PLAN_USD_MONTHLY decides, the field says so and cannot be saved.
 */
describe("Settings -> Claude subscription allowance (U-052)", () => {
  it("shows the default in CHF, saves what the person types and says when it applies", async () => {
    const user = userEvent.setup();
    const harness = createHarness({
      setup: { credentials: { github: true, anthropicApiKey: false, subscription: true } },
    });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("plan-allowance-section");
    expect(
      within(section).getByRole("heading", { name: "Claude subscription allowance" }),
    ).toBeInTheDocument();
    expect(await within(section).findByTestId("plan-allowance-current")).toHaveTextContent(
      "Now: CHF 40.00 a month (the default), stored as USD 50.00 at today's rate.",
    );
    const input = within(section).getByTestId("plan-allowance-input");
    expect(input).toHaveValue("40");

    await user.clear(input);
    await user.type(input, "160");
    await user.click(within(section).getByTestId("plan-allowance-save"));
    expect(await within(section).findByTestId("plan-allowance-saved")).toHaveTextContent(
      "Saved. Subscription work stops at 95% of CHF 160.00 a month, from the next task on.",
    );
    expect(within(section).getByTestId("plan-allowance-current")).toHaveTextContent(
      "Now: CHF 160.00 a month, stored as USD 200.00 at today's rate.",
    );
    expect(postedCalls(harness, "/settings/plan-allowance").map((c) => c.body)).toEqual([
      { chfMonthly: 160 },
    ]);
  });

  it("an empty or zero amount cannot be saved; the daemon's refusal shows in its words", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("plan-allowance-section");
    const input = await within(section).findByTestId("plan-allowance-input");
    expect(within(section).getByTestId("plan-allowance-no-subscription")).toHaveTextContent(
      "No Claude subscription is connected.",
    );
    await user.clear(input);
    expect(within(section).getByTestId("plan-allowance-save")).toBeDisabled();
    await user.type(input, "0");
    expect(within(section).getByTestId("plan-allowance-save")).toBeDisabled();
    expect(postedCalls(harness, "/settings/plan-allowance")).toHaveLength(0);
  });

  it("when the environment variable decides, the field says so and stays locked", async () => {
    const harness = createHarness({ planAllowanceOverridden: true });
    renderApp("/settings", harness);
    const section = await screen.findByTestId("plan-allowance-section");
    expect(await within(section).findByTestId("plan-allowance-overridden")).toHaveTextContent(
      "FORERUNNER_PLAN_USD_MONTHLY sets it on this computer",
    );
    await waitFor(() => expect(within(section).getByTestId("plan-allowance-input")).toBeDisabled());
    expect(within(section).getByTestId("plan-allowance-save")).toBeDisabled();
  });
});
