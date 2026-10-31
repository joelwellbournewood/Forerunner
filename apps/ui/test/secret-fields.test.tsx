import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * U-054: the agent mailbox's password and the cloud voice keys could only be stored with
 * `fr vault set`, which the installed app does not have. The Email page has a password box per
 * side and each cloud voice row in Extensions a key box: the value goes once to the daemon's
 * vault (`POST /secrets/store`), the box is emptied, the reference is filled in, and the value
 * is never shown again.
 */
// Fixture values built by concatenation so no scanner sees a credential. // not-a-secret
const PASSWORD = ["mail", "box", "pass", "7".repeat(10)].join("-"); // not-a-secret
const DEEPGRAM = ["dg", "fedcba9876543210".repeat(2)].join(""); // not-a-secret

const emailCard = async (agentId: string) => {
  const cards = await screen.findAllByTestId("email-agent");
  const found = cards.find((c) => c.dataset.agentId === agentId);
  if (!found) throw new Error(`no email card for ${agentId}`);
  return found;
};

describe("secrets typed in the app (U-054)", () => {
  it("Email: the IMAP password is stored by name, the reference filled in, and the mailbox saved with it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await emailCard("agent_alice");
    const mailbox = await within(alice).findByTestId("email-mailbox");
    const box = within(mailbox).getByTestId("imap-password");
    expect(await within(box).findByTestId("imap-password-state")).toHaveTextContent(
      "Nothing saved yet. It is kept in this computer's credential store as agent_imap_password",
    );
    await user.type(within(box).getByTestId("imap-password-input"), PASSWORD);
    await user.click(within(box).getByTestId("imap-password-save"));
    expect(
      await within(box).findByText(/Saved in this computer's credential store/),
    ).toHaveTextContent("Saved in this computer's credential store as agent_imap_password.");
    expect(postedCalls(harness, "/secrets/store").map((c) => c.body)).toEqual([
      { name: "agent_imap_password", value: PASSWORD },
    ]);
    expect(harness.daemon.state.storedSecrets.get("agent_imap_password")).toBe(PASSWORD);
    expect(within(box).getByTestId("imap-password-input")).toHaveValue("");
    expect(within(mailbox).getByTestId("imap-ref")).toHaveValue("secret:agent_imap_password");
    expect(document.body.textContent).not.toContain(PASSWORD);

    // The mailbox then names it by reference, never by value.
    await user.clear(within(mailbox).getByTestId("mailbox-address"));
    await user.type(within(mailbox).getByTestId("mailbox-address"), "alice@agents.example.test");
    await user.clear(within(mailbox).getByTestId("imap-host"));
    await user.type(within(mailbox).getByTestId("imap-host"), "imap.example.test");
    await user.click(within(mailbox).getByTestId("mailbox-save"));
    await waitFor(() =>
      expect(postedCalls(harness, "/agents/agent_alice/email/settings")).toHaveLength(1),
    );
    const saved = JSON.stringify(postedCalls(harness, "/agents/agent_alice/email/settings")[0]);
    expect(saved).toContain('"passwordRef":"secret:agent_imap_password"');
    expect(saved).not.toContain(PASSWORD);
  });

  it("Email: the SMTP password has its own name; only your agent has a mailbox (U-075)", async () => {
    // U-054 was written while the page still showed a card for the critic; U-075 (in parallel)
    // shows the principal agent only, the one whose mailbox the daemon uses.
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings/capabilities/email", harness);
    const alice = await emailCard("agent_alice");
    await expect(emailCard("agent_critic")).rejects.toThrow("no email card for agent_critic");
    const box = within(await within(alice).findByTestId("email-mailbox")).getByTestId(
      "smtp-password",
    );
    await user.type(within(box).getByTestId("smtp-password-input"), PASSWORD);
    await user.click(within(box).getByTestId("smtp-password-save"));
    await waitFor(() =>
      expect(postedCalls(harness, "/secrets/store").map((c) => c.body)).toEqual([
        { name: "agent_smtp_password", value: PASSWORD },
      ]),
    );
  });

  it("Extensions: a cloud voice row takes its key, stores it by name and never shows it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const rows = await screen.findAllByTestId("extension");
    const deepgram = rows.find((r) => r.dataset.extensionId === "ext_voice_deepgram");
    if (!deepgram) throw new Error("no voice-deepgram row");
    const box = within(deepgram).getByTestId("extension-voice-key");
    expect(within(box).getByTestId("extension-voice-key-input")).toHaveAccessibleName(
      "deepgram API key",
    );
    await user.type(within(box).getByTestId("extension-voice-key-input"), DEEPGRAM);
    await user.click(within(box).getByTestId("extension-voice-key-save"));
    expect(await within(box).findByTestId("extension-voice-key-state")).toHaveTextContent(
      "Saved in this computer's credential store as deepgram_api_key.",
    );
    expect(postedCalls(harness, "/secrets/store").map((c) => c.body)).toEqual([
      { name: "deepgram_api_key", value: DEEPGRAM },
    ]);
    expect(document.body.textContent).not.toContain(DEEPGRAM);
    // Nothing on the page sends the person to `fr setup` for the key (the voice card itself
    // moved to Settings -> Voice with U-023).
    expect(document.body.textContent).not.toContain("fr setup");
    // A row without a cloud key has no key box.
    const others = rows.filter((r) => r.dataset.extensionId !== "ext_voice_deepgram");
    for (const r of others) expect(within(r).queryByTestId("extension-voice-key")).toBeNull();
  });
});
