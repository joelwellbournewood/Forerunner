import { type ReactNode, useEffect, useState } from "react";
import { NavLink } from "react-router";
import { type ApiError, describeError } from "../api/client.ts";
import { changedId, type RemoteCommandView, type RemoteTarget } from "../api/types.ts";
import { Badge, Banner, Button, Dialog } from "../components/ui.tsx";
import type { Presence } from "../lib/presence.ts";
import { useApp } from "../store/AppContext.tsx";

/**
 * Header with the active project (spec K.8: always shown), the two screens, the feed
 * status, sign out and the kill switch (spec S.8): a confirm dialog, then a `kill` remote
 * command to every runner that is there to pick it up: the PC when it is online, the cloud
 * runner when it has sessions (ADR 0034 item 6). The targets are sent independently: a
 * command the service accepted stays on the screen with its status even when the other
 * target was refused, so the human always sees whether the PC stopped.
 *
 * Pick-up and outcome arrive through `remote_command.changed`. The subscription can only
 * start once the commands are on the screen, after every POST answered, and the feed does
 * not poll in live mode; so right after subscribing the banner fetches each command once,
 * which covers any event that went by in between. A fetched view replaces the shown one only
 * when its version is newer, so two fetches overtaking each other cannot roll a `done` back.
 */
interface KillFailure {
  target: RemoteTarget;
  message: string;
}

type KillState =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "sending" }
  | { kind: "sent"; commands: RemoteCommandView[]; failures: KillFailure[] }
  | { kind: "error"; message: string };

const MODE_LABEL = {
  connecting: "connecting",
  live: "live",
  polling: "polling every few seconds",
  closed: "disconnected",
} as const;

const TARGET_NAME: Record<RemoteTarget, string> = { pc: "your PC", cloud: "the cloud runner" };

/** The runners a kill goes to: only those present, so nothing waits for an offline PC. */
export function killTargets(presence: Pick<Presence, "pcOnline" | "cloudActive"> | null) {
  const targets: RemoteTarget[] = [];
  if (presence?.pcOnline) targets.push("pc");
  if (presence?.cloudActive) targets.push("cloud");
  return targets;
}

export function describeTargets(targets: readonly RemoteTarget[]): string {
  return targets.map((t) => TARGET_NAME[t]).join(" and ");
}

