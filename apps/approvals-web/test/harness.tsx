import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { App } from "../src/App.tsx";
import type { WebConfig } from "../src/api/config.ts";
import { type FetchLike, SESSION_KEY } from "../src/api/session.ts";
import { browserClock, type Clock } from "../src/lib/clock.ts";
import { type KeyValueStore, sessionStore } from "../src/lib/storage.ts";
import {
  type FakeOptions,
  type FakeStateService,
  startFakeStateService,
} from "./fake-state-service.ts";

/**
 * Test harness without Testing Library (not among this app's dependencies): the fake
 * service on 127.0.0.1, the page mounted with `react-dom/client`, DOM queries by test id,
 * user actions inside `act()` and a `waitFor` that lets React flush between polls.
 */
export const PAGE_URL = "http://localhost/";

export interface Harness {
  fake: FakeStateService;
  storage: KeyValueStore;
  clock: Clock;
  config: WebConfig;
  root: Root | null;
  container: HTMLDivElement | null;
  /** Every console call made while the harness lives, for the leak assertion. */
  consoleLines: string[];
  close(): Promise<void>;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export async function createHarness(options: FakeOptions = {}): Promise<Harness> {
  const clock = options.clock ?? browserClock;
  const fake = await startFakeStateService({ ...options, clock });
  const consoleLines: string[] = [];
  const spies = CONSOLE_METHODS.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  const harness: Harness = {
    fake,
    storage: sessionStore(),
    clock,
    config: { baseUrl: fake.url, deviceName: "Test browser", source: "env" },
    root: null,
    container: null,
    consoleLines,
    async close() {
      if (harness.root) {
        const root = harness.root;
        await userAct(() => root.unmount());
        harness.root = null;
      }
      harness.container?.remove();
      harness.container = null;
      for (const s of spies) s.mockRestore();
      await fake.close();
    },
  };
  return harness;
}

/** Run `fn` as a user interaction: React's act() flushes everything it caused. */
export async function userAct(fn: () => void | Promise<void>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      await fn();
    });
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

export interface MountOptions {
  /** A one-time code to put in the fragment before the page loads (the link the human got). */
  code?: string;
  route?: string;
  feed?: { pollIntervalMs?: number; retryMs?: number };
  /** Replaces the page's fetch (see `delayingFetch`) to shape timing without touching the fake. */
  fetchImpl?: FetchLike;
}

/** Mount the page. With `code`, the address bar carries `#code=...` as the issued link does. */
export async function mountApp(h: Harness, options: MountOptions = {}): Promise<void> {
  if (options.code) window.location.hash = `#code=${options.code}`;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  h.container = container;
  h.root = root;
  await userAct(() => {
    root.render(
      <MemoryRouter initialEntries={[options.route ?? "/"]}>
        <App
          config={h.config}
          storage={h.storage}
          clock={h.clock}
          feedOptions={{ pollIntervalMs: 100, retryMs: 200, ...options.feed }}
          {...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})}
        />
      </MemoryRouter>,
    );
  });
}

/** Unmount the page as a navigation away would, keeping the tab's storage and the fake. */
export async function unmountApp(h: Harness): Promise<void> {
  if (h.root) {
    const root = h.root;
    await userAct(() => root.unmount());
    h.root = null;
  }
  h.container?.remove();
  h.container = null;
}

/** Mount from a freshly issued link and wait until the shell is up. */
export async function openFromLink(
  h: Harness,
  options: MountOptions & { scopes?: string[] } = {},
): Promise<string> {
  const code = h.fake.startPairing({ scopes: options.scopes });
  await mountApp(h, { ...options, code });
  await waitFor(() => $("active-project") !== null, "shell");
  return code;
}

export function $(testId: string, within: ParentNode = document): HTMLElement | null {
  return within.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

export function $$(testId: string, within: ParentNode = document): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

export function must(testId: string, within: ParentNode = document): HTMLElement {
  const el = $(testId, within);
  if (!el) throw new Error(`no element with data-testid="${testId}"`);
  return el;
}

export function bodyText(): string {
  return document.body.textContent ?? "";
}

export async function click(el: Element): Promise<void> {
  await userAct(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Type into a React-controlled input or textarea. */
export async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): Promise<void> {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await userAct(() => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function select(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await userAct(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function submit(form: Element): Promise<void> {
  await userAct(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** Poll until `fn` returns a truthy value (or stops throwing); React flushes in between. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  what = "condition",
  { timeoutMs = 15_000, intervalMs = 15 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}${lastError instanceof Error ? `: ${lastError.message}` : ""}\n${bodyText().slice(0, 500)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A fetch that holds the response of every matching request for `ms` after the fake has
 * answered it: the service (and its scripted PC) proceeds, the feed keeps delivering, but the
 * page learns the outcome of that request late. Reproduces a slow network on one call.
 */
export function delayingFetch(
  matches: (url: string, init?: RequestInit) => boolean,
  ms: number,
): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    if (matches(url, init)) await sleep(ms);
    return res;
  };
}

/** Matches the page's `POST /remote/commands` whose JSON body contains `fragment`. */
export function remoteCommandPost(fragment = ""): (url: string, init?: RequestInit) => boolean {
  return (url, init) =>
    init?.method === "POST" &&
    url.endsWith("/remote/commands") &&
    (typeof init.body === "string" ? init.body : "").includes(fragment);
}

/** The token the page holds (read the way the page stores it), for leak assertions. */
export function sessionToken(h: Harness): string | null {
  const raw = h.storage.get(SESSION_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { token?: string };
  return parsed.token ?? null;
}

/** Everything that must never contain the token: cookies, localStorage, console, URLs the fake saw. */
export function assertNoTokenLeak(h: Harness, token: string): void {
  if (document.cookie.includes(token)) throw new Error("token found in document.cookie");
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) ?? "";
    if (key.includes(token) || (localStorage.getItem(key) ?? "").includes(token)) {
      throw new Error("token found in localStorage");
    }
  }
  for (const line of h.consoleLines) {
    if (line.includes(token))
      throw new Error(`token found in console output: ${line.slice(0, 40)}…`);
  }
  for (const call of h.fake.calls()) {
    if (call.path.includes(token) || call.query.includes(token)) {
      throw new Error(`token found in a URL: ${call.method} ${call.path}`);
    }
  }
  if (window.location.href.includes(token)) throw new Error("token found in the address bar");
}
