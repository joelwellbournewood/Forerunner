import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router";
import type { HumanRequestView } from "../api/state-client.ts";
import { useAutoUnlock } from "../components/UnlockCard.tsx";
import { Badge, Button, Loading } from "../components/ui.tsx";
import type { PreparedAnswer } from "../lib/runner-unlock.ts";
import { applyTheme } from "../store/theme.ts";
import { ChangesScreen } from "./screens/ChangesScreen.tsx";
import { ChatScreen } from "./screens/ChatScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { InboxScreen } from "./screens/InboxScreen.tsx";
import { PairingScreen } from "./screens/PairingScreen.tsx";
import { RemoteScreen } from "./screens/RemoteScreen.tsx";
import { SessionScreen } from "./screens/SessionScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import {
  activeMobileProject,
  envFromGlobals,
  type MobileEnv,
  MobileProvider,
  useMobileController,
  useMobileState,
} from "./store.tsx";

/**
 * The Android app (spec R): the same React bundle as the desktop, mounted under `/m` with
 * phone screens that talk to the shared state service, never to a daemon (ADR 0026). The
 * shell injects `platform: "android"` (and may inject `stateUrl`), which makes `App.tsx`
 * render this tree; `/m` in a browser renders it too, with WebCrypto and browser storage
 * standing in for the Keystore and the biometric prompt (both visibly marked as such).
 */
export const MOBILE_BASENAME = "/m";

export function MobileApp({ env }: { env?: MobileEnv }) {
  const resolved = useMemo(
    () => env ?? envFromGlobals(typeof window === "undefined" ? undefined : window.__FORERUNNER__),
    [env],
  );
  useEffect(() => {
    applyTheme("system");
  }, []);
  return (
    <MobileProvider env={resolved}>
      <BrowserRouter basename={mobileBasename()}>
        <MobileRoutes />
      </BrowserRouter>
    </MobileProvider>
  );
}

/** `/m` when the page was opened there (a browser); `/` in the Android shell, which serves the bundle at the root. */
export function mobileBasename(pathname?: string): string {
  const path =
    pathname ?? (typeof window === "undefined" ? "/" : (window.location?.pathname ?? "/"));
  return path === MOBILE_BASENAME || path.startsWith(`${MOBILE_BASENAME}/`) ? MOBILE_BASENAME : "/";
}

/** The route tree alone, for tests that mount it in a MemoryRouter. */
export function MobileRoutes() {
  return (
    <Routes>
      <Route element={<MobileShell />}>
        <Route index element={<HomeScreen />} />
        <Route path="pair" element={<PairingScreen />} />
        <Route path="inbox" element={<InboxScreen />} />
        <Route path="chat" element={<ChatScreen />} />
        <Route path="remote" element={<RemoteScreen />} />
        <Route path="changes" element={<ChangesScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="sessions/:id" element={<SessionScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/inbox", label: "Inbox", end: false },
  { to: "/chat", label: "Chat", end: false },
  { to: "/remote", label: "Remote", end: false },
  { to: "/settings", label: "Settings", end: false },
];

function syncTone(mode: string): "good" | "warn" | "bad" | "neutral" {
  if (mode === "live") return "good";
  if (mode === "polling" || mode === "connecting") return "warn";
  if (mode === "offline") return "bad";
  return "neutral";
}

export function syncLabel(mode: string, pending: number): string {
  const base =
    mode === "live"
      ? "live"
      : mode === "polling"
        ? "polling"
        : mode === "offline"
          ? "offline"
          : mode === "connecting"
            ? "connecting"
            : "idle";
  return pending > 0 ? `${base} · ${pending} queued` : base;
}

function MobileShell() {
  const controller = useMobileController();
  const state = useMobileState((s) => s);
  const location = useLocation();
  const active = activeMobileProject(state);
  const onPairing = location.pathname === "/pair";

  // Cloud runner auto-unlock (spec S.12, ADR 0068): inside the window this phone set, the next
  // challenge is answered without a choice on whatever screen is open (the fingerprint still).
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null);
  const openRequests = useMemo(
    () => (state.inbox?.requests ?? []).filter((r) => r.status === "open"),
    [state.inbox],
  );
  const sendUnlock = useCallback(
    (request: HumanRequestView, prepared: PreparedAnswer) =>
      controller.answerUnlock(request, prepared),
    [controller],
  );
  useAutoUnlock({
    requests: state.stage === "paired" ? openRequests : [],
    bridge: controller.runnerKeys,
    windowUntil: state.unlockWindowUntil,
    now: controller.env.now,
    send: sendUnlock,
    notify: setUnlockNotice,
  });

  if (state.stage === "loading") {
    return (
      <div className="p-4">
        <Loading what="your paired device" />
      </div>
    );
  }
  if (state.stage === "unpaired" && !onPairing) return <Navigate to="/pair" replace />;

  return (
    <div
      className="flex h-full min-h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
      data-testid="m-shell"
    >
      <header
        className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800"
        data-testid="m-header"
      >
        <span className="font-semibold">Forerunner</span>
        {state.stage === "paired" ? (
          <span
            className="truncate rounded bg-neutral-100 px-2 py-0.5 text-sm dark:bg-neutral-800"
            data-testid="m-active-project"
            title="Active project"
          >
            {active ? active.name : "No active project"}
          </span>
        ) : null}
        <span className="ml-auto">
          <Badge tone={syncTone(state.syncMode)} testId="m-sync">
            {syncLabel(state.syncMode, state.outboxPending)}
          </Badge>
        </span>
      </header>
      {state.notice ? (
        <output
          className="border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="m-notice"
        >
          {state.notice}
        </output>
      ) : null}
      {state.notices[0] ? (
        <output
          className="border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
          data-testid="m-push-notice"
        >
          {state.notices[0].title}: {state.notices[0].body}
        </output>
      ) : null}
      {unlockNotice ? (
        <output
          className="border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
          data-testid="m-unlock-notice"
        >
          {unlockNotice}
        </output>
      ) : null}
      <main className="flex-1 overflow-auto p-3 pb-20">
        <Outlet />
      </main>
      {state.stage === "paired" ? (
        <nav
          className="fixed inset-x-0 bottom-0 flex border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
          aria-label="Main"
          data-testid="m-nav"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center px-1 py-2 text-xs ${
                  isActive
                    ? "font-semibold text-blue-700 dark:text-blue-300"
                    : "text-neutral-600 dark:text-neutral-400"
                }`
              }
            >
              <span>
                {item.label}
                {item.to === "/inbox" && state.blockingCount > 0 ? (
                  <span
                    className="ml-1 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white"
                    data-testid="m-inbox-badge"
                    role="status"
                    aria-label={`${state.blockingCount} blocking`}
                  >
                    {state.blockingCount}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
        </nav>
      ) : null}
      {state.biometricPrompt ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="m-biometric-title"
          data-testid="m-biometric-dialog"
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
            <h2 id="m-biometric-title" className="font-semibold">
              Simulated biometric prompt
            </h2>
            <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
              {state.biometricPrompt.reason}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Outside the Android shell there is no fingerprint or face prompt; this dialog stands
              in and is marked as simulated in the signed request.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="secondary"
                data-testid="m-biometric-cancel"
                onClick={() => state.biometricPrompt?.resolve(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="m-biometric-confirm"
                onClick={() => state.biometricPrompt?.resolve(true)}
              >
                Confirm (simulated)
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {controller.env.inShell ? null : (
        <p className="sr-only" data-testid="m-fallback-note">
          Running outside the Android shell: WebCrypto key and browser storage in use.
        </p>
      )}
    </div>
  );
}
