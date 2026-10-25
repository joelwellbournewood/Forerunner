import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { VoiceStatusView } from "../src/api/client.ts";
import { summarizePermissions, voiceBadges } from "../src/pages/ExtensionsPage.tsx";
import { EXTENSIONS, VOICE_STATUS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * The daemon's status once the `voice-deepgram` row is no longer the panel's choice (switched
 * off or removed): nothing preferred, the local STT in force by the policy, Kokoro unchanged.
 */
const LOCAL_STT_STATUS: VoiceStatusView = {
  ...VOICE_STATUS,
  reason:
    'local provider "faster-whisper": faster_whisper importable; local provider "kokoro": kokoro importable',
  stt: {
    name: "faster-whisper",
    kind: "local",
    policy: "local",
    reason: 'local provider "faster-whisper": faster_whisper importable',
  },
  preferences: { stt: null, tts: null, skipped: [] },
};

describe("Extensions panel", () => {
  it("summarises permissions by count", () => {
    const github = EXTENSIONS[0];
    if (!github) throw new Error("fixture");
    expect(summarizePermissions(github.permissions)).toBe(
      "2 tools · 2 action classes · 1 domains · 1 secrets · 2 scopes",
    );
    expect(
      summarizePermissions({
        tools: [],
        actionClasses: [],
        domains: [],
        paths: [],
        secrets: [],
        scopes: [],
      }),
    ).toBe("no permissions");
  });

  it("lists every kind with status, version, cost and permissions, pending first for approval", async () => {
    renderApp("/extensions");
    const rows = await screen.findAllByTestId("extension");
    expect(rows).toHaveLength(6);
    const github = rows.find((r) => r.dataset.extensionId === "ext_github");
    if (!github) throw new Error("no github row");
    expect(github).toHaveAttribute("data-kind", "connector");
    expect(within(github).getByTestId("extension-status")).toHaveTextContent("enabled");
    expect(github).toHaveTextContent("v1.4.0");
    expect(github).toHaveTextContent("CHF 1.00");
    expect(within(github).getByTestId("extension-permissions")).toHaveTextContent("2 tools");
    expect(within(github).getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("extensions-group-model_provider")).toHaveTextContent("Anthropic");
    expect(screen.getByTestId("extensions-group-specialist")).toHaveTextContent("researcher");
    expect(screen.getByTestId("extensions-pending")).toHaveTextContent(
      "1 waiting for your approval",
    );
    const slack = rows.find((r) => r.dataset.extensionId === "ext_slack");
    if (!slack) throw new Error("no slack row");
    expect(within(slack).getByTestId("extension-review")).toHaveTextContent("high risk");
    expect(within(slack).getByTestId("extension-review")).toHaveTextContent(
      "needs secret:slack_token",
    );
    expect(within(slack).getByTestId("extension-approve")).toBeInTheDocument();
  });

  it("toggles an extension and removes one after a confirmation", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const rows = await screen.findAllByTestId("extension");
    const github = rows.find((r) => r.dataset.extensionId === "ext_github");
    if (!github) throw new Error("no github row");
    await user.click(within(github).getByTestId("extension-toggle"));
    await waitFor(() =>
      expect(within(github).getByTestId("extension-toggle")).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(postedCalls(harness, "/extensions/ext_github/toggle")[0]?.body).toEqual({
      enabled: false,
    });
    expect(within(github).getByTestId("extension-status")).toHaveTextContent("disabled");

    const browser = rows.find((r) => r.dataset.extensionId === "ext_browser");
    if (!browser) throw new Error("no browser row");
    await user.click(within(browser).getByTestId("extension-remove"));
    await user.click(within(browser).getByTestId("extension-remove-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("extension")).toHaveLength(5));
    expect(postedCalls(harness, "/extensions/ext_browser")[0]?.method).toBe("DELETE");
  });

  it("says which voice provider is in force and why a voice row is not (spec O.4)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const card = await screen.findByTestId("voice-providers");
    expect(within(card).getByTestId("voice-available")).toHaveTextContent("available");
    expect(within(card).getByTestId("voice-stt")).toHaveTextContent(
      'deepgram (cloud; "deepgram" selected in Extensions (voice-deepgram))',
    );
    expect(within(card).getByTestId("voice-tts")).toHaveTextContent("kokoro (local;");
    // The card sits with the capabilities, where the voice rows are.
    expect(screen.getByTestId("extensions-group-capability")).toContainElement(card);
    const rows = await screen.findAllByTestId("extension");
    const deepgram = rows.find((r) => r.dataset.extensionId === "ext_voice_deepgram");
    if (!deepgram) throw new Error("no voice row");
    expect(within(deepgram).getByTestId("extension-voice")).toHaveTextContent("in force for STT");
    const browser = rows.find((r) => r.dataset.extensionId === "ext_browser");
    expect(browser && within(browser).queryByTestId("extension-voice")).toBeNull();

    // Switched off in the panel: the daemon reports the row skipped as switched off, keeps
    // Deepgram out of the policy's fallback (its status row says so, the key not looked at)
    // and the local STT is in force; the toggle re-reads the status.
    harness.daemon.state.voiceStatus = {
      ...LOCAL_STT_STATUS,
      statuses: {
        ...VOICE_STATUS.statuses,
        stt: [
          {
            name: "faster-whisper",
            kind: "local",
            available: true,
            reason: "faster_whisper importable",
            selected: true,
          },
          {
            name: "deepgram",
            kind: "cloud",
            available: false,
            reason: "switched off in Extensions",
            secretRef: "secret:deepgram_api_key",
            selected: false,
          },
        ],
      },
      preferences: {
        stt: null,
        tts: null,
        skipped: [
          {
            extensionId: "ext_voice_deepgram",
            extension: "voice-deepgram",
            side: "stt",
            provider: "deepgram",
            reason: "switched off in Extensions",
          },
        ],
      },
    };
    await user.click(within(deepgram).getByTestId("extension-toggle"));
    await waitFor(() =>
      expect(within(deepgram).getByTestId("extension-voice")).toHaveTextContent(
        "not in force for STT: switched off in Extensions",
      ),
    );
    expect(within(card).getByTestId("voice-stt")).toHaveTextContent("faster-whisper (local;");
    // A change the daemon reports (no toggle here) reloads it too.
    harness.daemon.state.voiceStatus = {
      ...VOICE_STATUS,
      available: false,
      reason: "no model credential configured; run fr setup",
      stt: null,
      tts: null,
    };
    harness.store.dispatch({ type: "extension.changed" });
    await waitFor(() =>
      expect(screen.getByTestId("voice-available")).toHaveTextContent("unavailable"),
    );
    expect(screen.getByTestId("voice-reason")).toHaveTextContent("no model credential");
    expect(screen.getByTestId("voice-stt")).toHaveTextContent("none");
  });

  it("removing a voice row re-reads the voice status: the card drops its provider at once", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const card = await screen.findByTestId("voice-providers");
    expect(within(card).getByTestId("voice-stt")).toHaveTextContent("deepgram (cloud;");
    const rows = await screen.findAllByTestId("extension");
    const deepgram = rows.find((r) => r.dataset.extensionId === "ext_voice_deepgram");
    if (!deepgram) throw new Error("no voice row");
    // With the row gone the policy picks the local STT; the panel shows that right after the
    // removal, without waiting for the daemon's extension.changed frame.
    harness.daemon.state.voiceStatus = LOCAL_STT_STATUS;
    await user.click(within(deepgram).getByTestId("extension-remove"));
    await user.click(within(deepgram).getByTestId("extension-remove-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("extension")).toHaveLength(5));
    expect(postedCalls(harness, "/extensions/ext_voice_deepgram")[0]?.method).toBe("DELETE");
    await waitFor(() =>
      expect(screen.getByTestId("voice-stt")).toHaveTextContent("faster-whisper (local;"),
    );
    expect(screen.getByTestId("voice-available")).toHaveTextContent("available");
  });

  it("voiceBadges: in force, preferred but fallen back, skipped with the reason, nothing for other rows", () => {
    const row = { id: "ext_voice_deepgram" };
    expect(voiceBadges(row, null)).toEqual([]);
    expect(voiceBadges({ id: "ext_browser" }, VOICE_STATUS)).toEqual([]);
    expect(voiceBadges(row, VOICE_STATUS)).toEqual([{ tone: "good", text: "in force for STT" }]);
    // Preferred by the row but the registry fell back (the probe failed): say so with its reason.
    expect(
      voiceBadges(row, {
        ...VOICE_STATUS,
        stt: {
          name: "faster-whisper",
          kind: "local",
          policy: "local",
          reason:
            'preferred "deepgram" unavailable (socket refused); local provider "faster-whisper": ok',
        },
      }),
    ).toEqual([
      {
        tone: "warn",
        text: 'preferred for STT, not in force: preferred "deepgram" unavailable (socket refused); local provider "faster-whisper": ok',
      },
    ]);
    expect(
      voiceBadges(row, {
        ...VOICE_STATUS,
        preferences: {
          stt: null,
          tts: null,
          skipped: [
            {
              extensionId: "ext_voice_deepgram",
              extension: "voice-deepgram",
              side: "stt",
              provider: "deepgram",
              reason: "overridden by FORERUNNER_VOICE_STT=fake-stt",
            },
          ],
        },
      }),
    ).toEqual([
      { tone: "warn", text: "not in force for STT: overridden by FORERUNNER_VOICE_STT=fake-stt" },
    ]);
    // A switched-off row carries the daemon's reason like any other row not in force.
    expect(
      voiceBadges(row, {
        ...VOICE_STATUS,
        preferences: {
          stt: null,
          tts: null,
          skipped: [
            {
              extensionId: "ext_voice_deepgram",
              extension: "voice-deepgram",
              side: "stt",
              provider: "deepgram",
              reason: "switched off in Extensions",
            },
          ],
        },
      }),
    ).toEqual([{ tone: "warn", text: "not in force for STT: switched off in Extensions" }]);
  });

  it("voiceBadges: a row is in force when the pick is any provider it stands for (Piper for voice-local)", () => {
    // The local row stands for Kokoro and Piper. Kokoro is preferred first; when it does not
    // import and the policy picks Piper, the human's choice (local TTS) is in force, so the
    // row must not be flagged as fallen back.
    const local = { id: "ext_voice_local" };
    const piper: VoiceStatusView = {
      ...VOICE_STATUS,
      tts: {
        name: "piper",
        kind: "local",
        policy: "local",
        reason:
          'preferred "kokoro" unavailable (kokoro not importable); local provider "piper": piper on PATH',
      },
      preferences: {
        stt: null,
        tts: {
          name: "kokoro",
          source: "extension",
          extensionId: "ext_voice_local",
          extension: "voice-local",
          providers: ["kokoro", "piper"],
        },
        skipped: [],
      },
    };
    expect(voiceBadges(local, piper)).toEqual([{ tone: "good", text: "in force for TTS" }]);
    // A pick outside the row's providers is still a fallback away from it, with the reason.
    const cloud: VoiceStatusView = {
      ...piper,
      tts: {
        name: "cartesia",
        kind: "cloud",
        policy: "cloud",
        reason: 'preferred "kokoro" unavailable (kokoro not importable); no local TTS provider',
      },
    };
    expect(voiceBadges(local, cloud)).toEqual([
      {
        tone: "warn",
        text: 'preferred for TTS, not in force: preferred "kokoro" unavailable (kokoro not importable); no local TTS provider',
      },
    ]);
  });

  it("adds a connector from the catalog, which waits for approval, then approves it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    await screen.findAllByTestId("extension");
    await user.click(screen.getByTestId("add-extension"));
    const dialog = await screen.findByTestId("add-extension-dialog");
    await waitFor(() => expect(within(dialog).getAllByTestId("catalog-entry").length).toBe(4));
    await user.type(within(dialog).getByTestId("catalog-search"), "linear");
    await waitFor(() => expect(within(dialog).getAllByTestId("catalog-entry")).toHaveLength(1));
    await user.click(within(dialog).getByTestId("catalog-add"));
    await waitFor(() => expect(postedCalls(harness, "/extensions")).toHaveLength(1));
    expect(postedCalls(harness, "/extensions")[0]?.body).toEqual({ catalogId: "linear" });
    expect(await screen.findByTestId("extensions-notice")).toHaveTextContent(
      "waits for your approval",
    );
    const linear = (await screen.findAllByTestId("extension")).find((r) =>
      r.textContent?.includes("Linear"),
    );
    if (!linear) throw new Error("no linear row");
    expect(linear).toHaveAttribute("data-status", "pending_approval");
    // The grant request also reached the inbox (spec L.5).
    expect(harness.daemon.state.requests.some((r) => r.kind === "capability_grant")).toBe(true);
    await user.click(within(linear).getByTestId("extension-approve"));
    await waitFor(() => expect(linear).toHaveAttribute("data-status", "enabled"));
    expect(within(linear).getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("adds an MCP server from a URL and denies it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    await screen.findAllByTestId("extension");
    await user.click(screen.getByTestId("add-extension"));
    const dialog = await screen.findByTestId("add-extension-dialog");
    await user.type(within(dialog).getByTestId("add-url"), "https://mcp.example.test/tools");
    await user.click(within(dialog).getByTestId("add-url-submit"));
    await waitFor(() => expect(postedCalls(harness, "/extensions")).toHaveLength(1));
    expect(postedCalls(harness, "/extensions")[0]?.body).toEqual({
      url: "https://mcp.example.test/tools",
    });
    const row = (await screen.findAllByTestId("extension")).find((r) =>
      r.textContent?.includes("mcp.example.test"),
    );
    if (!row) throw new Error("no url row");
    expect(row).toHaveAttribute("data-status", "pending_approval");
    await user.click(within(row).getByTestId("extension-deny"));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("extension").some((r) => r.textContent?.includes("mcp.example.test")),
      ).toBe(false),
    );
  });

  it("reloads when the daemon reports an extension change", async () => {
    const harness = createHarness();
    renderApp("/extensions", harness);
    await screen.findAllByTestId("extension");
    harness.daemon.state.extensions = harness.daemon.state.extensions.filter(
      (e) => e.id !== "ext_slack",
    );
    harness.store.dispatch({ type: "extension.changed" });
    await waitFor(() => expect(screen.getAllByTestId("extension")).toHaveLength(5));
  });
});
