import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { groupByScope } from "../src/pages/SettingsPage.tsx";
import { SETTINGS } from "./fixtures.ts";
import { renderApp } from "./helpers.tsx";

describe("Settings", () => {
  it("groups settings by scope", () => {
    const groups = groupByScope(SETTINGS);
    expect(groups.global.map((s) => s.key)).toEqual(["session.step_cap"]);
    expect(groups.project.map((s) => s.key)).toEqual(["autonomy.level"]);
  });

  it("shows the scope on every row, the daemon status and the edit-via-chat hint", async () => {
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
    expect(screen.getByTestId("edit-hint")).toHaveTextContent(/asking in chat/);
    const status = screen.getByTestId("daemon-status");
    expect(status).toHaveTextContent("http://127.0.0.1:9");
    expect(status).toHaveTextContent("from env");
    expect(status).toHaveTextContent("present (never shown)");
    expect(status).not.toHaveTextContent("test-token");
    expect(status).toHaveTextContent("v0.1.0-fake");
    expect(within(status).getByTestId("sandbox-health")).toHaveTextContent(
      "process stand-in fake daemon",
    );
    expect(within(status).getByTestId("extensions-health")).toHaveTextContent("0 enabled");
  });

  it("placeholder pages name the phase that fills them", async () => {
    renderApp("/memory");
    expect(await screen.findByTestId("placeholder")).toHaveAttribute("data-phase", "4");
    expect(screen.getByTestId("placeholder")).toHaveTextContent("Coming with phase 4.");
  });
});
