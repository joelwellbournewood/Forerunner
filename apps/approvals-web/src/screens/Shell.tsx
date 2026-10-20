import { type ReactNode, useEffect, useState } from "react";
import { NavLink } from "react-router";
import { type ApiError, describeError } from "../api/client.ts";
import { changedId, type RemoteCommandView, type RemoteTarget } from "../api/types.ts";
import { Badge, Banner, Button, Dialog } from "../components/ui.tsx";
import { useApp } from "../store/AppContext.tsx";

/**
 * Header with the active project (spec K.8: always shown), the two screens, the feed
 * status, sign out and the kill switch (spec S.8): a confirm dialog, then a `kill` remote
 * command to the PC (and to the cloud runner when it has sessions), whose pick-up and
 * outcome are shown as they arrive. The targets are sent independently: a command the
 * service accepted stays on the screen with its status even when the other target was
 * refused, so the human always sees whether the PC stopped.
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

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const [kill, setKill] = useState<KillState>({ kind: "idle" });
  const canRemote = app.client.hasScope("write:remote");
  const pcOnline = app.presence?.pcOnline ?? false;

  useEffect(() => {
    if (kill.kind !== "sent") return;
    const ids = new Set(kill.commands.map((c) => c.id));
    const refresh = async () => {
      const updated = await Promise.all(
        kill.commands.map((c) => app.client.remoteCommand(c.id).catch(() => c)),
      );
      setKill((current) => (current.kind === "sent" ? { ...current, commands: updated } : current));
    };
    const offChange = app.onChange((e) => {
      if (e.type === "remote_command.changed" && ids.has(changedId(e) ?? "")) void refresh();
    });
    const offPoll = app.onPoll(() => void refresh());
    return () => {
      offChange();
      offPoll();
    };
  }, [kill, app]);

  async function sendKill() {
    setKill({ kind: "sending" });
    const targets: RemoteTarget[] = ["pc"];
    if (app.presence?.cloudActive) targets.push("cloud");
    // Every target gets its own request; one refusal must not hide a command already sent.
    const results = await Promise.allSettled(
      targets.map((target) =>
        app.client.sendRemoteCommand({ target, command: "kill", params: { scope: "all" } }),
      ),
    );
    const commands: RemoteCommandView[] = [];
    const failures: KillFailure[] = [];
    results.forEach((result, i) => {
      const target = targets[i] ?? "pc";
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
    : !pcOnline
      ? "No PC is online to receive the kill command."
      : "Stop every session on your PC";

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
              disabled={!canRemote || !pcOnline || kill.kind === "sending"}
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
          This sends a kill command to your PC
          {app.presence?.cloudActive ? " and the cloud runner" : ""}: every session stops, run
          tokens are revoked and claims are frozen. Work in progress is lost.
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
