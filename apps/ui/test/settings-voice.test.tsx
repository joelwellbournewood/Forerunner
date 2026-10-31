import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installProgress, reattachDelay } from "../src/pages/VoiceSettingsCard.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings → Voice (ADR 0090): the voice profile in force with the devices its check verified,
 * every profile with its disk size and trade-off, and a confirmed switch that runs the install
 * through the daemon with its progress streamed into the card.
 */

const profileRow = async (profile: string) => {
  const rows = await screen.findAllByTestId("voice-profile");
  const row = rows.find((r) => r.dataset.profile === profile);
  if (!row) throw new Error(`no row ${profile}`);
  return row as HTMLElement;
};

describe("Settings: voice", () => {
  it("shows the current profile, its devices, the GPU and each profile's size and trade-off", async () => {
    renderApp("/settings", createHarness());
    const card = await screen.findByTestId("voice-settings");
    expect(await within(card).findByTestId("voice-profile-current")).toHaveTextContent("cpu");
    expect(within(card).getByTestId("voice-stt-device")).toHaveTextContent("cpu (int8)");
    expect(within(card).getByTestId("voice-tts-device")).toHaveTextContent("cpu");
    expect(within(card).getByTestId("voice-gpu")).toHaveTextContent(
      "NVIDIA GeForce RTX 4070, driver 572.83",
    );
    const gpu = await profileRow("gpu");
    expect(within(gpu).getByTestId("voice-profile-size")).toHaveTextContent(
      "about 8 GB on disk · about 4.5 GB to download",
    );
    expect(gpu).toHaveTextContent("recommended here");
    expect(gpu).toHaveTextContent("NVIDIA only");
    expect(gpu).toHaveTextContent(/Fastest replies/);
    const cpu = await profileRow("cpu");
    expect(cpu).toHaveTextContent("current");
    expect(cpu).toHaveTextContent(/about 2\.3 GB on disk/);
    expect(cpu).toHaveTextContent(/slower/);
    const none = await profileRow("none");
    expect(within(none).getByTestId("voice-profile-switch")).toHaveTextContent("Turn off");
    expect(within(card).getByTestId("voice-cli")).toHaveTextContent("fr voice install --cpu");
    // U-011: where the packages and models are, beside the install by default.
    expect(within(card).getByTestId("voice-folder")).toHaveTextContent(
      "Installed in D:\\AGENT\\Forerunner\\dependencies\\voice",
    );
    expect(within(card).queryByTestId("voice-folder-note")).not.toBeInTheDocument();
  });

  it("says why voice goes to the data folder when the install folder cannot be written (U-011)", async () => {
    const note =
      "The install folder C:\\Program Files\\Forerunner cannot be written (EPERM), so dependencies go to the data folder.";
    renderApp(
      "/settings",
      createHarness({
        voiceInstall: {
          profile: null,
          installedAt: null,
          folder: "C:\\Users\\me\\AppData\\Local\\forerunner\\data\\voice",
          folderNote: note,
        },
      }),
    );
    const card = await screen.findByTestId("voice-settings");
    expect(await within(card).findByTestId("voice-folder")).toHaveTextContent(
      "Installs into C:\\Users\\me\\AppData\\Local\\forerunner\\data\\voice",
    );
    expect(within(card).getByTestId("voice-folder-note")).toHaveTextContent(note);
  });

  it("a switch is confirmed first, then streams the install's progress and shows the new devices", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const gpu = await profileRow("gpu");
    await user.click(within(gpu).getByTestId("voice-profile-switch"));
    // Nothing runs before the confirmation, which names the download and the CLI command.
    expect(postedCalls(harness, "/voice/install")).toHaveLength(0);
    expect(within(gpu).getByTestId("voice-profile-confirm-text")).toHaveTextContent(
      /Downloads about 4\.5 GB.*fr voice install --gpu/,
    );
    await user.click(within(gpu).getByTestId("voice-profile-confirm"));
    await waitFor(() => expect(postedCalls(harness, "/voice/install")).toHaveLength(1));
    expect(postedCalls(harness, "/voice/install")[0]?.body).toEqual({ profile: "gpu" });
    const progress = await screen.findByTestId("voice-install-progress");
    expect(await within(progress).findByTestId("voice-install-bar")).toHaveTextContent(
      "torch-2.11.0.whl",
    );
    expect(within(progress).getByTestId("voice-install-bar")).toHaveTextContent(
      "2753.0 of 2753.0 MB",
    );
    await within(progress).findByText("voice profile gpu installed");
    const card = screen.getByTestId("voice-settings");
    await waitFor(() =>
      expect(within(card).getByTestId("voice-profile-current")).toHaveTextContent("gpu"),
    );
    expect(within(card).getByTestId("voice-stt-device")).toHaveTextContent("cuda (float16)");
    expect(within(card).getByTestId("voice-tts-device")).toHaveTextContent("cuda");
  });

  it("re-attaches when the progress stream drops while the install still runs", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ voiceInstallDropOnce: true });
    renderApp("/settings", harness);
    const gpu = await profileRow("gpu");
    await user.click(within(gpu).getByTestId("voice-profile-switch"));
    await user.click(within(gpu).getByTestId("voice-profile-confirm"));
    const progress = await screen.findByTestId("voice-install-progress");
    // The rest of the job arrives over a second stream, from where the first one stopped.
    expect(
      await within(progress).findByText("voice profile gpu installed", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    const card = screen.getByTestId("voice-settings");
    await waitFor(() =>
      expect(within(card).getByTestId("voice-profile-current")).toHaveTextContent("gpu"),
    );
    // Each step once: the second stream resumed after the last event the card had.
    expect(within(progress).getAllByText("installing the gpu packages")).toHaveLength(1);
    expect(harness.daemon.state.voiceInstallStreamsAfter).toEqual([0, 3]);
  });

  it("Cancel stops a running install: the job ends cancelled and the profile stays", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ voiceInstallHold: true });
    renderApp("/settings", harness);
    const gpu = await profileRow("gpu");
    await user.click(within(gpu).getByTestId("voice-profile-switch"));
    await user.click(within(gpu).getByTestId("voice-profile-confirm"));
    const cancel = await screen.findByTestId("voice-install-cancel");
    await user.click(cancel);
    await waitFor(() => expect(postedCalls(harness, "/voice/install/cancel")).toHaveLength(1));
    const progress = screen.getByTestId("voice-install-progress");
    expect(
      await within(progress).findByText("voice profile gpu not installed: cancelled", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("voice-install-cancel")).toBeNull());
    expect(screen.getByTestId("voice-profile-current")).toHaveTextContent("cpu");
  });

  it("a stream error is shown, then cleared once the card re-attaches", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness({ voiceInstallStreamFailsOnce: true }));
    const gpu = await profileRow("gpu");
    await user.click(within(gpu).getByTestId("voice-profile-switch"));
    await user.click(within(gpu).getByTestId("voice-profile-confirm"));
    expect(await screen.findByTestId("voice-install-error")).toHaveTextContent(/stream broke/);
    expect(
      await screen.findByText("voice profile gpu installed", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("voice-install-error")).toBeNull();
  });

  it("a GPU check that fell back shows the warning and the reason", async () => {
    const user = userEvent.setup();
    renderApp(
      "/settings",
      createHarness({
        voiceInstallGpuFails: "Library cublas64_12.dll is not found or cannot be loaded",
      }),
    );
    const gpu = await profileRow("gpu");
    await user.click(within(gpu).getByTestId("voice-profile-switch"));
    await user.click(within(gpu).getByTestId("voice-profile-confirm"));
    const progress = await screen.findByTestId("voice-install-progress");
    expect(
      await within(progress).findByText(/GPU check failed for speech recognition/),
    ).toBeInTheDocument();
    const fallback = await screen.findByTestId("voice-fallback");
    expect(fallback).toHaveTextContent(/CPU stands in: Library cublas64_12\.dll is not found/);
    expect(screen.getByTestId("voice-stt-device")).toHaveTextContent("cpu (int8)");
  });

  it("a refused switch (a voice session is open) says why", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    // An open voice session on the fake daemon.
    await harness.client.raw({ method: "POST", path: "/voice/sessions", body: {} });
    const gpu = await profileRow("gpu");
    await user.click(within(gpu).getByTestId("voice-profile-switch"));
    await user.click(within(gpu).getByTestId("voice-profile-confirm"));
    expect(await screen.findByTestId("voice-install-error")).toHaveTextContent(
      /a voice session is open/,
    );
  });
});

