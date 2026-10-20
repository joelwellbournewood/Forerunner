import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { commandForSetting, groupByScope } from "../src/pages/SettingsPage.tsx";
import { SETTINGS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Settings", () => {
  it("groups settings by scope", () => {
    const groups = groupByScope(SETTINGS);
    expect(groups.global.map((s) => s.key)).toEqual(["runtime.provider"]);
    expect(groups.project.map((s) => s.key)).toEqual(["project.autonomy"]);
  });

  it("maps settings to the registry's commands and leaves the rest read-only", () => {
    const autonomy = commandForSetting({
      key: "project.autonomy",
      scope: "project",
      scopeId: "proj_atlas",
      value: 2,
      description: "",
      risk: "medium",
    });
    expect(autonomy?.name).toBe("autonomy.set");
    expect(autonomy?.params("3")).toEqual({ level: 3, project: "proj_atlas" });
    expect(autonomy?.params("7")).toBeNull();
    const cap = commandForSetting({
      key: "human.monthly_cap",
      scope: "human",
      scopeId: "human_alice",
      value: { usdMicro: 187_500_000, chfMicro: 150_000_000 },
      description: "",
      risk: "high",
    });
    expect(cap?.name).toBe("budget.set");
    expect(cap?.initial({ usdMicro: 187_500_000, chfMicro: 150_000_000 })).toBe("150.00");
    expect(cap?.params("200")).toEqual({ scope: "month", amountChf: 200 });
    const budget = commandForSetting({
      key: "project.budget",
      scope: "project",
      scopeId: "proj_atlas",
      value: { usdMicro: 0, chfMicro: 0 },
      description: "",
      risk: "medium",
    });
    expect(budget?.params("12.5")).toEqual({
      scope: "project",
      amountChf: 12.5,
      project: "proj_atlas",
    });
    const spec = commandForSetting({
      key: "project.critic_ceiling",
      scope: "project",
      scopeId: "proj_atlas",
      value: 2,
      description: "",
      risk: "medium",
    });
    expect(spec?.name).toBe("settings.set");
    expect(spec?.params("3")).toEqual({ key: "critic_ceiling", value: 3, project: "proj_atlas" });
    expect(
      commandForSetting({
        key: "runtime.provider",
        scope: "global",
        scopeId: null,
        value: "x",
        description: "",
        risk: "low",
      }),
    ).toBeNull();
  });

  it("shows the scope on every row, the daemon status and the same-command hint", async () => {
    renderApp("/settings");
    const rows = await screen.findAllByTestId("setting-row");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const scope = within(row).getByTestId("setting-scope");
      expect(scope.textContent).toMatch(
        /^(global|human: human_alice|agent: agent_alice|project: proj_atlas)$/,
      );
    }
    expect(screen.getByTestId("scope-group-global")).toBeInTheDocument();
    expect(screen.getByTestId("scope-group-project")).toBeInTheDocument();
    expect(screen.getByTestId("edit-hint")).toHaveTextContent(/asking in chat or voice/);
    const cap = rows.find((r) => r.dataset.key === "human.monthly_cap");
    expect(within(cap as HTMLElement).getByTestId("setting-value-cell")).toHaveTextContent(
      "CHF 150.00",
    );
    expect(within(cap as HTMLElement).getByTestId("setting-change")).toBeInTheDocument();
    const provider = rows.find((r) => r.dataset.key === "runtime.provider");
    expect(provider).toHaveTextContent("read-only");
    const status = screen.getByTestId("daemon-status");
    expect(status).toHaveTextContent("http://127.0.0.1:9");
    expect(status).toHaveTextContent("from env");
    expect(status).toHaveTextContent("present (never shown)");
    expect(status).not.toHaveTextContent("test-token");
    expect(status).toHaveTextContent("v0.1.0-fake");
    expect(within(status).getByTestId("sandbox-health")).toHaveTextContent(
      "process stand-in fake daemon",
    );
    expect(within(status).getByTestId("extensions-health")).toHaveTextContent(
      "3 enabled · 1 waiting for your approval",
    );
  });

  it("changes autonomy by one step through the command registry: card, yes, sentence, undo, change log", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const autonomy = rows.find((r) => r.dataset.key === "project.autonomy");
    await user.click(within(autonomy as HTMLElement).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    await user.clear(input);
    await user.type(input, "3");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [{ name: "autonomy.set", params: { level: 3, project: "proj_atlas" } }],
      wordsUsed: "Settings: project.autonomy to 3",
      projectId: "proj_atlas",
    });
    // Medium risk: the change card, then a yes.
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    expect(within(pending).getByTestId("change-card")).toHaveAttribute("data-risk", "medium");
    expect(within(pending).getByTestId("card-old")).toHaveTextContent("2");
    expect(within(pending).getByTestId("card-new")).toHaveTextContent("3");
    expect(within(pending).getByTestId("command-readback")).toHaveTextContent("Say yes to confirm");
    await user.click(within(pending).getByTestId("command-yes"));
    const confirmCalls = () =>
      postedCalls(harness, `/commands/${postedCallPendingId(harness)}/confirm`);
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0]?.body).toEqual({ answer: "tap" });
    const done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      "Set autonomy for Atlas from 2 to 3. Undo.",
    );
    expect(harness.daemon.state.projects[0]?.autonomyLevel).toBe(3);
    // The change log row is the one voice and chat would write (source aside).
    const entry = harness.daemon.state.changes[0];
    expect(entry?.sentence).toBe("Set autonomy for Atlas from 2 to 3. Undo.");
    expect(entry?.wordsUsed).toBe("Settings: project.autonomy to 3");
    expect(entry?.commands).toEqual([
      { name: "autonomy.set", params: { level: 3, project: "proj_atlas" } },
    ]);
    expect(entry?.before).toEqual({ autonomyLevel: 2 });
    expect(entry?.after).toEqual({ autonomyLevel: 3 });
    await user.click(within(done).getByTestId("command-undo"));
    await waitFor(() => expect(postedCalls(harness, `/changes/${entry?.id}/undo`)).toHaveLength(1));
    expect(await within(dialog).findByTestId("setting-undone")).toHaveTextContent(
      "Undone: Set autonomy for Atlas from 2 to 3.",
    );
    expect(harness.daemon.state.projects[0]?.autonomyLevel).toBe(2);
  });

  it("needs this paired device for a high-risk change and shows a refusal as such", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const cap = rows.find((r) => r.dataset.key === "human.monthly_cap");
    await user.click(within(cap as HTMLElement).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    await user.clear(input);
    await user.type(input, "200");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_device");
    expect(within(pending).getByTestId("needs-device")).toHaveTextContent("paired device");
    await user.click(within(pending).getByTestId("command-yes"));
    const pendingId = postedCallPendingId(harness);
    await waitFor(() =>
      expect(postedCalls(harness, `/commands/${pendingId}/confirm`)).toHaveLength(1),
    );
    expect(postedCalls(harness, `/commands/${pendingId}/confirm`)[0]?.body).toEqual({
      answer: "device",
      deviceId: "test",
    });
    expect(await within(dialog).findByTestId("command-sentence")).toHaveTextContent(
      "Raised the monthly hard ceiling from CHF 150 to CHF 200. Undo.",
    );
  });

  it("shows a cancelled change and a refused one without changing anything", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("setting-row");
    const autonomy = rows.find((r) => r.dataset.key === "project.autonomy");
    await user.click(within(autonomy as HTMLElement).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    await user.clear(input);
    await user.type(input, "1");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    await user.click(within(pending).getByTestId("command-no"));
    expect(await within(dialog).findByTestId("command-cancelled")).toHaveTextContent(
      "Nothing changed",
    );
    expect(harness.daemon.state.projects[0]?.autonomyLevel).toBe(2);
    expect(harness.daemon.state.changes).toHaveLength(2);
  });
});

/** The pending id the fake handed out last (the confirm path carries it). */
function postedCallPendingId(harness: ReturnType<typeof createHarness>): string {
  const ids = [...harness.daemon.state.pendingCommands.keys()];
  const last = ids[ids.length - 1];
  if (last) return last;
  const confirm = harness.daemon.state.calls.find((c) =>
    /\/commands\/[^/]+\/confirm$/.test(c.path),
  );
  return confirm?.path.split("/")[2] ?? "";
}
