import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { asChf, commandForSetting, moneyProblem } from "../src/pages/SettingsPage.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Money in Settings (design §6; walk lifecycle shots project-budget-2, monthly-cap-prefilled):
 * the project budget took only multiples of 0.50 and the monthly cap only whole francs, so the
 * default the field showed (150.40) was refused by the browser before anything was sent; and
 * closing a high-risk preview with x left its "approval needed" card behind.
 */
describe("money in Settings (design §6)", () => {
  it("any amount with a point or a comma; 0 and negatives are refused in words", () => {
    expect(asChf("12.30")).toBe(12.3);
    expect(asChf("150.40")).toBe(150.4);
    expect(asChf("1,50")).toBe(1.5);
    expect(asChf("CHF 5")).toBe(5);
    expect(asChf("0")).toBeNull();
    expect(moneyProblem("0")).toBe("The amount must be more than CHF 0.");
    expect(moneyProblem("-3")).toBe("The amount must be more than CHF 0.");
    expect(moneyProblem("abc")).toBe("Type an amount in CHF, like 12.30 or 12,30.");
    expect(moneyProblem("150.40")).toBeNull();
    const budget = commandForSetting({
      key: "project.budget",
      scope: "project",
      scopeId: "proj_atlas",
      value: { usdMicro: 0, chfMicro: 0 },
      description: "",
      risk: "medium",
    });
    expect(budget?.inputType).toBe("money");
    expect(budget?.params("12,30")).toEqual({
      scope: "project",
      amountChf: 12.3,
      project: "proj_atlas",
    });
  });

  it("the monthly cap takes 150.40 typed as shown and sends it; the field is text, not a stepped number", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const cap = rows.find((r) => r.dataset.key === "human.monthly_cap") as HTMLElement;
    await user.click(within(cap).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).not.toHaveAttribute("step");
    await user.clear(input);
    await user.type(input, "0");
    expect(within(dialog).getByTestId("setting-value-problem")).toHaveTextContent(
      "The amount must be more than CHF 0.",
    );
    expect(within(dialog).getByTestId("setting-apply")).toBeDisabled();
    await user.clear(input);
    await user.type(input, "150,40");
    expect(within(dialog).queryByTestId("setting-value-problem")).toBeNull();
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 150.4 } }],
    });
  });

  it("an in-app link to a section lands on it: /settings#sandbox (wave 2 handoff: Set up Docker)", async () => {
    renderApp("/settings#sandbox");
    const card = await screen.findByTestId("sandbox-settings");
    await waitFor(() => expect(card).toHaveAttribute("data-targeted", "true"));
  });

  it("closing a preview that waits for a Yes answers it no: no card is left waiting", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const cap = rows.find((r) => r.dataset.key === "human.monthly_cap") as HTMLElement;
    await user.click(within(cap).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    await user.clear(input);
    await user.type(input, "200");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await within(dialog).findByTestId("command-pending");
    const pendingId = [...harness.daemon.state.pendingCommands.keys()].at(-1) ?? "";
    expect(pendingId).not.toBe("");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(postedCalls(harness, `/commands/${pendingId}/confirm`)).toHaveLength(1),
    );
    expect(postedCalls(harness, `/commands/${pendingId}/confirm`)[0]?.body).toEqual({
      answer: "no",
    });
    await waitFor(() => expect(harness.daemon.state.pendingCommands.has(pendingId)).toBe(false));
  });
});
