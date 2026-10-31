import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { appStateTone, isInstallerArtifact } from "../src/pages/UpdatesPage.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Updates screen", () => {
  it("maps app states to tones", () => {
    expect(appStateTone("up_to_date")).toBe("good");
    expect(appStateTone("available")).toBe("info");
    expect(appStateTone("rolled_back")).toBe("bad");
    expect(appStateTone("unknown")).toBe("neutral");
  });

  // On the desktop the release's artefact is the installer, which the staged install cannot
  // run: "Update and restart" would roll back (ADR 0092). The screen offers the download.
  it("a desktop release offers its installer instead of Update and restart", async () => {
    expect(isInstallerArtifact("Forerunner_1.0.2_x64_en-US.msi")).toBe(true);
    expect(isInstallerArtifact("Forerunner_1.0.2_amd64.AppImage")).toBe(true);
    expect(isInstallerArtifact("Forerunner_1.0.2_amd64.deb")).toBe(true);
    expect(isInstallerArtifact("forerunner-0.2.0-linux-x64.tar.gz")).toBe(false);
    expect(isInstallerArtifact(null)).toBe(false);
    const url = "https://github.com/o/r/releases/download/v1.0.2/Forerunner_1.0.2_x64_en-US.msi";
    const user = userEvent.setup();
    const harness = createHarness({
      updateArtifact: { name: "Forerunner_1.0.2_x64_en-US.msi", url },
    });
    renderApp("/updates", harness);
    await user.click(await screen.findByTestId("updates-check"));
    await screen.findByTestId("available-update");
    expect(screen.getByTestId("download-installer")).toHaveAttribute("href", url);
    expect(screen.getByTestId("installer-note")).toHaveTextContent("run it");
    expect(screen.queryByTestId("update-and-restart")).toBeNull();
  });

  it("the Updates menu entry opens the screen without asking the feed", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await user.click(await screen.findByRole("link", { name: "Updates" }));
    expect(await screen.findByTestId("updates-check")).toHaveTextContent("Check for updates");
    expect(postedCalls(harness, "/updates/check")).toHaveLength(0);
  });

  it("opening the screen asks nothing of the feed; Check for updates is the only check", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    const app = await screen.findByTestId("app-update");
    expect(within(app).getByTestId("no-update")).toHaveTextContent("has not been checked yet");
    expect(screen.queryByTestId("available-update")).toBeNull();
    expect(postedCalls(harness, "/updates/check")).toHaveLength(0);
    const button = screen.getByTestId("updates-check");
    expect(button).toHaveTextContent("Check for updates");
    await user.click(button);
    await waitFor(() => expect(postedCalls(harness, "/updates/check")).toHaveLength(1));
    expect(await screen.findByTestId("available-update")).toHaveTextContent(
      "Update available: 0.2.0",
    );
    // Installing stays the human's own click.
    expect(postedCalls(harness, "/updates/apply")).toHaveLength(0);
  });

  it("shows the available release with its changelog, connector and model updates", async () => {
    const user = userEvent.setup();
    renderApp("/updates");
    await user.click(await screen.findByTestId("updates-check"));
    const app = await screen.findByTestId("app-update");
    await within(app).findByTestId("available-update");
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
    await user.click(await screen.findByTestId("updates-check"));
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
    // Once the restart is over the screen shows the daemon's local state, not the old check.
    harness.store.dispatch({ type: "restart", restart: null });
    await waitFor(() =>
      expect(screen.getByTestId("app-version")).toHaveTextContent("running 0.2.0"),
    );
    expect(screen.queryByTestId("available-update")).toBeNull();
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

  it("a report whose paid evals were withheld says so and offers Run evaluations, which answers 'evaluate'", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    const latest = await screen.findByTestId("model-watch-latest");
    expect(within(latest).getByTestId("model-watch-deferred")).toHaveTextContent(
      "Evaluations not run",
    );
    // Only "Run evaluations" spends: adopting applies the price rows and runs nothing.
    expect(within(latest).getByTestId("model-watch-deferred")).toHaveTextContent(
      "Adopt applies the price rows only and runs no evaluation",
    );
    await user.click(screen.getByTestId("model-watch-evaluate"));
    // It says what it may cost first (U-076); the yes sends the answer.
    await user.click(
      within(await screen.findByTestId("updates-confirm")).getByTestId("updates-confirm-yes"),
    );
    await waitFor(() =>
      expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")[0]?.body).toEqual({
      decision: "evaluate",
      by: "human_alice",
    });
    await waitFor(() =>
      expect(screen.getByTestId("model-watch-latest")).toHaveAttribute("data-decision", "evaluate"),
    );
  });

  it("shows the daemon's feed error when the check answers 200 with lastError", async () => {
    const user = userEvent.setup();
    renderApp("/updates", createHarness({ updatesCheckError: "feed unreachable: ETIMEDOUT" }));
    await user.click(await screen.findByTestId("updates-check"));
    expect(await screen.findByTestId("feed-error")).toHaveTextContent("ETIMEDOUT");
    // The failure is said, not "not checked yet" (U-077).
    expect(screen.getByTestId("no-update")).toHaveTextContent(
      "The check for updates failed: feed unreachable: ETIMEDOUT.",
    );
    expect(screen.getByTestId("updates-checked-at")).toHaveTextContent("the last check failed");
    expect(screen.getByTestId("updates-checked-at")).not.toHaveTextContent("not checked yet");
  });

  it("after a rollback the screen shows the daemon's local state again, not the earlier check", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    await user.click(await screen.findByTestId("updates-check"));
    await screen.findByTestId("available-update");
    await user.click(screen.getByTestId("rollback"));
    await waitFor(() => expect(postedCalls(harness, "/updates/rollback")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("available-update")).toBeNull());
    expect(screen.getByTestId("app-version")).toHaveTextContent("running 0.0.9");
  });

  it("keeps the local state when Check for updates cannot reach the feed", async () => {
    const user = userEvent.setup();
    renderApp(
      "/updates",
      createHarness({
        failing: { "/updates/check": { status: 503, code: "unavailable", message: "feed down" } },
      }),
    );
    await user.click(await screen.findByTestId("updates-check"));
    expect(await screen.findByTestId("feed-error")).toHaveTextContent("feed down");
    expect(screen.getByTestId("no-update")).toHaveTextContent("The check for updates failed");
    expect(screen.getByTestId("no-update")).not.toHaveTextContent("has not been checked yet");
    expect(screen.getByTestId("updates-checked-at")).toHaveTextContent("the last check failed");
    expect(screen.getByTestId("app-version")).toHaveTextContent("running 0.1.0-fake");
  });
});

