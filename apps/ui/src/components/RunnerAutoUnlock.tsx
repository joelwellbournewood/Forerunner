import { useCallback, useEffect, useMemo, useState } from "react";
import type { HumanRequestView } from "../api/client.ts";
import {
  daemonRunnerKeys,
  desktopUnlockWindowStore,
  type PreparedAnswer,
  type RunnerKeyBridge,
  unlockChallengeOf,
  windowOpen,
} from "../lib/runner-unlock.ts";
import { browserStorage, type KeyValueStore } from "../lib/storage.ts";
import { useClient, useUiState } from "../store/context.tsx";
import { useAutoUnlock, useUnlockWindow } from "./UnlockCard.tsx";

/** While a window is open, the inbox is re-read this often even without a streamed count. */
export const AUTO_UNLOCK_POLL_MS = 60_000;

export interface RunnerAutoUnlockProps {
  /** Where the runner's vault key is; the daemon, which holds the OS keyring, by default. */
  runnerKeys?: RunnerKeyBridge;
  /** Where this device keeps the window it set; browser storage by default. */
  unlockWindows?: KeyValueStore;
  now?: () => number;
}

/**
 * The desktop's auto-unlock (spec S.12, ADR 0068), mounted once in the `Shell` so it works on
 * every page: while the window this computer set is open, it reads the inbox (on mount, on
 * every blocking count the install stream reports, and every minute as a fallback), answers
 * the next runner unlock challenge once through the daemon's key bridge and shows a notice.
 * Without an open window it reads nothing.
 */
export function RunnerAutoUnlock({
  runnerKeys,
  unlockWindows,
  now = Date.now,
}: RunnerAutoUnlockProps = {}) {
  const client = useClient();
  const humanId = useUiState((s) => s.me?.id ?? null);
  const blockingCount = useUiState((s) => s.blockingCount);
  const bridge = useMemo(() => runnerKeys ?? daemonRunnerKeys(client), [runnerKeys, client]);
  const windows = useMemo(
    () => (humanId ? desktopUnlockWindowStore(unlockWindows ?? browserStorage(), humanId) : null),
    [unlockWindows, humanId],
  );
  const windowUntil = useUnlockWindow(windows);
  const open = windowOpen(windowUntil, now());
  const [requests, setRequests] = useState<HumanRequestView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), AUTO_UNLOCK_POLL_MS);
    return () => clearInterval(t);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: blockingCount and tick are triggers
  useEffect(() => {
    if (!humanId || !open) {
      setRequests([]);
      return;
    }
    const controller = new AbortController();
    client
      .inbox(humanId, controller.signal)
      .then((view) =>
        setRequests(view.requests.filter((r) => r.status === "open" && unlockChallengeOf(r))),
      )
      .catch(() => {
        // the next streamed count or the minute's poll tries again
      });
    return () => controller.abort();
  }, [client, humanId, open, blockingCount, tick]);

  const send = useCallback(
    async (request: HumanRequestView, prepared: PreparedAnswer) => {
      await client.answerRequest(request.id, { version: request.version, answer: prepared.value });
    },
    [client],
  );
  useAutoUnlock({ requests, bridge, windowUntil, now, send, notify: setNotice });

  if (!notice) return null;
  return (
    <p
      className="mb-3 rounded border border-blue-300 p-2 text-sm dark:border-blue-800"
      role="status"
      data-testid="unlock-notice"
    >
      {notice}
    </p>
  );
}
