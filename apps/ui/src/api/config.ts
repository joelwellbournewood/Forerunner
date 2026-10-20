/**
 * Where the UI finds the local daemon (ADR 0011, ADR 0014).
 *
 * Resolution order:
 *   1. `window.__FORERUNNER__` injected by the Tauri shell (desktop, Android) from `daemon.json`.
 *   2. `VITE_DAEMON_URL` / `VITE_DAEMON_TOKEN` at build time (dev server, Playwright runs).
 *   3. The default `http://127.0.0.1:8787` with no token: the UI renders in a "not connected"
 *      state until `/health` answers.
 *
 * Nothing here is specific to a host, org or user path.
 */

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:8787";

/** What a shell may inject before the bundle runs. Every field is optional. */
export interface ShellInjection {
  daemonUrl?: string;
  daemonToken?: string;
  /** Stable id of this install; namespaces per-install browser storage. */
  installId?: string;
  /** "windows" | "linux" | "android" | ... as reported by the shell. */
  platform?: string;
  /** Shell product version, shown in Settings. */
  shellVersion?: string;
}

declare global {
  interface Window {
    __FORERUNNER__?: ShellInjection;
  }
}

export type DaemonConfigSource = "shell" | "env" | "default";

export interface DaemonConfig {
  /** Absolute base URL without a trailing slash. */
  baseUrl: string;
  /** Bearer token; null when nothing provided one (the daemon will answer 401). */
  token: string | null;
  source: DaemonConfigSource;
  installId: string | null;
  platform: string | null;
  shellVersion: string | null;
}

export interface EnvLike {
  VITE_DAEMON_URL?: string;
  VITE_DAEMON_TOKEN?: string;
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pure resolver; `injection` and `env` are parameters so tests cover every branch without
 * touching globals.
 */
export function resolveDaemonConfig(
  injection: ShellInjection | undefined,
  env: EnvLike | undefined,
): DaemonConfig {
  const shellUrl = nonEmpty(injection?.daemonUrl);
  if (shellUrl) {
    return {
      baseUrl: stripSlash(shellUrl),
      token: nonEmpty(injection?.daemonToken),
      source: "shell",
      installId: nonEmpty(injection?.installId),
      platform: nonEmpty(injection?.platform),
      shellVersion: nonEmpty(injection?.shellVersion),
    };
  }
  const envUrl = nonEmpty(env?.VITE_DAEMON_URL);
  if (envUrl) {
    return {
      baseUrl: stripSlash(envUrl),
      token: nonEmpty(env?.VITE_DAEMON_TOKEN),
      source: "env",
      installId: nonEmpty(injection?.installId),
      platform: nonEmpty(injection?.platform),
      shellVersion: nonEmpty(injection?.shellVersion),
    };
  }
  return {
    baseUrl: DEFAULT_DAEMON_URL,
    token: null,
    source: "default",
    installId: nonEmpty(injection?.installId),
    platform: nonEmpty(injection?.platform),
    shellVersion: nonEmpty(injection?.shellVersion),
  };
}

/** The config for this page load. */
export function daemonConfigFromGlobals(): DaemonConfig {
  const injection = typeof window === "undefined" ? undefined : window.__FORERUNNER__;
  const env: EnvLike = {
    VITE_DAEMON_URL: import.meta.env.VITE_DAEMON_URL,
    VITE_DAEMON_TOKEN: import.meta.env.VITE_DAEMON_TOKEN,
  };
  return resolveDaemonConfig(injection, env);
}
