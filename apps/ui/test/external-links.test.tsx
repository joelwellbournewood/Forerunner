import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/store/store.ts";
import { createHarness, renderApp, testConfig } from "./helpers.tsx";

/** Every source file of the UI, as text (Vite's glob, so no file system path is assumed). */
const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("links that leave the app", () => {
  /**
   * The Tasks tab's PR link was a raw `<a target="_blank">`: in the desktop window a new-window
   * request that nothing handled, so the click did nothing (the same in Settings → Sandbox,
   * Updates and Peers). `ExternalLink` drops the target in the shell, where `windows.rs` opens
   * the page in the system browser. The phone screens (`src/mobile`) run elsewhere.
   */
  it('no desktop screen opens a link with target="_blank" except through ExternalLink', () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => !f.includes("/mobile/") && !f.endsWith("/components/ExternalLink.tsx"))
      .filter((f) => /_blank/.test(SOURCES[f] ?? ""));
    expect(offenders).toEqual([]);
  });

  it("the PR link on the Tasks tab has no target in the desktop shell, and opens a tab in a browser", async () => {
    const shell = createHarness();
    shell.store = createStore({ ...testConfig(), source: "shell" }, shell.storage);
    const { unmount } = renderApp("/projects/proj_atlas/tasks", shell);
    const rows = await screen.findAllByTestId("task-row");
    const inShell = rows
      .map((r) => within(r).queryByTestId("pr-link"))
      .find((l): l is HTMLElement => l !== null);
    expect(inShell?.getAttribute("href")).toMatch(
      /^https:\/\/example.test\/org\/atlas\/pull\/\d+$/,
    );
    expect(inShell).not.toHaveAttribute("target");
    unmount();

    renderApp("/projects/proj_atlas/tasks");
    const inBrowser = (await screen.findAllByTestId("task-row"))
      .map((r) => within(r).queryByTestId("pr-link"))
      .find((l): l is HTMLElement => l !== null);
    expect(inBrowser).toHaveAttribute("target", "_blank");
    expect(inBrowser).toHaveAttribute("rel", "noreferrer");
  });
});
