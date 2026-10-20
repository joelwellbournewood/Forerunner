import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { createClient, type StateClient } from "./api/client.ts";
import { configFromGlobals, type WebConfig } from "./api/config.ts";
import type { FeedOptions } from "./api/events.ts";
import {
  clearSession,
  exchangeCode,
  type FetchLike,
  loadSession,
  parseFragment,
  saveSession,
  stripFragment,
  type WebSession,
} from "./api/session.ts";
import { browserClock, type Clock } from "./lib/clock.ts";
import { type KeyValueStore, sessionStore } from "./lib/storage.ts";
import { Chat } from "./screens/Chat.tsx";
import { Inbox } from "./screens/Inbox.tsx";
import { Shell } from "./screens/Shell.tsx";
import { SignIn, type SignInStatus } from "./screens/SignIn.tsx";
import { AppProvider } from "./store/AppContext.tsx";

/**
 * The approvals web page (spec K.8 "web fallback for approvals", module J, module R; ADR
 * 0009, ADR 0024). On load it looks for a one-time code in the URL fragment, strips it from
 * the address bar, exchanges it for a scoped session token and keeps the session in
 * `sessionStorage`; without a code it reuses the tab's session or explains how to get a link.
 * Routes are in memory: the page is two screens and must work from any path the service
 * mounts it on, and the fragment is reserved for the code.
 */
export interface AppProps {
  config?: WebConfig;
  storage?: KeyValueStore;
  clock?: Clock;
  fetchImpl?: FetchLike;
  feedOptions?: FeedOptions;
  /** The window whose location and history carry the fragment (tests pass a stub). */
  win?: Pick<Window, "location" | "history">;
}

export function App(props: AppProps) {
  const config = useMemo(() => props.config ?? configFromGlobals(), [props.config]);
  const storage = useMemo(() => props.storage ?? sessionStore(), [props.storage]);
  const clock = props.clock ?? browserClock;
  const win = props.win ?? window;
  const [session, setSession] = useState<WebSession | null>(null);
  const [status, setStatus] = useState<SignInStatus>({ kind: "exchanging" });
  const started = useRef(false);
  const { fetchImpl } = props;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = parseFragment(win.location.hash);
    if (code) {
      stripFragment(win);
      setStatus({ kind: "exchanging" });
      void exchangeCode({
        baseUrl: config.baseUrl,
        code,
        deviceName: config.deviceName,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
        .then((s) => {
          saveSession(storage, s);
          setSession(s);
        })
        .catch((err: unknown) => {
          setStatus({
            kind: "error",
            message: err instanceof Error ? err.message : "Could not sign in with this link.",
          });
        });
      return;
    }
    const existing = loadSession(storage, clock, config.baseUrl);
    if (existing) setSession(existing);
    else setStatus({ kind: "idle" });
  }, [config, storage, clock, win, fetchImpl]);

  const client = useMemo<StateClient | null>(
    () =>
      session
        ? createClient({
            baseUrl: config.baseUrl,
            session,
            clock,
            ...(fetchImpl ? { fetchImpl } : {}),
          })
        : null,
    [session, config, clock, fetchImpl],
  );

  if (!session || !client) return <SignIn status={status} />;

  const signOut = () => {
    clearSession(storage);
    setSession(null);
    setStatus({ kind: "idle" });
  };

  return (
    <AppProvider
      config={config}
      client={client}
      storage={storage}
      clock={clock}
      signOut={signOut}
      {...(props.feedOptions ? { feedOptions: props.feedOptions } : {})}
    >
      <Shell>
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </AppProvider>
  );
}
