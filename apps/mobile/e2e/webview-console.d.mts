/**
 * Types for `webview-console.mjs` (the emulator runner's `webview:` lines, ADR 0085), so
 * `cdp.test.ts` type-checks its calls. Keep in step with `webview-console.mjs`. The client is
 * structural: the driver's `CdpClient` (`cdp.mjs`) fits it.
 */

export declare const MAX_FORWARDED_LINE: number;

/** The part of a CDP client the forwarding uses. */
export interface ConsoleClient {
  onEvent(listener: (event: { method: string; params: unknown }) => void): () => void;
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
}

export declare function remoteObjectText(arg: Record<string, unknown> | undefined): string;

export declare function formatConsoleEvent(
  params: Record<string, unknown>,
  prefix?: string,
): string;

export declare function formatException(params: Record<string, unknown>, prefix?: string): string;

export declare function forwardPageConsole(
  client: ConsoleClient,
  options?: { write?: (line: string) => void; prefix?: string; timeoutMs?: number },
): Promise<{ stop: () => void; enabled: boolean }>;
