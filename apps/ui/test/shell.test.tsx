import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { storageKey } from "../src/lib/storage.ts";
import { buildCommands, filterCommands } from "../src/shell/commands.ts";
import { createSequenceMatcher } from "../src/shell/shortcuts.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("keyboard sequence matcher", () => {
  it("matches g h / g i / g s inside the window and ignores text fields", () => {
    const m = createSequenceMatcher(undefined, 1000);
    expect(m.press({ key: "g" }, 0)).toBeNull();
    expect(m.press({ key: "h" }, 100)).toBe("go.home");
    expect(m.press({ key: "g" }, 200)).toBeNull();
    expect(m.press({ key: "i" }, 1500)).toBeNull(); // window expired
    expect(m.press({ key: "g" }, 2000)).toBeNull();
    expect(m.press({ key: "s" }, 2100)).toBe("go.settings");
    expect(m.press({ key: "g", inField: true }, 3000)).toBeNull();
    expect(m.press({ key: "i" }, 3100)).toBeNull();
    expect(m.press({ key: "?" }, 4000)).toBe("help");
    expect(m.press({ key: "k", ctrlKey: true, inField: true }, 5000)).toBe("palette");
    expect(m.press({ key: "k", metaKey: true }, 5000)).toBe("palette");
    expect(m.press({ key: "Escape" }, 6000)).toBe("escape");
  });
});

describe("command palette commands", () => {
  it("filters by every word of the query", () => {
    const harness = createHarness();
    harness.store.dispatch({
      type: "projects",
      projects: [
        {
          id: "p1",
          name: "Atlas",
          goal: "",
          stage: "build",
          status: "active",
          autonomyLevel: 2,
          nextMilestone: null,
          health: "good",
          spend: { usdMicro: 0, chfMicro: 0 },
          budget: { usdMicro: 0, chfMicro: 0 },
          waitingOnYou: 0,
          latestCriticGrade: null,
          lastSessionAt: null,
          active: true,
        },
      ],
    });
    const commands = buildCommands({
      state: harness.store.getState(),
      navigate: () => {},
      setActiveProject: () => {},
      setTheme: () => {},
      toggleKill: () => {},
      openNewProject: () => {},
      openShortcuts: () => {},
    });
    expect(filterCommands(commands, "switch atlas").map((c) => c.id)).toEqual(["project.p1"]);
    expect(filterCommands(commands, "go inbox").map((c) => c.id)).toEqual(["nav.inbox"]);
    expect(filterCommands(commands, "").length).toBe(commands.length);
  });
});

describe("Shell", () => {
  it("switches project from the command palette", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByTestId("command-palette");
    await user.type(within(palette).getByTestId("command-input"), "switch beacon");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon"));
    expect(screen.getByTestId("project-header")).toHaveTextContent("Beacon");
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("navigates with g i and g h, opens help with ?", async () => {
    renderApp("/");
    await screen.findAllByTestId("project-card");
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "i" });
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "h" });
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByTestId("shortcuts-help")).toHaveTextContent("Go to Inbox");
  });

  it("switches project from the header dropdown", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    await user.click(screen.getByTestId("active-project"));
    const switcher = await screen.findByTestId("project-switcher");
    await user.click(within(switcher).getByText("Beacon"));
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon"));
  });

  it("stops everything with the kill switch and resumes on the second click", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("kill-switch"));
    await waitFor(() => expect(postedCalls(harness, "/kill")).toHaveLength(1));
    expect(postedCalls(harness, "/kill")[0]?.body).toMatchObject({ scope: "all" });
    await waitFor(() => expect(screen.getByTestId("kill-switch")).toHaveTextContent("Resume"));
    expect(screen.getByTestId("kill-banner")).toBeInTheDocument();
    await user.click(screen.getByTestId("kill-switch"));
    await waitFor(() => expect(postedCalls(harness, "/kill/resume")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("kill-switch")).toHaveTextContent("Stop all"));
  });

  it("persists the active project and the theme per install", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    await waitFor(() =>
      expect(harness.storage.get(storageKey("test", "activeProject"))).toBe("proj_atlas"),
    );
    await user.selectOptions(await screen.findByTestId("theme-select"), "dark");
    expect(harness.storage.get(storageKey("test", "theme"))).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.selectOptions(screen.getByTestId("theme-select"), "light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
