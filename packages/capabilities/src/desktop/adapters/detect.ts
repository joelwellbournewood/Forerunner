/**
 * Pick the adapter for this machine and say what is missing. Nothing is installed here: the
 * daemon's status view and the maintainer doc list the tools a human installs.
 */
import { currentPlatform, type Platform, which as whichOnPath } from "@forerunner/platform";
import { detectLinuxTools, LinuxDesktopAdapter } from "./linux.ts";
import type { DesktopAdapter, Runner, Which } from "./types.ts";
import { WindowsDesktopAdapter } from "./windows.ts";

export interface DetectOptions {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  which?: Which;
  run?: Runner;
}

export interface AdapterDetection {
  platform: Platform;
  displayServer: "wayland" | "x11" | "win32" | "none" | "unknown";
  adapter: DesktopAdapter | null;
  /** Tool name -> path, for everything found. */
  found: Record<string, string>;
  /** What a human must install or set before desktop control can work. */
  missing: string[];
  notes: string[];
}

export async function detectAdapter(opts: DetectOptions = {}): Promise<AdapterDetection> {
  const platform = opts.platform ?? currentPlatform();
  const env = opts.env ?? process.env;
  const which = opts.which ?? whichOnPath;
  const notes: string[] = [];

  if (platform === "linux") {
    const displayServer: AdapterDetection["displayServer"] = env.WAYLAND_DISPLAY
      ? "wayland"
      : env.DISPLAY
        ? "x11"
        : "none";
    const { tools, found, missing } = await detectLinuxTools(which);
    if (!env.DISPLAY) {
      missing.push("DISPLAY (an X11 display, or XWayland inside a Wayland session)");
    }
    if (displayServer === "wayland") {
      notes.push(
        "Wayland session: xdotool and wmctrl reach XWayland windows only; native Wayland windows cannot be controlled (spec: limited to what the portal allows)",
      );
    }
    const adapter =
      tools && env.DISPLAY
        ? new LinuxDesktopAdapter({ tools, env, ...(opts.run ? { run: opts.run } : {}) })
        : null;
    return { platform, displayServer, adapter, found, missing, notes };
  }

  if (platform === "windows") {
    const found: Record<string, string> = {};
    const missing: string[] = [];
    const powershell = (await which("powershell")) ?? (await which("pwsh"));
    if (powershell) found.powershell = powershell;
    else missing.push("powershell.exe (Windows PowerShell 5.1 or PowerShell 7)");
    const adapter = powershell
      ? new WindowsDesktopAdapter({ powershell, env, ...(opts.run ? { run: opts.run } : {}) })
      : null;
    return { platform, displayServer: "win32", adapter, found, missing, notes };
  }

  notes.push(`desktop control supports Windows and Linux only (this is ${platform})`);
  return {
    platform,
    displayServer: platform === "android" ? "none" : "unknown",
    adapter: null,
    found: {},
    missing: ["a supported platform (Windows or Linux)"],
    notes,
  };
}
