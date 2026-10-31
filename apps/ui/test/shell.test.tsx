import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";
import { storageKey } from "../src/lib/storage.ts";
import { AppRoutes } from "../src/routes.tsx";
import { buildCommands, filterCommands } from "../src/shell/commands.ts";
import { createSequenceMatcher } from "../src/shell/shortcuts.ts";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, fetchFromApp, postedCalls, renderApp, testConfig } from "./helpers.tsx";

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
    expect(filterCommands(commands, "change log").map((c) => c.id)).toEqual(["nav.changes"]);
    expect(filterCommands(commands, "response times").map((c) => c.id)).toEqual([
      "nav.performance",
    ]);
    expect(filterCommands(commands, "updates").map((c) => c.id)).toEqual(["nav.updates"]);
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

  it("navigates to the change log, performance and updates with g c, g t and g u", async () => {
    renderApp("/");
    await screen.findAllByTestId("project-card");
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("heading", { name: "Changes" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "t" });
    expect(await screen.findByRole("heading", { name: "Performance" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "u" });
    expect(await screen.findByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByTestId("main-nav")).toHaveTextContent("ChangesPerformanceUpdates");
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

/** A harness whose daemon can stop answering, or answer 401, while the app runs (U-071). */
function switchableHarness() {
  const harness = createHarness();
  const daemon = { mode: "up" as "up" | "gone" | "refuses" };
  const inner = fetchFromApp(harness.daemon.app);
  const client = createClient(testConfig(), async (input, init) => {
    if (daemon.mode === "gone") throw new TypeError("fetch failed");
    if (daemon.mode === "refuses") {
      return new Response(JSON.stringify({ code: "unauthorized", message: "bad token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(input, init);
  });
  return { ...harness, client, daemon };
}

function renderSwitchable(h: ReturnType<typeof switchableHarness>, pollIntervalMs: number) {
  const streamOptions = { pollIntervalMs };
  return render(
    <AppProvider client={h.client} store={h.store} streamOptions={streamOptions}>
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProvider>,
  );
}

describe("the header's connection status follows the daemon (U-071)", () => {
  it("says not connected with a Retry when the daemon stops answering, and connected when it answers again", async () => {
    const h = switchableHarness();
    renderSwitchable(h, 40);
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent(/^connected/),
    );
    expect(screen.queryByTestId("connection-retry")).not.toBeInTheDocument();

    h.daemon.mode = "gone";
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent("not connected"),
    );
    expect(screen.getByTestId("connection-retry")).toHaveTextContent("Retry");
    expect(screen.getByTestId("not-connected")).toHaveTextContent(
      "Not connected. Forerunner's background service does not answer. The app tries again every few seconds.",
    );

    h.daemon.mode = "up";
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent(/^connected/),
    );
    expect(screen.queryByTestId("not-connected")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-retry")).not.toBeInTheDocument();
  });

  it("says not connected when the daemon refuses the window's key (401), with what to do", async () => {
    const h = switchableHarness();
    renderSwitchable(h, 40);
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent(/^connected/),
    );
    h.daemon.mode = "refuses";
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent("not connected"),
    );
    expect(screen.getByTestId("not-connected")).toHaveTextContent(
      "refused this window's key: close Forerunner and open it again.",
    );
  });

  it("Retry connects at once when the daemon was not there at the start", async () => {
    const user = userEvent.setup();
    const h = switchableHarness();
    h.daemon.mode = "gone";
    // A slow automatic retry, so the click is what reconnects.
    renderSwitchable(h, 60_000);
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent("not connected"),
    );
    h.daemon.mode = "up";
    await user.click(screen.getByTestId("connection-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveTextContent(/^connected/),
    );
    expect(await screen.findAllByTestId("project-card")).not.toHaveLength(0);
  });
});
