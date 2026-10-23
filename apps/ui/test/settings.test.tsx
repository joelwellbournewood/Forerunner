import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { commandForSetting, groupByScope } from "../src/pages/SettingsPage.tsx";
import { ME, SETTINGS } from "./fixtures.ts";
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
    // The monthly jobs' settings are objects (ADR 0060): shown and edited as JSON.
    const handover = commandForSetting({
      key: "project.handover",
      scope: "project",
      scopeId: "proj_atlas",
      value: { enabled: false },
      description: "",
      risk: "medium",
    });
    expect(handover?.name).toBe("settings.set");
    expect(handover?.initial({ enabled: false })).toBe('{"enabled":false}');
    expect(handover?.params('{"enabled": true, "day": 2, "time": "08:00"}')).toEqual({
      key: "handover",
      value: { enabled: true, day: 2, time: "08:00" },
      project: "proj_atlas",
    });
    const calibration = commandForSetting({
      key: "human.calibration",
      scope: "human",
      scopeId: "human_alice",
      value: null,
      description: "",
      risk: "medium",
    });
    expect(calibration?.params('{"enabled":false}')).toEqual({
      key: "calibration",
      value: { enabled: false },
    });
    // Text that only looks like JSON stays text.
    expect(calibration?.params("{not json")).toEqual({ key: "calibration", value: "{not json" });
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
    expect(within(status).getByTestId("desktop-device")).toHaveTextContent(
      `paired device ${ME.desktopDeviceId}`,
    );
    expect(within(status).getByTestId("sandbox-health")).toHaveTextContent(
      "process stand-in fake daemon",
    );
    expect(within(status).getByTestId("extensions-health")).toHaveTextContent(
      "4 enabled · 1 waiting for your approval",
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
    // The settings screen names its channel (RT-P5-4): the row is logged as `ui`, not `chat`.
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [{ name: "autonomy.set", params: { level: 3, project: "proj_atlas" } }],
      wordsUsed: "Settings: project.autonomy to 3",
      source: "ui",
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
    // The change log row is the one voice and chat would write, with its own source.
    const entry = harness.daemon.state.changes[0];
    expect(entry?.source).toBe("ui");
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
    // The device named is this PC's own row as `/me` names it (ADR 0030), never the shell's
    // install id: the daemon knows the row, not the shell.
    expect(postedCalls(harness, `/commands/${pendingId}/confirm`)[0]?.body).toEqual({
      answer: "device",
      deviceId: ME.desktopDeviceId,
    });
    expect(await within(dialog).findByTestId("command-sentence")).toHaveTextContent(
      "Raised the monthly hard ceiling from CHF 150 to CHF 200. Undo.",
    );
  });

  it("shows the daemon's refusal when the device it names is not paired, and the card stays open", async () => {
    // A daemon that names a row this fake does not know (a stale `/me`, another install's
    // row): the fake refuses like the real executor does, the dialog shows it as a refusal
    // and nothing changed.
    const user = userEvent.setup();
    const harness = createHarness({ me: { desktopDeviceId: "device_from_another_install" } });
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
    await user.click(within(pending).getByTestId("command-yes"));
    const pendingId = postedCallPendingId(harness);
    await waitFor(() =>
      expect(postedCalls(harness, `/commands/${pendingId}/confirm`)).toHaveLength(1),
    );
    expect(postedCalls(harness, `/commands/${pendingId}/confirm`)[0]?.body).toEqual({
      answer: "device",
      deviceId: "device_from_another_install",
    });
    expect(await within(dialog).findByTestId("command-refused")).toHaveTextContent(
      "Refused (approval_required): unknown device; pair it first",
    );
    expect(harness.daemon.state.pendingCommands.has(pendingId)).toBe(true);
    expect(harness.daemon.state.changes).toHaveLength(2);
  });

  it("confirms without a device id while /me is not loaded, and the daemon answers with its own row", async () => {
    // `/me` failed (or has not answered yet) while the daemon has its desktop row: the dialog
    // sends the device answer without an id and the daemon-token route answers with that row.
    const user = userEvent.setup();
    const harness = createHarness({
      failing: { "/me": { status: 503, code: "unavailable", message: "me down" } },
    });
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
    await user.click(within(pending).getByTestId("command-yes"));
    const pendingId = postedCallPendingId(harness);
    await waitFor(() =>
      expect(postedCalls(harness, `/commands/${pendingId}/confirm`)).toHaveLength(1),
    );
    expect(postedCalls(harness, `/commands/${pendingId}/confirm`)[0]?.body).toEqual({
      answer: "device",
    });
    expect(await within(dialog).findByTestId("command-sentence")).toHaveTextContent(
      "Raised the monthly hard ceiling from CHF 150 to CHF 200. Undo.",
    );
  });

  it("says a daemon without a desktop row cannot confirm here and shows its refusal, nothing changed", async () => {
    // A daemon whose `/me` names no row (one composed without its services) refuses an
    // id-less device answer with 409 `conflict`, as the real route does: the status line says
    // so, the dialog shows the daemon's message and the card stays pending.
    const user = userEvent.setup();
    const harness = createHarness({ me: { desktopDeviceId: null } });
    renderApp("/settings", harness);
    expect(await screen.findByTestId("desktop-device")).toHaveTextContent(
      "high-risk changes cannot be confirmed on this PC",
    );
    const rows = await screen.findAllByTestId("setting-row");
    const cap = rows.find((r) => r.dataset.key === "human.monthly_cap");
    await user.click(within(cap as HTMLElement).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    await user.clear(input);
    await user.type(input, "200");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    await user.click(within(pending).getByTestId("command-yes"));
    const pendingId = postedCallPendingId(harness);
    await waitFor(() =>
      expect(postedCalls(harness, `/commands/${pendingId}/confirm`)).toHaveLength(1),
    );
    expect(postedCalls(harness, `/commands/${pendingId}/confirm`)[0]?.body).toEqual({
      answer: "device",
    });
    expect(await within(dialog).findByTestId("error-banner")).toHaveTextContent(
      "no desktop device row to answer for",
    );
    expect(within(dialog).queryByTestId("command-sentence")).toBeNull();
    expect(harness.daemon.state.pendingCommands.has(pendingId)).toBe(true);
    expect(harness.daemon.state.changes).toHaveLength(2);
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
