import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { createClient, type DaemonClient, type FetchLike } from "../src/api/client.ts";
import type { DaemonConfig } from "../src/api/config.ts";
import { type KeyValueStore, memoryStorage } from "../src/lib/storage.ts";
import { AppRoutes } from "../src/routes.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { createStore, type UiStore } from "../src/store/store.ts";
import { createFakeDaemon, type FakeDaemonOptions } from "./fake-daemon.ts";

/** A config for tests: a fixed token, no shell injection. */
export function testConfig(token: string | null = "test-token"): DaemonConfig {
  return {
    baseUrl: "http://127.0.0.1:9",
    token,
    source: "env",
    installId: "test",
    platform: null,
    shellVersion: null,
  };
}

/** fetch that routes into the in-process Hono app: no sockets, no network. */
export function fetchFromApp(app: {
  fetch: (req: Request) => Response | Promise<Response>;
}): FetchLike {
  return (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
}

export interface Harness {
  client: DaemonClient;
  store: UiStore;
  storage: KeyValueStore;
  daemon: ReturnType<typeof createFakeDaemon>;
}

export function createHarness(options: FakeDaemonOptions & { token?: string } = {}): Harness {
  const token = options.token ?? "test-token";
  const daemon = createFakeDaemon({ eventDelayMs: 20, tokenDelayMs: 0, ...options, token });
  const config = testConfig(token);
  const client = createClient(config, fetchFromApp(daemon.app));
  const storage = memoryStorage();
  const store = createStore(config, storage);
  return { client, store, storage, daemon };
}

/** Mount the whole app (shell + routes) at `route` against the harness. */
export function renderApp(route = "/", harness: Harness = createHarness()) {
  const utils = render(
    <AppProvider client={harness.client} store={harness.store}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProvider>,
  );
  return { ...utils, ...harness };
}

/** Mount one element inside the providers and a router (for page-level tests). */
export function renderWith(element: ReactElement, harness: Harness = createHarness(), route = "/") {
  const utils = render(
    <AppProvider client={harness.client} store={harness.store} bootstrap={false}>
      <MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>
    </AppProvider>,
  );
  return { ...utils, ...harness };
}

export function postedCalls(harness: Harness, path: string) {
  return harness.daemon.state.calls.filter((c) => c.path === path);
}
