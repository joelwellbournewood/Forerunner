/**
 * Where the page finds the state service (ADR 0024: the service serves this page, so the
 * default is the page's own origin). Resolution order:
 *   1. `window.__FORERUNNER__.stateUrl`, injected by a shell or by the service's HTML.
 *   2. `VITE_STATE_API_URL` at build time (dev server against a local service).
 *   3. `window.location.origin`.
 * Nothing here names a host, an org or a user path.
 */
export interface ShellInjection {
  stateUrl?: string;
  /** Suggested device name at pairing ("Web browser" by default). */
  deviceName?: string;
}

export type ConfigSource = "shell" | "env" | "origin";

export interface WebConfig {
  /** Absolute base URL of the state service without a trailing slash. */
  baseUrl: string;
  deviceName: string;
  source: ConfigSource;
}

export interface EnvLike {
  VITE_STATE_API_URL?: string;
}

declare global {
  interface Window {
    __FORERUNNER__?: ShellInjection;
  }
}

export const DEFAULT_DEVICE_NAME = "Web browser";

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveConfig(
  injection: ShellInjection | undefined,
  env: EnvLike | undefined,
  origin: string,
): WebConfig {
  const deviceName = nonEmpty(injection?.deviceName) ?? DEFAULT_DEVICE_NAME;
  const fromShell = nonEmpty(injection?.stateUrl);
  if (fromShell) return { baseUrl: stripSlash(fromShell), deviceName, source: "shell" };
  const fromEnv = nonEmpty(env?.VITE_STATE_API_URL);
  if (fromEnv) return { baseUrl: stripSlash(fromEnv), deviceName, source: "env" };
  return { baseUrl: stripSlash(origin), deviceName, source: "origin" };
}

/** The config of the running page, from the globals. */
export function configFromGlobals(): WebConfig {
  const injection = typeof window === "undefined" ? undefined : window.__FORERUNNER__;
  const env = import.meta.env as EnvLike | undefined;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return resolveConfig(injection, env, origin);
}
