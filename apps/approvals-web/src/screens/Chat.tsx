import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, describeError } from "../api/client.ts";
import { changedId, type RemoteCommandView } from "../api/types.ts";
import { Banner, Button } from "../components/ui.tsx";
import { useApp } from "../store/AppContext.tsx";

/**
 * Quick chat (spec J.1, O.1) relayed to the PC as a `chat` remote command (spec R.4, ADR
 * 0026): the desktop runtime's conversation agent answers read-only and completes the
 * command with its reply. Nothing runs here. The screen is disabled, with the reason, when
 * the link has no `write:remote` scope or when no PC is online to pick commands up.
 *
 * The reply arrives through `remote_command.changed`, and the feed does not poll in live
 * mode, so a reply must never depend on the event beating this screen: the command id is
 * tracked in a ref the moment the service answers the POST (not on the next render), and the
 * command is fetched once right after its entry is added, which covers an event that went by
 * while the POST response was in flight. A view only replaces the entry's state when its
 * version is newer, so a slow fetch cannot roll a `done` back to `picked up`.
 */
export interface ChatEntry {
  id: string;
  role: "you" | "agent" | "system";
  text: string;
  status?: RemoteCommandView["status"];
  commandId?: string;
  /** Version of the command view the entry shows; older views are ignored. */
  version?: number;
  sentAt?: number;
}

export const PICKUP_WARN_MS = 30_000;

export function replyText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { reply?: unknown; text?: unknown; message?: unknown; error?: unknown };
    const line = [r.reply, r.text, r.message, r.error].find((v) => typeof v === "string");
    if (typeof line === "string") return line;
  }
  return result === null || result === undefined ? "" : JSON.stringify(result);
}

export function Chat() {
  const app = useApp();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  /** Ids of the commands this screen sent, known the moment the POST answered. */
  const commandIds = useRef(new Set<string>());

  const canRemote = app.client.hasScope("write:remote");
  const pcOnline = app.presence?.pcOnline ?? false;
  const project = app.projects.find((p) => p.id === app.activeProjectId) ?? null;
  const disabledReason = !canRemote
    ? "This link was issued without remote control, so chat cannot reach your PC."
    : app.presence === null
      ? "Checking whether your PC is online…"
      : !pcOnline
        ? app.presence.reason
        : !project
          ? "No active project. Pick one in the header."
          : null;

  const applyCommand = useCallback((c: RemoteCommandView) => {
    setEntries((list) =>
      list.map((e) => {
        if (e.commandId !== c.id || (e.version ?? 0) > c.version) return e;
        const next = { ...e, status: c.status, version: c.version };
        if (c.status === "done") return { ...next, text: replyText(c.result) || "(empty reply)" };
        if (c.status === "failed")
          return { ...next, text: replyText(c.result) || "The PC could not answer." };
        if (c.status === "picked_up") return { ...next, text: "Your PC is answering…" };
        return next;
      }),
    );
  }, []);

  const refreshPending = useCallback(async () => {
    const pending = entriesRef.current.filter(
      (e) => e.commandId && (e.status === "pending" || e.status === "picked_up"),
    );
    for (const e of pending) {
      if (!e.commandId) continue;
      try {
        applyCommand(await app.client.remoteCommand(e.commandId));
      } catch {
        // the next tick retries
      }
    }
    const now = app.clock.now();
    setEntries((list) =>
      list.map((e) =>
        e.status === "pending" && e.sentAt !== undefined && now - e.sentAt > PICKUP_WARN_MS
          ? { ...e, text: "Not picked up yet. The PC may be offline." }
          : e,
      ),
    );
  }, [app.client, app.clock, applyCommand]);

  useEffect(() => {
    const offChange = app.onChange((e) => {
      if (e.type !== "remote_command.changed") return;
      const id = changedId(e);
      if (id && commandIds.current.has(id)) {
        void app.client
          .remoteCommand(id)
          .then(applyCommand)
          .catch(() => undefined);
      }
    });
    const offPoll = app.onPoll(() => void refreshPending());
    return () => {
      offChange();
      offPoll();
    };
  }, [app, applyCommand, refreshPending]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || disabledReason || !project) return;
    setSending(true);
    setError(null);
    try {
      const command = await app.client.sendRemoteCommand({
        target: "pc",
        command: "chat",
        params: { projectId: project.id, text: value },
      });
      commandIds.current.add(command.id);
      const sentAt = app.clock.now();
      setEntries((list) => [
        ...list,
        { id: `${command.id}:you`, role: "you", text: value },
        {
          id: `${command.id}:agent`,
          role: "agent",
          text: "Waiting for your PC…",
          status: command.status,
          commandId: command.id,
          version: command.version,
          sentAt,
        },
      ]);
      setText("");
      // The PC may have picked the command up, or answered, while the POST response was in
      // flight; the entry is queued above, so this fetch lands on it whatever the feed did.
      void app.client
        .remoteCommand(command.id)
        .then(applyCommand)
        .catch(() => undefined);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "validation"
          ? "This state service does not relay chat yet. Update it to a version with the chat command."
          : describeError(err),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="chat">
      <h2 className="text-lg font-semibold">
        Quick chat{project ? ` · ${project.name}` : ""}{" "}
        <span className="text-sm font-normal text-neutral-500">read-only, answered by your PC</span>
      </h2>
      {disabledReason && (
        <Banner tone="warn" testId="chat-disabled">
          {disabledReason}
        </Banner>
      )}
      <ol className="space-y-2" data-testid="transcript">
        {entries.map((e) => (
          <li
            key={e.id}
            data-testid={`chat-${e.role}`}
            data-status={e.status ?? ""}
            className={`rounded px-3 py-2 text-sm ${
              e.role === "you"
                ? "ml-8 bg-blue-50 dark:bg-blue-950"
                : "mr-8 bg-neutral-100 dark:bg-neutral-800"
            }`}
          >
            <span className="mr-2 text-xs text-neutral-500">
              {e.role === "you" ? "You" : "Agent"}
            </span>
            <span className="whitespace-pre-wrap">{e.text}</span>
          </li>
        ))}
      </ol>
      {error && (
        <Banner tone="error" testId="chat-error">
          {error}
        </Banner>
      )}
      <form onSubmit={send} className="flex gap-2" data-testid="chat-form">
        <input
          aria-label="Message"
          data-testid="chat-input"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!!disabledReason || sending}
          placeholder={disabledReason ? "Chat is unavailable" : "Ask your agent"}
        />
        <Button
          type="submit"
          variant="primary"
          data-testid="chat-send"
          disabled={!!disabledReason || sending || !text.trim()}
        >
          Send
        </Button>
      </form>
    </div>
  );
}