describe("Settings: voice providers (U-023)", () => {
  it("shows the providers in force with where each comes from, and where a cloud one is chosen", async () => {
    const harness = createHarness();
    renderApp("/settings", harness);
    const card = await screen.findByTestId("voice-settings");
    // One place for voice: install state and the providers in force are both on this card.
    const providers = await within(card).findByTestId("voice-providers");
    expect(within(providers).getByTestId("voice-available")).toHaveTextContent("available");
    expect(within(providers).getByTestId("voice-stt")).toHaveTextContent(
      'deepgram (cloud; "deepgram" selected in Extensions (voice-deepgram))',
    );
    expect(within(providers).getByTestId("voice-tts")).toHaveTextContent(
      'kokoro (local; local provider "kokoro": kokoro importable)',
    );
    // A cloud provider is chosen by its voice extension; the link goes there.
    expect(within(providers).getByRole("link", { name: "Extensions" })).toHaveAttribute(
      "href",
      "/extensions",
    );
    expect(within(providers).getByTestId("voice-providers-note")).toHaveTextContent(
      "Local voice (above) is used unless a cloud voice extension is on",
    );
    // A change reported by the daemon (a cloud row switched off elsewhere) is read again.
    harness.daemon.state.voiceStatus = {
      ...harness.daemon.state.voiceStatus,
      available: false,
      reason: "no STT provider available",
      stt: null,
      tts: null,
    };
    harness.store.dispatch({ type: "extension.changed" });
    await waitFor(() =>
      expect(within(providers).getByTestId("voice-available")).toHaveTextContent("unavailable"),
    );
    expect(within(providers).getByTestId("voice-reason")).toHaveTextContent(
      "no STT provider available",
    );
    expect(within(providers).getByTestId("voice-stt")).toHaveTextContent("none");
  });
});

describe("reattachDelay", () => {
  it("backs off from half a second to ten seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(reattachDelay)).toEqual([
      500, 1000, 2000, 4000, 8000, 10000, 10000, 10000,
    ]);
  });
});

describe("installProgress", () => {
  it("keeps the last figure per download and the last messages, with the result's tone", () => {
    const p = installProgress([
      { seq: 1, event: { type: "step", step: "packages", message: "installing" } },
      { seq: 2, event: { type: "progress", what: "torch", bytes: 10_000_000, total: 100_000_000 } },
      { seq: 3, event: { type: "progress", what: "torch", bytes: 50_000_000, total: 100_000_000 } },
      { seq: 4, event: { type: "warning", message: "GPU check failed" } },
      {
        seq: 5,
        event: {
          type: "result",
          ok: true,
          profile: "gpu",
          exitCode: 2,
          message: "done, CPU stands in",
        },
      },
    ]);
    expect(p.bars).toEqual([{ what: "torch", percent: 50, text: "50.0 of 100.0 MB" }]);
    expect(p.lines.map((l) => l.tone)).toEqual(["neutral", "warn", "warn"]);
    expect(p.result).toEqual({ ok: true, exitCode: 2, message: "done, CPU stands in" });
  });
});
