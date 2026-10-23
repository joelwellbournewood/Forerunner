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
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings -> Capabilities -> Email (spec S.15, S.28, S.29, T.14; ADR 0066): one card per agent
 * of the signed-in human with the mode picker and the five meanings, the plain full-discretion
 * sentence before the change and again in the confirmation, pause and resume through the
 * tray's routes, the limits and the allowlist where the mode needs it, the mailbox by
 * reference, the marker rotation, the command audit newest first and the route-unavailable
 * state against a daemon without the routes.
 */
const card = async (agentId = "agent_alice") => {
  const cards = await screen.findAllByTestId("email-agent");
  const found = cards.find((c) => c.dataset.agentId === agentId);
  if (!found) throw new Error(`no email card for ${agentId}`);
  return found;
};

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
    // Alice's two agents (principal first); Bob's agent is not hers to see.
    expect(cards.map((c) => c.dataset.agentId)).toEqual(["agent_alice", "agent_critic"]);
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
    // The critic has no mailbox yet and says so.
    const critic = await card("agent_critic");
    await waitFor(() =>
      expect(within(critic).getByTestId("email-address")).toHaveTextContent(
        "no mailbox configured",
      ),
    );
    expect(within(critic).getByTestId("email-mode")).toHaveTextContent("Off");
  });

  it("switching to full discretion repeats the sentence in a confirmation; cancel sends nothing, yes PUTs the mode", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await card();
    await waitFor(() =>
      expect(within(alice).getByTestId("email-mode-current")).toHaveTextContent("Draft only"),
    );
    await user.click(within(alice).getByRole("radio", { name: /Full discretion/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    const dialog = await screen.findByTestId("full-discretion-dialog");
    expect(within(dialog).getByTestId("full-discretion-confirm-text")).toHaveTextContent(
      FULL_DISCRETION_WARNING,
    );
    await user.click(within(dialog).getByTestId("mode-cancel"));
    await waitFor(() => expect(screen.queryByTestId("full-discretion-dialog")).toBeNull());
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(0);
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("draft_only");
    expect(within(alice).getByRole("radio", { name: /Draft only/ })).toBeChecked();

    await user.click(within(alice).getByRole("radio", { name: /Full discretion/ }));
    await user.click(within(alice).getByTestId("email-mode-apply"));
    const again = await screen.findByTestId("full-discretion-dialog");
    await user.click(within(again).getByTestId("full-discretion-confirm"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(1),
    );
    const put = postedCalls(harness, "/agents/agent_alice/email/settings")[0];
    expect(put?.method).toBe("PUT");
    expect(put?.body).toEqual({ settings: { mode: "full_discretion" } });
    await waitFor(() => expect(screen.queryByTestId("full-discretion-dialog")).toBeNull());
    expect(within(alice).getByTestId("email-mode")).toHaveTextContent("Full discretion");
    expect(within(alice).getByTestId("email-mode-note")).toHaveTextContent(
      "Mode set to Full discretion.",
    );
    expect(harness.daemon.state.email.agent_alice?.settings.mode).toBe("full_discretion");
  });

  it("any other mode applies without a confirmation; allowlist shows the editor and saves the entries", async () => {
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
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(1),
    );
    expect(screen.queryByTestId("full-discretion-dialog")).toBeNull();
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")[0]?.body).toEqual({
      settings: { mode: "allowlist" },
    });
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
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(2),
    );
    expect(postedCalls(harness, "/agents/agent_alice/email/settings")[1]?.body).toEqual({
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

  it("saves the mailbox with credentials as references and rotates the marker", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const critic = await card("agent_critic");
    const mailbox = await within(critic).findByTestId("email-mailbox");
    await user.type(within(mailbox).getByTestId("mailbox-address"), "critic@agents.example.test");
    await user.type(within(mailbox).getByTestId("imap-host"), "imap.example.test");
    await user.type(within(mailbox).getByTestId("imap-user"), "critic");
    await user.type(within(mailbox).getByTestId("imap-ref"), "secret:critic_imap");
    await user.click(within(mailbox).getByTestId("mailbox-save"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_critic/email/settings")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/agents/agent_critic/email/settings")[0]?.body).toEqual({
      settings: {
        mailbox: {
          address: "critic@agents.example.test",
          imap: {
            host: "imap.example.test",
            port: 993,
            user: "critic",
            passwordRef: "secret:critic_imap",
          },
          smtp: null,
        },
      },
    });
    expect(await within(mailbox).findByTestId("mailbox-saved")).toHaveTextContent("Saved.");
    await waitFor(() =>
      expect(within(critic).getByTestId("email-address")).toHaveTextContent(
        "critic@agents.example.test",
      ),
    );
    // A value in place of a reference is the daemon's 400, shown as such and nothing saved.
    const alice = await card();
    const aliceMailbox = within(alice).getByTestId("email-mailbox");
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
    // The critic has no commands and nothing sent.
    const critic = await card("agent_critic");
    expect(await within(critic).findByTestId("email-command-empty")).toBeInTheDocument();
    expect(await within(critic).findByTestId("email-sent-empty")).toBeInTheDocument();
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
    // The other agent's routes are served and its card is complete.
    const critic = await card("agent_critic");
    expect(await within(critic).findByTestId("email-mode-picker")).toBeInTheDocument();
  });
});
