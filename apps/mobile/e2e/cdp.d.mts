/**
 * Types for `cdp.mjs` (the raw CDP driver of the Android emulator smoke, ADR 0054), so
 * `cdp.test.ts` type-checks its calls instead of seeing `any`. Keep in step with `cdp.mjs`.
 */

export declare const DEFAULT_TIMEOUT_MS: number;

/** A target as `GET /json/list` reports it. */
export interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export declare class CdpError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  readonly code: string;
  readonly details: Record<string, unknown>;
}

/** The runner's `FAIL:` line: message, `[code]` and the details as JSON when present. */
export declare function describeFailure(error: unknown): string;

/** At most this many lines of screen text in `describePage`. */
export declare const PAGE_TEXT_LINES: number;

/** The runner's `page:` lines after a failure: URL, title and the visible text of `<main>`. */
export declare function describePage(page: Page): Promise<string>;

export declare function listTargets(
  httpBase: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<CdpTarget[]>;

export declare function pickPageTarget(
  targets: CdpTarget[],
  options?: { prefer?: (target: CdpTarget) => boolean },
): CdpTarget;

export declare function socketUrlFor(httpBase: string, target: CdpTarget): string;

export interface CdpEvent {
  method: string;
  params: unknown;
}

export declare class CdpClient {
  static connect(
    url: string,
    options?: { WebSocketImpl?: typeof WebSocket; timeoutMs?: number },
  ): Promise<CdpClient>;
  constructor(ws: WebSocket, options?: { timeoutMs?: number });
  readonly closed: boolean;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /** `T` is the method's result shape (the protocol's, not checked at run time). */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  close(): void;
}

export interface PageOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  /** The driver's own lines on the runner's stdout (`click fallback: ...`); default `console.log`. */
  log?: (line: string) => void;
}

export interface RoleOptions {
  name?: string;
  exact?: boolean;
}

export interface TextOptions {
  exact?: boolean;
}

export interface TimeoutOptions {
  timeout?: number;
}

export declare class Page {
  constructor(client: CdpClient, options?: PageOptions);
  readonly client: CdpClient;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly now: () => number;
  readonly log: (line: string) => void;
  evaluate(expression: string, options?: { timeoutMs?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): Promise<string>;
  mouseClick(x: number, y: number): Promise<void>;
  /** One tap through `Input.dispatchTouchEvent` (touchStart, touchEnd) at viewport CSS coordinates. */
  touchTap(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  locator(css: string): Locator;
  getByTestId(id: string): Locator;
  getByRole(role: string, options?: RoleOptions): Locator;
  getByText(text: string, options?: TextOptions): Locator;
}

export declare class Locator {
  constructor(page: Page, steps: Array<Record<string, unknown>>);
  readonly page: Page;
  readonly steps: Array<Record<string, unknown>>;
  toString(): string;
  locator(css: string): Locator;
  getByTestId(id: string): Locator;
  getByRole(role: string, options?: RoleOptions): Locator;
  getByText(text: string, options?: TextOptions): Locator;
  filter(options: { has: Locator }): Locator;
  first(): Locator;
  last(): Locator;
  nth(n: number): Locator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  waitFor(options?: TimeoutOptions & { state?: "visible" | "attached" }): Promise<void>;
  /**
   * Waits for the layout to settle, scrolls the element into view, measures and hit-tests it
   * in one in-page call and clicks the centre through CDP mouse events; an in-page guard
   * stops events that land outside the element and the click is sent again. After three
   * guarded misses at one unchanged box the fallback ladder runs (a shifted mouse click, a
   * tap, `element.click()` in the page), each announced on `page.log` as `click fallback:`.
   * Errors: `cdp.click_missed`, `cdp.click_intercepted`, `cdp.click_unsettled`,
   * `cdp.click_lost`.
   */
  click(options?: TimeoutOptions): Promise<void>;
  fill(value: string, options?: TimeoutOptions): Promise<void>;
  innerText(options?: TimeoutOptions): Promise<string>;
  getAttribute(name: string, options?: TimeoutOptions): Promise<string | null>;
  /** `fnSource` is a function expression's source, e.g. `"(el) => el.tagName"`. */
  evaluate(fnSource: string, options?: TimeoutOptions): Promise<unknown>;
}

export declare function connectPage(
  httpBase: string,
  options?: {
    prefer?: (target: CdpTarget) => boolean;
    waitForTargetMs?: number;
    pollMs?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    WebSocketImpl?: typeof WebSocket;
    now?: () => number;
    log?: (line: string) => void;
  },
): Promise<{ client: CdpClient; page: Page; target: CdpTarget }>;