/** Shown commands updated from fetched views; an older version never replaces a newer one. */
export function mergeCommands(
  shown: readonly RemoteCommandView[],
  fetched: readonly RemoteCommandView[],
): RemoteCommandView[] {
  return shown.map((c) => {
    const next = fetched.find((f) => f.id === c.id);
    return next && next.version >= c.version ? next : c;
  });
}

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { client, onChange, onPoll } = app;
  const [kill, setKill] = useState<KillState>({ kind: "idle" });
  const canRemote = client.hasScope("write:remote");
  const targets = killTargets(app.presence);
  // The effect keys on the command ids, not on the state object: every refresh produces a
  // new state object, and keying on it would resubscribe and refetch without end.
  const sentIds = kill.kind === "sent" ? kill.commands.map((c) => c.id).join("\n") : "";

  useEffect(() => {
    if (sentIds === "") return;
    const ids = sentIds.split("\n");
    let cancelled = false;
    const refresh = async () => {
      const fetched = await Promise.all(
        ids.map((id) => client.remoteCommand(id).catch(() => null)),
      );
      if (cancelled) return;
      const views = fetched.filter((c): c is RemoteCommandView => c !== null);
      setKill((current) =>
        current.kind === "sent"
          ? { ...current, commands: mergeCommands(current.commands, views) }
          : current,
      );
    };
    const offChange = onChange((e) => {
      if (e.type === "remote_command.changed" && ids.includes(changedId(e) ?? "")) void refresh();
    });
    const offPoll = onPoll(() => void refresh());
    // Whatever changed between the POST responses and this subscription is caught up now.
    void refresh();
    return () => {
      cancelled = true;
      offChange();
      offPoll();
    };
  }, [sentIds, client, onChange, onPoll]);

  async function sendKill() {
    setKill({ kind: "sending" });
    // Presence is derived and may be stale; with nothing present the PC is tried anyway.
    const sendTo: RemoteTarget[] = targets.length > 0 ? targets : ["pc"];
    // Every target gets its own request; one refusal must not hide a command already sent.
    const results = await Promise.allSettled(
      sendTo.map((target) =>
        client.sendRemoteCommand({ target, command: "kill", params: { scope: "all" } }),
      ),
    );
    const commands: RemoteCommandView[] = [];
    const failures: KillFailure[] = [];
    results.forEach((result, i) => {
      const target = sendTo[i] ?? "pc";
      if (result.status === "fulfilled") commands.push(result.value);
      else failures.push({ target, message: describeError(result.reason as ApiError) });
    });
    if (commands.length === 0) {
      setKill({
        kind: "error",
        message:
          failures.length === 1
            ? (failures[0]?.message ?? "Something went wrong.")
            : failures.map((f) => `${f.target}: ${f.message}`).join(" "),
      });
      return;
    }
    setKill({ kind: "sent", commands, failures });
  }

  const killTitle = !canRemote
    ? "This link was issued without remote control, so it cannot stop your PC."
    : targets.length === 0
      ? "No PC or cloud runner is online to receive the kill command."
      : `Stop every session on ${describeTargets(targets)}`;

  return (
    <div className="min-h-full">
      <header className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-4 py-2">
          <span className="font-semibold">Forerunner</span>
          <label className="flex items-center gap-1 text-sm">
            <span className="text-neutral-500">Project</span>
            <select
              aria-label="Active project"
              data-testid="active-project"
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
              value={app.activeProjectId ?? ""}
              onChange={(e) => app.setActiveProject(e.target.value)}
              disabled={app.projects.length === 0}
            >
              {app.projects.length === 0 && <option value="">No projects</option>}
              {app.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <nav className="flex items-center gap-2 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) => (isActive ? "font-semibold underline" : "underline")}
            >
              Inbox
              {app.blockingCount > 0 && (
                <>
                  {" "}
                  <Badge tone="error" testId="blocking-badge">
                    {app.blockingCount} blocking
                  </Badge>
                </>
              )}
            </NavLink>
            <NavLink
              to="/chat"
              className={({ isActive }) => (isActive ? "font-semibold underline" : "underline")}
            >
              Chat
            </NavLink>
          </nav>
          <span className="ml-auto flex items-center gap-2">
            <Badge tone={app.feedMode === "live" ? "good" : "neutral"} testId="feed-mode">
              {MODE_LABEL[app.feedMode]}
            </Badge>
            <Button
              variant="danger"
              data-testid="kill-switch"
              title={killTitle}
              disabled={!canRemote || targets.length === 0 || kill.kind === "sending"}
              onClick={() => setKill({ kind: "confirm" })}
            >
              Kill switch
            </Button>
            <Button data-testid="sign-out" onClick={app.signOut}>
              Sign out
            </Button>
          </span>
        </div>
        {app.notice && (
          <div className="mx-auto max-w-3xl px-4 pb-2">
            <Banner tone="warn" testId="notice">
              {app.notice}
            </Banner>
          </div>
        )}
        {kill.kind === "sent" && (
          <div className="mx-auto max-w-3xl px-4 pb-2">
            <Banner tone={kill.failures.length > 0 ? "error" : "warn"} testId="kill-status">
              Kill sent:{" "}
              {kill.commands
                .map((c) => `${c.target} ${c.status === "picked_up" ? "picked up" : c.status}`)
                .join(", ")}
              .
              {kill.failures.map((f) => (
                <span key={f.target} data-testid="kill-failure">
                  {" "}
                  Not sent to {f.target}: {f.message}
                </span>
              ))}
            </Banner>
          </div>
        )}
        {kill.kind === "error" && (
          <div className="mx-auto max-w-3xl px-4 pb-2">
            <Banner tone="error" testId="kill-error">
              {kill.message}
            </Banner>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-3xl p-4">{children}</main>
      <Dialog
        open={kill.kind === "confirm"}
        onClose={() => setKill({ kind: "idle" })}
        title="Stop everything?"
        testId="kill-dialog"
      >
        <p className="text-sm">
          This sends a kill command to {describeTargets(targets.length > 0 ? targets : ["pc"])}:
          every session stops, run tokens are revoked and claims are frozen. Work in progress is
          lost.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setKill({ kind: "idle" })}>Cancel</Button>
          <Button variant="danger" data-testid="kill-confirm" onClick={() => void sendKill()}>
            Stop everything
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
