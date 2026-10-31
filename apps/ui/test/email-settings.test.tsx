import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  FULL_DISCRETION_WARNING,
  ignoredReason,
  interpretationOf,
  MODE_MEANINGS,
  parseLines,
  resultOf,
} from "../src/pages/EmailSettingsPage.tsx";
import { EMAIL_COMMANDS } from "./fixtures.ts";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings -> Capabilities -> Email (spec S.15, S.28, S.29, T.14; ADR 0066, amended
 * 2026-10-25): one card per agent of the signed-in human with the mode picker and the five
 * meanings, the plain full-discretion sentence before the change and again in the
 * confirmation; a mode change as the registry's `email.mode.set` (spec Q, high risk: the
 * change card, the confirmation on this paired device, the change log row, Undo; No cancels
 * the card and changes nothing; never a raw PUT), pause and resume through the tray's routes,
 * the limits and the allowlist where the mode needs it, the mailbox by reference, the marker
 * rotation, the command audit newest first and the route-unavailable state against a daemon
 * without the routes.
 */
const card = async (agentId = "agent_alice") => {
  const cards = await screen.findAllByTestId("email-agent");
  const found = cards.find((c) => c.dataset.agentId === agentId);
  if (!found) throw new Error(`no email card for ${agentId}`);
  return found;
};

/** The bodies of every `POST /commands/:id/confirm` the page sent, in order. */
const confirmBodies = (harness: Harness) =>
  harness.daemon.state.calls
    .filter((c) => /^\/commands\/[^/]+\/confirm$/.test(c.path))
    .map((c) => c.body);

