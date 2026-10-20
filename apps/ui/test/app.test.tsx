import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { createClient } from "../src/api/client.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { createStore } from "../src/store/store.ts";
import { createFakeDaemon } from "./fake-daemon.ts";
import { fetchFromApp, testConfig } from "./helpers.tsx";

describe("App shell", () => {
  it("always shows the active project slot and the kill switch, even with no daemon", async () => {
    const client = createClient(testConfig(null), async () => {
      throw new TypeError("fetch failed");
    });
    render(<App client={client} store={createStore(testConfig(null), memoryStorage())} />);
    expect(screen.getByTestId("active-project")).toHaveTextContent("No active project");
    expect(screen.getByTestId("kill-switch")).toBeEnabled();
    expect(await screen.findByTestId("not-connected")).toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toHaveTextContent("not connected");
  });

  it("shows the empty state when the daemon has no projects", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    daemon.state.projects = [];
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    render(<App client={client} store={createStore(testConfig("tok"), memoryStorage())} />);
    expect(await screen.findByTestId("empty-state")).toBeVisible();
    expect(screen.getByTestId("active-project")).toHaveTextContent("No active project");
  });
});
