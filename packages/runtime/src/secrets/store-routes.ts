import type { Clock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import { isReservedSecretName, type Vault } from "@forerunner/vault";
import { Hono } from "hono";
import {
  isStorableSecretName,
  STORABLE_SECRET_NAMES,
  STORABLE_SECRETS,
  type StoredSecretsView,
  StoreSecretBody,
  type StoreSecretView,
  storableSecretInfo,
} from "./store-types.ts";

/**
 * The app stores the secrets a person types (U-054): the agent mailbox's passwords on the Email
 * page and the cloud voice keys on their Extensions rows. Mounted behind the daemon's bearer
 * check.
 *   GET  /secrets/store               -> StoredSecretsView (names and whether each is stored)
 *   POST /secrets/store { name, value } -> StoreSecretView
 * Only the closed allowlist (`STORABLE_SECRETS`) is accepted; a reserved name and the install's
 * own credentials (the Claude and GitHub keys go through the setup assistant's checks) are
 * refused. The value goes to the vault and nowhere else: no answer, log line or audit row
 * carries it, and a refusal never quotes it.
 */
export interface SecretStoreRoutesDeps {
  vault: Vault;
  clock: Clock;
  store: Pick<StateStore, "auditLog">;
  humanId: string;
}

function refusal(message: string) {
  return { code: "validation", message, details: {} };
}

/** A line break or another control character: the value was pasted in pieces. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function createSecretStoreRoutes(deps: SecretStoreRoutesDeps): Hono {
  const app = new Hono();

  app.get("/secrets/store", async (c) => {
    const asked = (c.req.queries("name") ?? []).filter(
      (n) => isStorableSecretName(n) && !isReservedSecretName(n),
    );
    const secrets: StoredSecretsView["secrets"] = [];
    for (const name of [...new Set<string>([...STORABLE_SECRET_NAMES, ...asked])]) {
      secrets.push({
        name,
        label: storableSecretInfo(name).label,
        stored: await deps.vault.has(name).catch(() => false),
      });
    }
    return c.json({ secrets } satisfies StoredSecretsView);
  });

  app.post("/secrets/store", async (c) => {
    const parsed = StoreSecretBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      // Zod's issues may quote the input; only the field paths are named.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "body"))];
      return c.json(refusal(`Missing or too long: ${fields.join(", ")}.`), 400);
    }
    const { name } = parsed.data;
    const value = parsed.data.value.trim();
    if (isReservedSecretName(name) || !isStorableSecretName(name)) {
      return c.json(
        refusal(
          `"${name.slice(0, 64)}" is not a secret the app stores. It stores the mailbox passwords (<agent>_imap_password, <agent>_smtp_password) and ${STORABLE_SECRET_NAMES.filter((n) => STORABLE_SECRETS[n].kind === "api_key").join(", ")}; the Claude and GitHub keys go through the setup assistant.`,
        ),
        400,
      );
    }
    const what = storableSecretInfo(name);
    if (!value) return c.json(refusal(`The ${what.label.toLowerCase()} is empty.`), 400);
    if (hasControlCharacter(value)) {
      return c.json(
        refusal(
          `The ${what.label.toLowerCase()} has a line break inside, so it was not saved. Copy it again in one piece and paste it.`,
        ),
        400,
      );
    }
    if (what.kind === "api_key" && /\s/.test(value)) {
      return c.json(
        refusal(
          `The ${what.label} has a space inside, so it was not saved. Copy it again in one piece and paste it.`,
        ),
        400,
      );
    }
    await deps.vault.set(name, value);
    await deps.store.auditLog
      .append({
        tool: "secrets.store",
        allowed: true,
        human_id: deps.humanId,
        input_summary: `name: ${name}`,
        result_summary: "stored",
        occurred_at: deps.clock.nowIso(),
      })
      .catch(() => undefined);
    return c.json({ name, stored: true, ref: `secret:${name}` } satisfies StoreSecretView);
  });

  return app;
}
