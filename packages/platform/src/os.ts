import os from "node:os";

export type Platform = "windows" | "linux" | "macos" | "android" | "unknown";

/** Normalised platform name. macOS is best effort, Android is a client only. */
export function currentPlatform(p: NodeJS.Platform = process.platform): Platform {
  switch (p) {
    case "win32":
      return "windows";
    case "linux":
      return process.env.ANDROID_ROOT ? "android" : "linux";
    case "darwin":
      return "macos";
    case "android":
      return "android";
    default:
      return "unknown";
  }
}

export const isWindows = (): boolean => currentPlatform() === "windows";
export const isLinux = (): boolean => currentPlatform() === "linux";

export interface OsFacts {
  platform: Platform;
  release: string;
  arch: string;
  hostname: string;
  cpus: number;
  totalMemoryMb: number;
  /** Linux only: wayland | x11 | unknown. Windows: win32. */
  displayServer: "wayland" | "x11" | "win32" | "none" | "unknown";
  /** Which keychain backend is expected on this OS. */
  keychain: "credential-manager" | "libsecret" | "keychain" | "none";
  shell: "powershell" | "cmd" | "sh";
}

export function osFacts(env: NodeJS.ProcessEnv = process.env): OsFacts {
  const platform = currentPlatform();
  let displayServer: OsFacts["displayServer"] = "unknown";
  if (platform === "windows") displayServer = "win32";
  else if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) displayServer = "wayland";
    else if (env.DISPLAY) displayServer = "x11";
    else displayServer = "none";
  }
  const keychain: OsFacts["keychain"] =
    platform === "windows"
      ? "credential-manager"
      : platform === "linux"
        ? "libsecret"
        : platform === "macos"
          ? "keychain"
          : "none";
  return {
    platform,
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    displayServer,
    keychain,
    shell: platform === "windows" ? "powershell" : "sh",
  };
}
