import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { appStateTone } from "../src/pages/UpdatesPage.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Updates screen", () => {
  it("maps app states to tones", () => {
    expect(appStateTone("up_to_date")).toBe("good");
    expect(appStateTone("available")).toBe("info");
    expect(appStateTone("rolled_back")).toBe("bad");
    expect(appStateTone("unknown")).toBe("neutral");
  });

  it("shows the available release with its changelog, connector and model updates", async () => {
    renderApp("/updates");
    const app = await screen.findByTestId("app-update");
    expect(within(app).getByTestId("app-version")).toHaveTextContent("running 0.1.0-fake");
    expect(within(app).getByTestId("app-state")).toHaveTextContent("available");
    expect(within(app).getByTestId("available-update")).toHaveTextContent(
      "Update available: 0.2.0",
    );
    expect(within(app).getByTestId("changelog")).toHaveTextContent(
      "Reviews tab with the grade trend",
    );
    expect(within(app).getByTestId("rejected-updates")).toHaveTextContent("0.1.9: signature");
    expect(screen.getByTestId("connector-update")).toHaveTextContent("GitHub");
    expect(screen.getByTestId("connector-update")).toHaveTextContent("1.4.0");
    expect(screen.getByTestId("connector-update")).toHaveTextContent("1.5.0");
    expect(screen.getByTestId("model-update")).toHaveTextContent("haiku-5.6");
    expect(screen.getByTestId("model-update")).toHaveTextContent(
      "Adopt for routing and quick chat",
    );
  });

  it("applies the update and announces the restart", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    await screen.findByTestId("available-update");
    await user.click(screen.getByTestId("update-and-restart"));
    await waitFor(() => expect(postedCalls(harness, "/updates/apply")).toHaveLength(1));
    expect(postedCalls(harness, "/updates/apply")[0]?.body).toEqual({ version: "0.2.0" });
    expect(await screen.findByTestId("updates-note")).toHaveTextContent("Staged 0.2.0");
    // The daemon's restart.requested frame reaches the store; the shell shows it everywhere.
    harness.store.dispatch({
      type: "restart",
      restart: {
        reason: "update",
        targetVersion: "0.2.0",
        fromVersion: "0.1.0-fake",
        exitCode: 86,
      },
    });
    expect(await screen.findByTestId("restart-banner")).toHaveTextContent("0.1.0-fake → 0.2.0");
    expect(screen.getByTestId("restart-notice")).toHaveTextContent("Restarting");
    expect(screen.getByTestId("update-and-restart")).toBeDisabled();
  });

  it("rolls back on request", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    await screen.findByTestId("app-update");
    await user.click(screen.getByTestId("rollback"));
    await waitFor(() => expect(postedCalls(harness, "/updates/rollback")).toHaveLength(1));
    expect(postedCalls(harness, "/updates/rollback")[0]?.body).toEqual({
      reason: "from the updates screen",
    });
    expect(await screen.findByTestId("updates-note")).toHaveTextContent(
      "Rolling back from 0.1.0-fake to 0.0.9",
    );
  });

  it("answers the model watch and runs it on demand", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    const latest = await screen.findByTestId("model-watch-latest");
    expect(latest).toHaveAttribute("data-decision", "pending");
    expect(within(latest).getAllByRole("checkbox")).toHaveLength(2);
    await user.click(within(latest).getAllByRole("checkbox")[1] as HTMLElement);
    await user.click(screen.getByTestId("model-watch-adopt"));
    await waitFor(() =>
      expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")[0]?.body).toEqual({
      decision: "adopt",
      by: "human_alice",
      adopt: ["rec_1"],
    });
    expect(await screen.findByTestId("updates-note")).toHaveTextContent("Model watch: adopted");
    await waitFor(() =>
      expect(screen.getByTestId("model-watch-latest")).toHaveAttribute("data-decision", "adopted"),
    );
    await user.click(screen.getByTestId("model-watch-run"));
    await waitFor(() => expect(postedCalls(harness, "/model-watch/run")).toHaveLength(1));
    expect(await screen.findByTestId("updates-note")).toHaveTextContent(
      "Nothing changed since the last run",
    );
  });

  it("falls back to the local state when the feed route fails", async () => {
    // The feed route fails; /updates/status (no network) still answers.
    renderApp(
      "/updates",
      createHarness({
        failing: { "/updates": { status: 503, code: "unavailable", message: "feed down" } },
      }),
    );
    expect(await screen.findByTestId("feed-error")).toHaveTextContent("feed down");
    expect(screen.getByTestId("no-update")).toHaveTextContent("has not been checked yet");
    expect(screen.getByTestId("app-version")).toHaveTextContent("running 0.1.0-fake");
  });
});
