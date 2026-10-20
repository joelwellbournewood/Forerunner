import { useMemo } from "react";
import { BrowserRouter } from "react-router";
import { createClient, type DaemonClient } from "./api/client.ts";
import { daemonConfigFromGlobals, isMobileShell } from "./api/config.ts";
import { browserStorage } from "./lib/storage.ts";
import { MOBILE_BASENAME, MobileApp } from "./mobile/MobileApp.tsx";
import { AppRoutes } from "./routes.tsx";
import { AppProvider } from "./store/context.tsx";
import { createStore, type UiStore } from "./store/store.ts";

export interface AppProps {
  /** Injected by tests; the app builds them from the globals otherwise. */
  client?: DaemonClient;
  store?: UiStore;
}

/**
 * One UI for desktop and Android. The daemon client and the store are created once per page
 * load from `window.__FORERUNNER__` (Tauri shells) or the Vite env (dev server, Playwright).
 */
export function App(props: AppProps = {}) {
  // The Android shell (spec R, ADR 0026) and the `/m` path mount the phone screens instead.
  if (mobileRequested()) return <MobileApp />;
  return <DesktopApp {...props} />;
}

function mobileRequested(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location?.pathname ?? "";
  return (
    isMobileShell(window.__FORERUNNER__) ||
    path === MOBILE_BASENAME ||
    path.startsWith(`${MOBILE_BASENAME}/`)
  );
}

function DesktopApp(props: AppProps) {
  const { client, store } = useMemo(() => {
    const config = props.client?.config ?? daemonConfigFromGlobals();
    const c = props.client ?? createClient(config);
    const s = props.store ?? createStore(config, browserStorage());
    return { client: c, store: s };
  }, [props.client, props.store]);
  return (
    <AppProvider client={client} store={store}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>
  );
}
