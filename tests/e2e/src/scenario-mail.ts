/**
 * The agent mailbox of an install on the scenario world's mail server (spec "Agent email" and
 * "Email commands"): the per-agent email settings row (mode, mailbox, commands with the
 * registered human address and the private marker), the `TestMailbox` over the world's
 * `LocalMailServer` (what the cloud runner's `mailboxFactory` hands in instead of IMAP/SMTP)
 * and the `AuthResultsHeaderVerifier` that believes only the world's mail host. The
 * verification chain (owner's address, DKIM, SPF, marker or thread) is the production
 * `EmailCommandGate`; nothing here loosens it.
 */
import {
  type AgentEmailConfig,
  AuthResultsHeaderVerifier,
  type AuthVerifier,
  type EmailMode,
  EmailSettingsStore,
  type Mailbox,
  type MailboxConfig,
  TestMailbox,
} from "@forerunner/capabilities/email/index";
import type { ScriptedReply } from "@forerunner/testenv";
import { textReply } from "@forerunner/testenv";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

export interface AgentMailboxOptions {
  /** Sending mode of the agent (default "read_only": replies to the owner still go out). */
  mode?: EmailMode;
  /** Email commands on (default true) for the install's human. */
  commands?: boolean;
  /** Private subject marker (default "[FR-scen2]"). */
  marker?: string;
  /** False simulates a host without IDLE: only the poll loop delivers. */
  push?: boolean;
}

export interface AgentMailbox {
  /** The agent's own address on the world's mail domain. */
  address: string;
  marker: string;
  settings: EmailSettingsStore;
  config: AgentEmailConfig;
  verifier: AuthVerifier;
  /** The mailbox the cloud runner's watch and the email tools read and send through. */
  mailbox: TestMailbox;
  mailboxFactory: (config: MailboxConfig) => Promise<Mailbox>;
}

/** Configure the install's agent mailbox on the world's mail server. */
export async function agentMailbox(
  world: ScenarioWorld,
  install: Install,
  opts: AgentMailboxOptions = {},
): Promise<AgentMailbox> {
  if (!world.mail) throw new Error("the scenario world was built with mail: false");
  const local = install.agent.name.toLowerCase();
  const box = world.mailboxes.get(local);
  if (!box) throw new Error(`no mailbox for ${install.agent.name} on the world's mail server`);
  const address = box.address;
  const marker = opts.marker ?? "[FR-scen2]";
  const settings = new EmailSettingsStore(world.store.extension, world.clock);
  const config = await settings.update(install.agent.id, {
    settings: {
      mode: opts.mode ?? "read_only",
      mailbox: { address, imap: null, smtp: null },
    },
    commands: {
      enabled: opts.commands ?? true,
      registeredHumanAddress: install.human.email,
      marker,
    },
  });
  const mailbox = new TestMailbox({
    server: world.mail,
    address,
    clock: world.clock,
    push: opts.push ?? true,
  });
  return {
    address,
    marker,
    settings,
    config,
    verifier: new AuthResultsHeaderVerifier({ trustedAuthservIds: [world.mail.authservId] }),
    mailbox,
    mailboxFactory: async () => mailbox,
  };
}

/**
 * The email command classifier's reply for one owner email: the fake provider answers the
 * strict JSON `EmailCommandHandler` parses when the classifier prompt carries `phrase` (a
 * substring of the owner's own words).
 */
export function classifierSays(
  phrase: string,
  interpretation: {
    kind: "question" | "task" | "note";
    project: string | null;
    title: string;
    summary: string;
    answer?: string | null;
  },
): ScriptedReply {
  return textReply(JSON.stringify({ answer: null, ...interpretation }), {
    when: (req) =>
      req.metadata?.purpose === "email_command_classify" &&
      JSON.stringify(req.messages).includes(phrase),
  });
}
