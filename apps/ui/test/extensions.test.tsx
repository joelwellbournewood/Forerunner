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
    // U-023: the model provider is set in setup; the group says so and lists no switch.
    const models = screen.getByTestId("extensions-group-model_provider");
    expect(within(models).getByTestId("extensions-model-pointer")).toHaveTextContent(
      "set in Settings",
    );
    expect(within(models).queryByTestId("extension")).toBeNull();
    expect(screen.getByTestId("extensions-group-skill")).toHaveTextContent("pdf-tools");
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

  it("points to Settings → Voice for voice, and each cloud voice row says whether it is in force (U-023, spec O.4)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const rows = await screen.findAllByTestId("extension");
    // One place for voice: the providers in force are shown in Settings -> Voice, not here.
    const capabilities = screen.getByTestId("extensions-group-capability");
    expect(screen.queryByTestId("voice-providers")).toBeNull();
    const pointer = within(capabilities).getByTestId("extensions-voice-pointer");
    expect(pointer).toHaveTextContent("Settings → Voice");
    expect(within(pointer).getByRole("link", { name: "Settings → Voice" })).toHaveAttribute(
      "href",
      "/settings",
    );
    const deepgram = rows.find((r) => r.dataset.extensionId === "ext_voice_deepgram");
    if (!deepgram) throw new Error("no voice row");
    await waitFor(() =>
      expect(within(deepgram).getByTestId("extension-voice")).toHaveTextContent("in force for STT"),
    );
    const browser = rows.find((r) => r.dataset.extensionId === "ext_browser");
    expect(browser && within(browser).queryByTestId("extension-voice")).toBeNull();

    // Switched off in the panel: the daemon reports the row skipped as switched off and the
    // toggle re-reads the status, so the row says why it is no longer in force.
    harness.daemon.state.voiceStatus = {
      ...LOCAL_STT_STATUS,
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
    // A change the daemon reports (no toggle here) re-reads it too.
    harness.daemon.state.voiceStatus = LOCAL_STT_STATUS;
    harness.store.dispatch({ type: "extension.changed" });
    await waitFor(() => expect(within(deepgram).queryByTestId("extension-voice")).toBeNull());
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

  /** Add on the catalog entry "linear" in the panel: the confirmation dialog it opens. */
  const addLinear = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findAllByTestId("extension");
    await user.click(screen.getByTestId("add-extension"));
    const dialog = await screen.findByTestId("add-extension-dialog");
    await waitFor(() => expect(within(dialog).getAllByTestId("catalog-entry").length).toBe(4));
    await user.type(within(dialog).getByTestId("catalog-search"), "linear");
    await waitFor(() => expect(within(dialog).getAllByTestId("catalog-entry")).toHaveLength(1));
    await user.click(within(dialog).getByTestId("catalog-add"));
    return screen.findByTestId("grant-dialog");
  };

  it("Add on a built-in entry opens a confirmation in the panel with the change card; Confirm grants it on this device, with no Inbox card (U-026)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const confirm = await addLinear(user);
    expect(postedCalls(harness, "/extensions")[0]?.body).toEqual({
      catalogId: "linear",
      confirmIn: "panel",
    });
    expect(screen.queryByTestId("add-extension-dialog")).toBeNull();
    // The change card: risk, tools with their class and risk, domains, secrets, scopes.
    const card = within(confirm).getByTestId("grant-card");
    expect(card).toHaveAttribute("data-risk", "high");
    expect(card).toHaveTextContent("high risk");
    expect(within(card).getByTestId("grant-tools")).toHaveTextContent(
      "linear.list_issues (read, low risk)",
    );
    const permissions = within(card).getByTestId("grant-permissions");
    expect(permissions).toHaveTextContent("api.linear.app");
    expect(permissions).toHaveTextContent("secret:linear_key");
    expect(permissions).toHaveTextContent("read, routine_reversible");
    expect(within(confirm).getByTestId("grant-needs-device")).toHaveTextContent(
      "confirmed in the app on a paired device",
    );
    expect(within(confirm).getByTestId("grant-needs-device")).toHaveTextContent(
      "Cancel adds nothing",
    );
    // Nothing went to the Inbox for what the person is doing right here.
    expect(harness.daemon.state.requests.some((r) => r.kind === "capability_grant")).toBe(false);
    await user.click(within(confirm).getByTestId("grant-confirm"));
    await waitFor(() => expect(screen.queryByTestId("grant-dialog")).toBeNull());
    const approve = harness.daemon.state.calls.find((c) =>
      /\/extensions\/ext_\d+\/approve$/.test(c.path),
    );
    // The high-risk answer is a device answer naming this PC, as on a change card.
    expect(approve?.body).toEqual({ answer: "device", deviceId: "device_this_pc" });
    expect(await screen.findByTestId("extensions-notice")).toHaveTextContent(
      "Linear is added and enabled.",
    );
    const linear = (await screen.findAllByTestId("extension")).find((r) =>
      r.textContent?.includes("Linear"),
    );
    if (!linear) throw new Error("no linear row");
    expect(linear).toHaveAttribute("data-status", "enabled");
    expect(within(linear).getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
    expect(harness.daemon.state.requests.some((r) => r.kind === "capability_grant")).toBe(false);
  });

  it("Cancel in the confirmation adds nothing (U-026)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const confirm = await addLinear(user);
    await user.click(within(confirm).getByTestId("grant-cancel"));
    await waitFor(() => expect(screen.queryByTestId("grant-dialog")).toBeNull());
    expect(
      harness.daemon.state.calls.some((c) => /\/extensions\/ext_\d+\/deny$/.test(c.path)),
    ).toBe(true);
    expect(harness.daemon.state.calls.some((c) => c.path.endsWith("/approve"))).toBe(false);
    expect(await screen.findByTestId("extensions-notice")).toHaveTextContent(
      "Cancelled: Linear was not added.",
    );
    expect(screen.getAllByTestId("extension").some((r) => r.textContent?.includes("Linear"))).toBe(
      false,
    );
    expect(harness.daemon.state.extensions.some((e) => e.name === "Linear")).toBe(false);
    expect(harness.daemon.state.requests.some((r) => r.kind === "capability_grant")).toBe(false);
  });

  it("a confirmation the daemon refuses says why in the dialog and grants nothing (U-026)", async () => {
    const user = userEvent.setup();
    // `/me` names a device this daemon does not have (a stale id): the policy refuses it.
    const harness = createHarness({ me: { desktopDeviceId: "device_gone" } });
    renderApp("/extensions", harness);
    const confirm = await addLinear(user);
    await user.click(within(confirm).getByTestId("grant-confirm"));
    expect(await within(confirm).findByTestId("grant-error")).toHaveTextContent(
      "unknown device; pair it first",
    );
    expect(screen.getByTestId("grant-dialog")).toBeInTheDocument();
    expect(harness.daemon.state.extensions.find((e) => e.name === "Linear")?.status).toBe(
      "pending_approval",
    );
  });

  it("Approve on a row waiting from a URL opens the same confirmation and sends the device answer", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const rows = await screen.findAllByTestId("extension");
    const slack = rows.find((r) => r.dataset.extensionId === "ext_slack");
    if (!slack) throw new Error("no slack row");
    // Its card is in the Inbox: the review says so.
    expect(within(slack).getByTestId("extension-review")).toHaveTextContent("also in the inbox");
    await user.click(within(slack).getByTestId("extension-approve"));
    const confirm = await screen.findByTestId("grant-dialog");
    expect(within(confirm).getByTestId("grant-tools")).toHaveTextContent(
      "slack.post_message (external_send, high risk)",
    );
    expect(within(confirm).getByTestId("grant-needs-device")).not.toHaveTextContent(
      "Cancel adds nothing",
    );
    await user.click(within(confirm).getByTestId("grant-confirm"));
    await waitFor(() => expect(slack).toHaveAttribute("data-status", "enabled"));
    expect(postedCalls(harness, "/extensions/ext_slack/approve")[0]?.body).toEqual({
      answer: "device",
      deviceId: "device_this_pc",
    });
  });

  it("explains an empty Specialists group instead of 'None installed' (U-077)", async () => {
    const harness = createHarness();
    harness.daemon.state.extensions = harness.daemon.state.extensions.filter(
      (e) => e.kind !== "specialist",
    );
    renderApp("/extensions", harness);
    const group = await screen.findByTestId("extensions-group-specialist");
    const note = within(group).getByTestId("specialists-builtin");
    expect(note).toHaveTextContent(
      "None added here. The built-in specialists come with Forerunner and are not listed as extensions; their models are in Settings → Models per agent and specialist.",
    );
    expect(within(note).getByRole("link")).toHaveAttribute("href", "/settings");
    expect(group).not.toHaveTextContent("None installed");
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

  it("the agent's email row is read-only and points to the Email page (U-075)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const browser = harness.daemon.state.extensions.find((e) => e.id === "ext_browser");
    if (!browser) throw new Error("fixture");
    // The row the daemon lists once the Email page has been opened (the agent's settings).
    harness.daemon.state.extensions.push({
      ...browser,
      id: "ext_email_alice",
      name: "email:agent_alice",
      status: "enabled",
      enabled: true,
      description:
        "Your agent's own mailbox: its mode, limits and mailbox are set on the Email page.",
      permissions: { ...browser.permissions, tools: [], domains: [] },
      source: null,
      managedIn: "email",
    });
    renderApp("/extensions", harness);
    const rows = await screen.findAllByTestId("extension");
    const email = rows.find((r) => r.dataset.extensionId === "ext_email_alice");
    if (!email) throw new Error("no email row");
    // No switch that does nothing and no Remove that would delete the mailbox settings.
    expect(within(email).queryByTestId("extension-toggle")).toBeNull();
    expect(within(email).queryByTestId("extension-remove")).toBeNull();
    const link = within(email).getByRole("link", { name: "set on the Email page" });
    expect(link).toHaveAttribute("href", "/settings/capabilities/email");
    await user.click(link);
    expect(await screen.findByTestId("email-intro")).toBeInTheDocument();
    expect(postedCalls(harness, "/extensions/ext_email_alice/toggle")).toEqual([]);
  });
});
