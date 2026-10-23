import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import {
  decodeStoredKey,
  MAX_AUTO_UNLOCK_WINDOW_MS,
  parseUnlockChallenge,
  RunnerUnlockError,
  runnerKeySecretName,
  type Vault,
  wrapVaultKey,
} from "@forerunner/vault";
import { Hono } from "hono";
import {
  type RunnerKeyStatusView,
  type RunnerUnlockAnswerView,
  RunnerUnlockWrapBody,
} from "../daemon/api-types.ts";

/**
 * The desktop side of the cloud runner's vault unlock (spec S.12, ADR 0033, ADR 0068):
 *   GET  /runner-unlock/:runnerId/key            -> RunnerKeyStatusView (never the key)
 *   POST /runner-unlock/wrap { card, autoUnlockUntil? } -> RunnerUnlockAnswerView
 * On the desktop the daemon is the process that holds the OS keyring (the install's vault), so
 * the inbox's unlock card asks it to wrap the runner's vault key to the challenge; the key is
 * read, wrapped and zeroed inside this handler and no body carries it. The inbox then sends the
 * wrapped answer to the request like any other answer. Mounted behind the daemon's bearer check.
 */
export const RUNNER_UNLOCK_WRAP_AUDIT_TOOL = "runner.unlock_answer_wrapped";

export interface RunnerUnlockRoutesDeps {
  vault: Pick<Vault, "backend" | "get">;
  clock: Clock;
  auditLog: Pick<StateStore["auditLog"], "append">;
  humanId: () => string;
}

const logger = log("runtime:runner-unlock");

function problem(code: string, message: string, details: Record<string, unknown> = {}) {
  return { code, message, details };
}

const missingReason = (runnerId: string, name: string) =>
  `This computer's vault has no key for runner "${runnerId}" (vault entry ${name}). Store the runner's vault key there, or answer from a device that holds it.`;

export function createRunnerUnlockRoutes(deps: RunnerUnlockRoutesDeps): Hono {
  const app = new Hono();

  app.get("/runner-unlock/:runnerId/key", async (c) => {
    const runnerId = c.req.param("runnerId");
    const name = runnerKeySecretName(runnerId);
    let available = false;
    let reason: string | null = null;
    try {
      const key = decodeStoredKey(await deps.vault.get(name));
      available = key !== null;
      key?.fill(0);
      if (!available) reason = missingReason(runnerId, name);
    } catch (e) {
      reason = `This computer's vault could not be read: ${errorMessage(e).slice(0, 120)}`;
    }
    const view: RunnerKeyStatusView = {
      runnerId,
      available,
      backend: deps.vault.backend,
      reason,
    };
    return c.json(view);
  });

  app.post("/runner-unlock/wrap", async (c) => {
    const parsed = RunnerUnlockWrapBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(problem("validation", "invalid request body"), 400);
    }
    const card = parseUnlockChallenge(parsed.data.card);
    if (!card) return c.json(problem("validation", "not a runner unlock challenge"), 400);
    const now = deps.clock.now();
    const until = parsed.data.autoUnlockUntil;
    if (typeof until === "string") {
      const ms = Date.parse(until);
      if (!Number.isFinite(ms) || ms <= now || ms - now > MAX_AUTO_UNLOCK_WINDOW_MS) {
        return c.json(
          problem("validation", "the auto-unlock window must end in the future, within a week"),
          400,
        );
      }
    }
    const name = runnerKeySecretName(card.runnerId);
    const key = decodeStoredKey(await deps.vault.get(name));
    if (!key) {
      return c.json(problem("not_found", missingReason(card.runnerId, name), { name }), 404);
    }
    let answer: RunnerUnlockAnswerView;
    try {
      answer = await wrapVaultKey(card, key, {
        now,
        ...(until !== undefined ? { autoUnlockUntil: until } : {}),
      });
    } catch (e) {
      if (e instanceof RunnerUnlockError) {
        return c.json(problem("validation", e.message, { reason: e.code }), 400);
      }
      throw e;
    } finally {
      key.fill(0);
    }
    try {
      await deps.auditLog.append({
        tool: RUNNER_UNLOCK_WRAP_AUDIT_TOOL,
        human_id: deps.humanId(),
        agent_id: null,
        input_summary: JSON.stringify({ runnerId: card.runnerId, challengeId: card.challengeId }),
        result_summary: JSON.stringify({
          backend: deps.vault.backend,
          autoUnlockUntil: until === undefined ? "unchanged" : until,
        }),
        allowed: true,
        denied_reason: null,
        cost_usd_micro: 0,
        occurred_at: deps.clock.nowIso(),
      });
    } catch (e) {
      logger.warn("could not write the unlock audit row", { error: errorMessage(e) });
    }
    logger.info("runner unlock answer wrapped", {
      runnerId: card.runnerId,
      challengeId: card.challengeId,
    });
    return c.json(answer);
  });

  return app;
}