/** Ask first (U-076): a restart ends the running sessions; evaluations cost money. */
describe("Updates asks first (U-076)", () => {
  const running = (harness: ReturnType<typeof createHarness>, n: number) => {
    const base = harness.daemon.state.sessions[0];
    if (!base) throw new Error("fixture changed");
    for (let i = 0; i < n; i++) {
      harness.daemon.state.sessions.push({ ...base, id: `sess_run_${i}`, status: "running" });
    }
  };

  it("Update and restart while two sessions run says so and waits for a yes; Not now sends nothing", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness, 2);
    renderApp("/updates", harness);
    await user.click(await screen.findByTestId("updates-check"));
    await screen.findByTestId("available-update");
    await user.click(screen.getByTestId("update-and-restart"));
    const dialog = await screen.findByTestId("updates-confirm");
    expect(within(dialog).getByTestId("updates-confirm-text")).toHaveTextContent(
      "2 sessions are running. Updating restarts Forerunner's background service, which stops them; start them again afterwards.",
    );
    await user.click(within(dialog).getByTestId("updates-confirm-no"));
    expect(postedCalls(harness, "/updates/apply")).toHaveLength(0);
    await user.click(screen.getByTestId("update-and-restart"));
    const again = await screen.findByTestId("updates-confirm");
    expect(within(again).getByTestId("updates-confirm-yes")).toHaveTextContent(
      "Update and restart",
    );
    await user.click(within(again).getByTestId("updates-confirm-yes"));
    await waitFor(() => expect(postedCalls(harness, "/updates/apply")).toHaveLength(1));
  });

  it("Roll back and restart while one session runs names it and asks", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    running(harness, 1);
    renderApp("/updates", harness);
    await screen.findByTestId("app-update");
    await user.click(screen.getByTestId("rollback"));
    const dialog = await screen.findByTestId("updates-confirm");
    expect(within(dialog).getByTestId("updates-confirm-text")).toHaveTextContent(
      "1 session is running. Rolling back restarts Forerunner's background service, which stops it",
    );
    expect(postedCalls(harness, "/updates/rollback")).toHaveLength(0);
    await user.click(within(dialog).getByTestId("updates-confirm-yes"));
    await waitFor(() => expect(postedCalls(harness, "/updates/rollback")).toHaveLength(1));
  });

  it("Run evaluations shows what it may cost and runs only after a yes", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/updates", harness);
    const button = await screen.findByTestId("model-watch-evaluate");
    // The report's eval budget, USD 2.50, in CHF at the cards' rate.
    expect(button).toHaveTextContent("Run evaluations (up to CHF 2.00)");
    expect(screen.getByTestId("model-watch-deferred")).toHaveTextContent("(up to CHF 2.00)");
    await user.click(button);
    const dialog = await screen.findByTestId("updates-confirm");
    expect(within(dialog).getByTestId("updates-confirm-text")).toHaveTextContent(
      "1 evaluation run will cost up to CHF 2.00 (an estimate: the most these runs may spend), counted against your caps.",
    );
    await user.click(within(dialog).getByTestId("updates-confirm-no"));
    expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")).toHaveLength(0);
    await user.click(button);
    await user.click(
      within(await screen.findByTestId("updates-confirm")).getByTestId("updates-confirm-yes"),
    );
    await waitFor(() =>
      expect(postedCalls(harness, "/model-watch/reports/mw_2/answer")).toHaveLength(1),
    );
  });
});