describe("Settings -> Capabilities -> Email", () => {
  it("formats the audit rows: the interpretation, the result and the reason a mail was ignored", () => {
    const [spoofed, task, question] = EMAIL_COMMANDS;
    if (!spoofed || !task || !question) throw new Error("fixture");
    expect(ignoredReason(spoofed)).toBe("spoofed sender");
    expect(ignoredReason(task)).toBeNull();
    expect(interpretationOf(spoofed)).toBe("not interpreted");
    expect(interpretationOf(task)).toBe("task: Add a retry to the uploader");
    expect(interpretationOf(question)).toBe("question: Where does Atlas stand?");
    expect(resultOf(spoofed)).toBe("ignored: spoofed_sender");
    expect(resultOf(task)).toBe("task · task task_9 · session sess_2");
    expect(resultOf(question)).toBe("question");
    expect(parseLines(" a@example.test \n\n*.partner.test\r\n")).toEqual([
      "a@example.test",
      "*.partner.test",
    ]);
  });

  it("is reachable from Settings and lists the human's agents with the mode picker, the five meanings and the full-discretion sentence before any change", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByTestId("capability-email"));
    expect(await screen.findByTestId("email-intro")).toHaveTextContent("never your personal inbox");
    const cards = await screen.findAllByTestId("email-agent");
    // U-075: only Alice's own agent has a card. The daemon uses the principal agent's mailbox
    // alone, so a configurable card for the critic set something nothing reads; Bob's agent
    // is not hers to see.
    expect(cards.map((c) => c.dataset.agentId)).toEqual(["agent_alice"]);
    expect(screen.getByTestId("email-principal-only")).toHaveTextContent(
      "Email is used by your agent (Alice's agent) only",
    );
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode")).toHaveTextContent("Draft only"),
    );
    expect(within(alice).getByTestId("email-address")).toHaveTextContent(
      "alice-agent@agents.example.test",
    );
    const options = within(alice).getAllByTestId("email-mode-option");
    expect(options.map((o) => o.dataset.mode)).toEqual([
      "off",
      "read_only",
      "draft_only",
      "allowlist",
      "full_discretion",
    ]);
    for (const option of options) {
      const mode = option.dataset.mode as keyof typeof MODE_MEANINGS;
      expect(option).toHaveTextContent(MODE_MEANINGS[mode]);
    }
    expect(within(alice).getByRole("radio", { name: /Draft only/ })).toBeChecked();
    // The plain sentence of S.29 is on the screen before the human changes anything.
    expect(within(alice).getByTestId("full-discretion-warning")).toHaveTextContent(
      "the agent can email strangers on your behalf",
    );
    expect(within(alice).getByTestId("full-discretion-warning")).toHaveTextContent(
      FULL_DISCRETION_WARNING,
    );
    expect(within(alice).getByTestId("email-mode-apply")).toBeDisabled();
  });

  it("a switch to full discretion runs email.mode.set: the card with the sentence repeated, No cancels it and changes nothing, the device confirmation sets the mode with a change log row, and Undo puts it back; no PUT carries the mode", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode-current")).toHaveTextContent("Draft only"),
    );
    await user.click(within(alice).getByRole("radio", { name: /Full discretion/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    // The registry's command, the same one chat and voice run, logged as `ui` (spec Q.1).
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        { name: "email.mode.set", params: { mode: "full_discretion", agent: "agent_alice" } },
      ],
      wordsUsed: "Settings: email mode of Alice's agent to Full discretion",
      source: "ui",
    });
    const dialog = await screen.findByTestId("email-mode-dialog");
    // S.29: the plain sentence again, in the confirmation, beside the card.
    expect(within(dialog).getByTestId("full-discretion-confirm-text")).toHaveTextContent(
      FULL_DISCRETION_WARNING,
    );
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_device");
    expect(within(pending).getByTestId("change-card")).toHaveAttribute("data-risk", "high");
    expect(within(pending).getByTestId("card-old")).toHaveTextContent("Draft only");
    expect(within(pending).getByTestId("card-new")).toHaveTextContent("Full discretion");
    expect(within(pending).getByTestId("needs-device")).toBeInTheDocument();
    // No: the card is cancelled on the daemon, nothing changed, the picker shows the old mode.
    await user.click(within(pending).getByTestId("command-no"));
    const cancelled = await within(dialog).findByTestId("command-cancelled");
    expect(confirmBodies(harness)).toEqual([{ answer: "no" }]);
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("draft_only");
    expect(harness.daemon.state.pendingCommands.size).toBe(0);
    await user.click(within(cancelled).getByTestId("command-close"));
    await waitFor(() => expect(screen.queryByTestId("email-mode-dialog")).toBeNull());
    expect(within(alice).getByRole("radio", { name: /Draft only/ })).toBeChecked();
    expect(within(alice).getByTestId("email-mode")).toHaveTextContent("Draft only");

    // Again, confirmed on this paired device: the sentence, the change log row, the badge.
    await user.click(within(alice).getByRole("radio", { name: /Full discretion/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    const again = await screen.findByTestId("email-mode-dialog");
    const pending2 = await within(again).findByTestId("command-pending");
    await user.click(within(pending2).getByTestId("command-yes"));
    const done = await within(again).findByTestId("command-done");
    const sentence =
      "Changed the email mode of Alice's agent from Draft only to Full discretion. Undo.";
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      sentence.replace(/ Undo\.$/, ""),
    );
    // The spoken "Undo." is the Undo button in the app (U-074).
    expect(within(done).getByTestId("command-sentence")).not.toHaveTextContent("Undo.");
    expect(within(done).getByTestId("command-undo")).toHaveTextContent("Undo");
    expect(confirmBodies(harness)).toEqual([
      { answer: "no" },
      { answer: "device", deviceId: "device_this_pc" },
    ]);
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("full_discretion");
    const entry = harness.daemon.state.changes[0];
    expect(entry).toMatchObject({
      source: "ui",
      sentence,
      wordsUsed: "Settings: email mode of Alice's agent to Full discretion",
      commands: [
        { name: "email.mode.set", params: { mode: "full_discretion", agent: "agent_alice" } },
      ],
      before: { agent_id: "agent_alice", mode: "draft_only", commands_enabled: true },
      after: { agent_id: "agent_alice", mode: "full_discretion", commands_switched_off: false },
    });
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode")).toHaveTextContent("Full discretion"),
    );
    expect(within(alice).getByTestId("email-mode-note")).toHaveTextContent(sentence);
    // The raw route never carried the mode.
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(0);
    // The card's Undo is the change log's: the mode goes back and the page re-reads it.
    await user.click(within(done).getByTestId("command-undo"));
    await waitFor(() => expect(postedCalls(harness, `/changes/${entry?.id}/undo`)).toHaveLength(1));
    expect(await within(again).findByTestId("command-sentence")).toHaveTextContent(
      "Undone: Changed the email mode of Alice's agent from Draft only to Full discretion.",
    );
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("draft_only");
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode")).toHaveTextContent("Draft only"),
    );
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(0);
  });

  it("every mode change is the high-risk card (allowlist too, without the full-discretion sentence); once confirmed the allowlist editor shows and saves the entries with the caps through PUT", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode-current")).toHaveTextContent("Draft only"),
    );
    expect(within(alice).queryByTestId("email-allowlist")).toBeNull();
    await user.click(within(alice).getByRole("radio", { name: /Allowlist/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    const dialog = await screen.findByTestId("email-mode-dialog");
    expect(within(dialog).queryByTestId("full-discretion-confirm-text")).toBeNull();
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_device");
    expect(within(pending).getByTestId("card-new")).toHaveTextContent("Allowlist");
    await user.click(within(pending).getByTestId("command-yes"));
    const done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      "Changed the email mode of Alice's agent from Draft only to Allowlist.",
    );
    await user.click(within(done).getByTestId("command-close"));
    await waitFor(() => expect(screen.queryByTestId("email-mode-dialog")).toBeNull());
    expect(postedCalls(harness, "/commands/execute")).toHaveLength(1);
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(0);
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("allowlist");
    const allowlist = await within(alice).findByTestId("email-allowlist");
    expect(within(allowlist).getByTestId("allowlist-addresses")).toHaveValue(
      "partner@example.test",
    );
    await user.clear(within(allowlist).getByTestId("allowlist-domains"));
    await user.type(
      within(allowlist).getByTestId("allowlist-domains"),
      "partner.test\n*.vendor.test",
    );
    await user.clear(within(alice).getByTestId("limit-daily"));
    await user.type(within(alice).getByTestId("limit-daily"), "12");
    await user.click(within(alice).getByTestId("limits-save"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")[0]?.body).toEqual({
      settings: {
        dailySendCap: 12,
        perRecipientDailyCap: 5,
        signature: {
          enabled: true,
          text: "{agent} is an AI agent acting for {human}. This message was written and sent by the agent.",
        },
        dailyDigest: false,
        allowlist: {
          addresses: ["partner@example.test"],
          domains: ["partner.test", "*.vendor.test"],
        },
      },
    });
    expect(await within(alice).findByTestId("limits-saved")).toHaveTextContent("Saved.");
    expect(harness.daemon.state.email.agent_alice?.settings).toMatchObject({
      mode: "allowlist",
      dailySendCap: 12,
      allowlist: {
        addresses: ["partner@example.test"],
        domains: ["partner.test", "*.vendor.test"],
      },
    });
  });

  it("pauses and resumes through the tray's routes and shows the state", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-paused")).toHaveTextContent("sending active"),
    );
    await user.click(within(alice).getByTestId("email-pause"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/pause")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(alice).getByTestId("email-paused")).toHaveTextContent(
        "paused: every send is held",
      ),
    );
    expect(harness.daemon.state.email.agent_alice?.settings.paused).toBe(true);
    expect(within(alice).getByTestId("email-pause")).toHaveTextContent("Resume email");
    await user.click(within(alice).getByTestId("email-pause"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/resume")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(alice).getByTestId("email-paused")).toHaveTextContent("sending active"),
    );
    expect(harness.daemon.state.email.agent_alice?.settings.paused).toBe(false);
  });

  it("saves the mailbox with credentials as references", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // An agent without a mailbox yet (U-075: the principal's card is the only one).
    const stored = harness.daemon.state.email.agent_alice;
    if (!stored) throw new Error("fixture");
    stored.settings.mailbox = null;
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-address")).toHaveTextContent("no mailbox configured"),
    );
    const mailbox = await within(alice).findByTestId("email-mailbox");
    await user.type(within(mailbox).getByTestId("mailbox-address"), "alice@agents.example.test");
    await user.type(within(mailbox).getByTestId("imap-host"), "imap.example.test");
    await user.type(within(mailbox).getByTestId("imap-user"), "alice");
    await user.type(within(mailbox).getByTestId("imap-ref"), "secret:alice_imap");
    await user.click(within(mailbox).getByTestId("mailbox-save"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")[0]?.body).toEqual({
      settings: {
        mailbox: {
          address: "alice@agents.example.test",
          imap: {
            host: "imap.example.test",
            port: 993,
            user: "alice",
            passwordRef: "secret:alice_imap",
          },
          smtp: null,
        },
      },
    });
    expect(await within(mailbox).findByTestId("mailbox-saved")).toHaveTextContent("Saved.");
    await waitFor(() =>
      expect(within(alice).getByTestId("email-address")).toHaveTextContent(
        "alice@agents.example.test",
      ),
    );
  });

  it("refuses a value in place of a reference and rotates the marker", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    // A value in place of a reference is the daemon's 400, shown as such and nothing saved.
    const alice = await card();
    const aliceMailbox = await within(alice).findByTestId("email-mailbox");
    await user.clear(within(aliceMailbox).getByTestId("smtp-ref"));
    await user.type(within(aliceMailbox).getByTestId("smtp-ref"), "hunter22xyz");
    await user.click(within(aliceMailbox).getByTestId("mailbox-save"));
    expect(await within(aliceMailbox).findByTestId("error-banner")).toHaveTextContent(
      "must be a secret reference",
    );
    expect(harness.daemon.state.email.agent_alice?.settings.mailbox?.smtp?.passwordRef).toBe(
      "secret:alice_agent_smtp",
    );

    const before = within(alice).getByTestId("email-marker").textContent;
    expect(before).toBe("[FR-7k2q]");
    await user.click(within(alice).getByTestId("marker-rotate"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/rotate-marker")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(alice).getByTestId("email-marker").textContent).not.toBe(before),
    );
    expect(within(alice).getByTestId("email-marker").textContent).toBe(
      harness.daemon.state.email.agent_alice?.commands.marker,
    );
  });

  it("saving the mailbox keeps the stored secure, folder and drafts-folder values the form has no field for", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // A mailbox set up outside the page (the API, a script): IMAP without TLS in a dedicated
    // folder, SMTP over implicit TLS on 465. The page shows none of these three fields.
    const stored = harness.daemon.state.email.agent_alice?.settings.mailbox;
    if (!stored?.imap || !stored.smtp) throw new Error("fixture");
    stored.imap = {
      ...stored.imap,
      port: 143,
      secure: false,
      folder: "Agent",
      draftsFolder: "Agent/Drafts",
    };
    stored.smtp = { ...stored.smtp, port: 465, secure: true };
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    const mailbox = await within(alice).findByTestId("email-mailbox");
    // The owner only corrects the SMTP password reference.
    await user.clear(within(mailbox).getByTestId("smtp-ref"));
    await user.type(within(mailbox).getByTestId("smtp-ref"), "secret:alice_agent_smtp2");
    await user.click(within(mailbox).getByTestId("mailbox-save"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(1),
    );
    // `mergeEmailConfig` replaces the mailbox whole, so what the form leaves out is reset to
    // the schema's defaults (IMAP secure in INBOX, SMTP without TLS) unless the form carries
    // the stored values: a save of one field must not switch TLS off on port 465.
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")[0]?.body).toEqual({
      settings: {
        mailbox: {
          address: "alice-agent@agents.example.test",
          imap: {
            host: "imap.example.test",
            port: 143,
            secure: false,
            user: "alice-agent",
            passwordRef: "secret:alice_agent_imap",
            folder: "Agent",
            draftsFolder: "Agent/Drafts",
          },
          smtp: {
            host: "smtp.example.test",
            port: 465,
            secure: true,
            user: "alice-agent",
            passwordRef: "secret:alice_agent_smtp2",
          },
        },
      },
    });
    expect(await within(mailbox).findByTestId("mailbox-saved")).toHaveTextContent("Saved.");
    expect(harness.daemon.state.email.agent_alice?.settings.mailbox).toMatchObject({
      imap: { port: 143, secure: false, folder: "Agent", draftsFolder: "Agent/Drafts" },
      smtp: { port: 465, secure: true, passwordRef: "secret:alice_agent_smtp2" },
    });
  });

  it("lists the command audit newest first with when, from, the interpretation, the result and the ignored reason", async () => {
    renderApp("/settings/capabilities/email");
    const alice = await card();
    const audit = within(alice).getByTestId("email-command-audit");
    const rows = await within(audit).findAllByTestId("email-command-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dataset.obeyed)).toEqual(["true", "true", "false"]);
    const [question, task, spoofed] = rows;
    if (!question || !task || !spoofed) throw new Error("rows");
    expect(within(question).getByTestId("command-from")).toHaveTextContent("alice@example.test");
    expect(within(question).getByTestId("command-interpretation")).toHaveTextContent(
      "question: Where does Atlas stand?",
    );
    expect(within(question).getByTestId("command-result")).toHaveTextContent("obeyed question");
    expect(within(task).getByTestId("command-interpretation")).toHaveTextContent(
      "task: Add a retry to the uploader",
    );
    expect(within(task).getByTestId("command-result")).toHaveTextContent("task task_9");
    expect(within(task).getByRole("link", { name: "session" })).toHaveAttribute(
      "href",
      "/sessions/sess_2",
    );
    expect(within(spoofed).getByTestId("command-interpretation")).toHaveTextContent(
      "not interpreted",
    );
    expect(within(spoofed).getByTestId("command-result")).toHaveTextContent(
      "ignored spoofed sender",
    );
    // The sent copies, newest first, with whom they went to.
    const sent = within(alice).getByTestId("email-sent");
    const sentRows = await within(sent).findAllByTestId("email-sent-row");
    expect(sentRows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Timeline for the uploader"),
      expect.stringContaining("Re: [FR-7k2q] Atlas: add the retry"),
    ]);
    expect(sentRows[0]).toHaveTextContent("to others");
    expect(sentRows[1]).toHaveTextContent("to you");
    // The critic has no mailbox and no card (U-075).
    expect(
      screen.getAllByTestId("email-agent").some((c) => c.dataset.agentId === "agent_critic"),
    ).toBe(false);
  });

  it("names the missing routes on a daemon without them and keeps the rest of the page", async () => {
    renderApp(
      "/settings/capabilities/email",
      createHarness({ missingRoutes: ["/agents/agent_alice/email"] }),
    );
    const alice = await card();
    const missing = await within(alice).findByTestId("route-missing");
    expect(missing).toHaveAttribute("data-route", "emailSettings");
    expect(missing).toHaveTextContent("GET /agents/:agentId/email/settings");
    expect(within(alice).queryByTestId("email-mode-picker")).toBeNull();
    // The rest of the page stays.
    expect(screen.getByTestId("email-intro")).toBeInTheDocument();
    expect(screen.getByTestId("email-principal-only")).toBeInTheDocument();
  });
  it("ADR 0081: a mode change to off says on the card that commands go off with it, the toggle follows the stored value; turning them on at off shows the daemon's plain refusal", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode-current")).toHaveTextContent("Draft only"),
    );
    expect(within(alice).getByTestId("commands-enabled")).toBeChecked();
    await user.click(within(alice).getByRole("radio", { name: /^Off/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    const dialog = await screen.findByTestId("email-mode-dialog");
    const pending = await within(dialog).findByTestId("command-pending");
    await user.click(within(pending).getByTestId("command-yes"));
    const done = await within(dialog).findByTestId("command-done");
    const sentence =
      "Changed the email mode of Alice's agent from Draft only to Off; email commands are turned off with it, because at Off the agent could not answer them. Undo.";
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      sentence.replace(/ Undo\.$/, ""),
    );
    await user.click(within(done).getByTestId("command-close"));
    await waitFor(() => expect(within(alice).getByTestId("email-mode")).toHaveTextContent("Off"));
    expect(within(alice).getByTestId("email-mode-note")).toHaveTextContent(sentence);
    expect(harness.daemon.state.email.agent_alice?.commands.enabled).toBe(false);
    // The box follows the stored toggle instead of still showing commands on.
    expect(within(alice).getByTestId("commands-enabled")).not.toBeChecked();
    // Ticking it again at Off is refused by the daemon, and the page shows why.
    await user.click(within(alice).getByTestId("commands-enabled"));
    await user.click(within(alice).getByTestId("commands-save"));
    await waitFor(() =>
      expect(
        within(alice).getByText(/Email commands need a sending mode other than off/),
      ).toBeInTheDocument(),
    );
    expect(harness.daemon.state.email.agent_alice?.commands.enabled).toBe(false);
  });

  it("a daemon that cannot confirm on this PC (no desktop row) shows its refusal in the dialog and the mode stays", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ me: { desktopDeviceId: null } });
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode-current")).toHaveTextContent("Draft only"),
    );
    await user.click(within(alice).getByRole("radio", { name: /Full discretion/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    const dialog = await screen.findByTestId("email-mode-dialog");
    const pending = await within(dialog).findByTestId("command-pending");
    await user.click(within(pending).getByTestId("command-yes"));
    expect(await within(dialog).findByTestId("error-banner")).toHaveTextContent(
      "deviceId is required",
    );
    expect(confirmBodies(harness)).toEqual([{ answer: "device" }]);
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("draft_only");
    // The card is still open on the daemon: a paired phone can answer it.
    expect(harness.daemon.state.pendingCommands.size).toBe(1);
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(0);
  });
});
