import { useMemo } from "react";
import { BrowserRouter } from "react-router";
import { createClient, type DaemonClient } from "./api/client.ts";
import { daemonConfigFromGlobals } from "./api/config.ts";
import { browserStorage } from "./lib/storage.ts";
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
