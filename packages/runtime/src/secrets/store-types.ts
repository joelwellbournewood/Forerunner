import { z } from "zod";

/**
 * Secrets the app may store (U-054; `store-routes.ts`), browser-safe (zod only) so the app
 * imports the names and shapes through `api-types.ts`. 1.0.4 stored the mailbox password and
 * the cloud voice keys only with `fr vault set`, which the installed app does not have.
 *
 * The allowlist is closed: the agent mailbox's two passwords (the names the Email page's
 * references default to), the three cloud voice keys (the names `VOICE_SECRET_REFS` reads) and
 * the shared state service's admin token that pairing needs (U-055).
 * The install's own credentials (the Claude and GitHub keys, set through the setup assistant's
 * checks) and every reserved name (`forerunner.*`) are never storable here.
 */
export const STORABLE_SECRETS = {
  agent_imap_password: { label: "Mailbox password for reading (IMAP)", kind: "password" },
  agent_smtp_password: { label: "Mailbox password for sending (SMTP)", kind: "password" },
  deepgram_api_key: { label: "Deepgram API key", kind: "api_key" },
  cartesia_api_key: { label: "Cartesia API key", kind: "api_key" },
  elevenlabs_api_key: { label: "ElevenLabs API key", kind: "api_key" },
  /** The shared state service's admin token, for pairing phones (U-055; Settings -> Devices). */
  state_api_admin: { label: "State service admin token", kind: "password" },
} as const;
export type StorableSecretName = keyof typeof STORABLE_SECRETS;
export const STORABLE_SECRET_NAMES = Object.keys(STORABLE_SECRETS) as StorableSecretName[];

/**
 * A mailbox password of one agent: `<agent>_imap_password` or `<agent>_smtp_password` (the
 * principal's are `agent_imap_password` and `agent_smtp_password`), so two agents' mailboxes
 * never share one. No install credential has such a name.
 */
export const MAILBOX_PASSWORD_PATTERN = /^[a-z][a-z0-9_]{0,40}_(imap|smtp)_password$/;

export function isStorableSecretName(name: unknown): name is StorableSecretName | string {
  return (
    typeof name === "string" &&
    (Object.hasOwn(STORABLE_SECRETS, name) || MAILBOX_PASSWORD_PATTERN.test(name))
  );
}

/** What the person calls it, and whether it is an API key (no spaces) or a password. */
export function storableSecretInfo(name: string): { label: string; kind: "password" | "api_key" } {
  if (Object.hasOwn(STORABLE_SECRETS, name)) return STORABLE_SECRETS[name as StorableSecretName];
  const side = MAILBOX_PASSWORD_PATTERN.exec(name)?.[1];
  return {
    label:
      side === "smtp"
        ? "Mailbox password for sending (SMTP)"
        : "Mailbox password for reading (IMAP)",
    kind: "password",
  };
}

/** The mailbox password name the Email page stores for an agent and a side when none is named. */
export function mailboxPasswordName(
  agent: { name: string; kind: string },
  side: "imap" | "smtp",
): string {
  if (agent.kind === "principal") return `agent_${side}_password`;
  const slug = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `${/^[a-z]/.test(slug) ? slug : "agent"}_${side}_password`;
}

/** `POST /secrets/store`: the value goes to the vault and never comes back. */
export const StoreSecretBody = z.object({
  name: z.string().min(1).max(64),
  value: z.string().min(1).max(4096),
});
export type StoreSecretBody = z.infer<typeof StoreSecretBody>;

/** Which allowlisted secrets the vault holds: names and a flag, never a value. */
export const StoredSecretsView = z.object({
  secrets: z.array(z.object({ name: z.string(), label: z.string(), stored: z.boolean() })),
});
export type StoredSecretsView = z.infer<typeof StoredSecretsView>;

export const StoreSecretView = z.object({
  name: z.string(),
  stored: z.literal(true),
  /** The reference a setting uses for it (`secret:<name>`). */
  ref: z.string(),
});
export type StoreSecretView = z.infer<typeof StoreSecretView>;

export const SECRET_STORE_ROUTES = {
  storedSecrets:
    "GET /secrets/store?name= (StoredSecretsView: the mailbox passwords and cloud voice keys the app may store, plus each storable `name` asked for, each with whether the vault holds it; never a value; U-054)",
  storeSecret:
    "POST /secrets/store { name, value } (StoreSecretView: stores one allowlisted secret in the vault by name; the value is never logged or returned; 400 validation for a name off the allowlist, a reserved name or the install's own credentials, an empty value, a line break inside, or a space inside an API key)",
} as const;
