import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { pullProgress } from "../src/api/sandbox.ts";
import { money } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings → Sandbox (Docker) (U-079): full-review tasks run their tests and builds in the
 * Docker sandbox; the card says why, shows where it stands with the plain step for each state,
 * Check again looks afresh, and Download fetches the image with its size and progress. The
 * Start dialog names the full-review tasks that wait for it, with the step.
 */
describe("Settings: Sandbox (Docker)", () => {
  it("Docker not installed: why the sandbox exists, the steps, the Docker Desktop link", async () => {
    renderApp("/settings", createHarness({ sandbox: { state: "not_installed", waiting: 2 } }));
    const card = await screen.findByTestId("sandbox-settings");
    expect(await within(card).findByTestId("sandbox-state")).toHaveTextContent(
      "Docker not installed",
    );
    expect(within(card).getByTestId("sandbox-why")).toHaveTextContent(
      "Full-review tasks (risk tier 2 and above) run their tests and builds in this sandbox, isolated from your computer, so the critic sees real results.",
    );
    expect(within(card).getByTestId("sandbox-headline")).toHaveTextContent(
      "Docker is not installed on this computer.",
    );
    expect(within(card).getByTestId("sandbox-steps")).toHaveTextContent(/Install Docker Desktop/);
    expect(within(card).getByTestId("sandbox-docker-link")).toHaveAttribute(
      "href",
      "https://www.docker.com/products/docker-desktop/",
    );
    expect(within(card).getByTestId("sandbox-waiting")).toHaveTextContent(
      "2 full-review tasks wait for the sandbox.",
    );
    expect(within(card).queryByTestId("sandbox-download")).toBeNull();
  });

  it("Windows containers: the switch to Linux containers, then Check again finds it ready", async () => {
    const user = userEvent.setup();
    const harness = createHarness({
      sandbox: { state: "windows_containers", waiting: 1 },
      sandboxAfterCheck: "ready",
    });
    renderApp("/settings", harness);
    const card = await screen.findByTestId("sandbox-settings");
    expect(await within(card).findByTestId("sandbox-steps")).toHaveTextContent(
      "Right-click the Docker icon in the taskbar and choose Switch to Linux containers.",
    );
    await user.click(within(card).getByTestId("sandbox-check"));
    expect(postedCalls(harness, "/sandbox/check")).toHaveLength(1);
    await waitFor(() =>
      expect(within(card).getByTestId("sandbox-state")).toHaveTextContent("ready"),
    );
    expect(within(card).getByTestId("sandbox-headline")).toHaveTextContent(
      "Ready: full-review tasks run in ghcr.io/test-owner/forerunner-runner:1.0.5 on docker 27.3.1.",
    );
    expect(within(card).queryByTestId("sandbox-waiting")).toBeNull();
  });

  it("image missing: Download shows the size, streams the progress and ends ready", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ sandbox: { state: "image_missing" } });
    renderApp("/settings", harness);
    const card = await screen.findByTestId("sandbox-settings");
    const download = await within(card).findByTestId("sandbox-download");
    expect(download).toHaveTextContent("Download the sandbox (about 640 MB)");
    expect(within(card).getByTestId("sandbox-image")).toHaveTextContent(
      "ghcr.io/test-owner/forerunner-runner:1.0.5 (about 640 MB to download)",
    );
    await user.click(download);
    expect(postedCalls(harness, "/sandbox/pull")).toHaveLength(1);
    await waitFor(() =>
      expect(within(card).getByTestId("sandbox-state")).toHaveTextContent("ready"),
    );
    expect(within(card).getByTestId("sandbox-progress-log")).toHaveTextContent(
      "the sandbox ghcr.io/test-owner/forerunner-runner:1.0.5 is downloaded",
    );
  });

  it("a source checkout's local image: the build command, no Download", async () => {
    renderApp(
      "/settings",
      createHarness({ sandbox: { state: "image_missing", pullable: false, platform: "linux" } }),
    );
    const card = await screen.findByTestId("sandbox-settings");
    expect(await within(card).findByTestId("sandbox-steps")).toHaveTextContent(
      "docker build -t forerunner-runner:local -f services/cloud-runner/Dockerfile .",
    );
    expect(within(card).queryByTestId("sandbox-download")).toBeNull();
  });

  it("the progress reads the layers as parts", () => {
    expect(
      pullProgress([
        { seq: 1, event: { type: "step", message: "downloading x" } },
        { seq: 2, event: { type: "layers", done: 2, total: 4 } },
      ]),
    ).toMatchObject({ percent: 50, layers: "2 of 4 parts" });
  });
});

describe("Start dialog: full-review tasks wait for Docker (U-079)", () => {
  it("names the waiting task, the step and the place, and the other tasks still run", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ sandbox: { state: "not_running" } });
    const tasks = harness.daemon.state.tasks;
    const ready = tasks.find((t) => t.id === "task_3");
    if (!ready) throw new Error("fixture changed");
    ready.estimate = money(100_000);
    ready.riskTier = 0;
    tasks.push({
      ...ready,
      id: "task_full",
      title: "Rework the payment flow",
      riskTier: 2,
    });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    const leftOut = await within(dialog).findByTestId("start-session-left-out");
    const line = within(leftOut).getByTestId("start-session-sandbox");
    expect(line).toHaveTextContent(
      '"Rework the payment flow" needs a full review, which runs in the Docker sandbox, and it is not ready: Docker is installed but not running. Next: start Docker Desktop, then Check again in Settings → Sandbox (Docker). It waits; nothing fails and no retry is used.',
    );
    expect(within(line).getByRole("link", { name: /Open Settings/ })).toHaveAttribute(
      "href",
      "/settings#sandbox",
    );
    expect(within(dialog).queryByTestId("start-session-cannot-run")).toBeNull();
  });
});
