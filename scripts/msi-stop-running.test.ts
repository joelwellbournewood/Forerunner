import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * U-018 (ADR 0094): the MSI ends what runs from the install folder before Windows Installer
 * checks for files in use. The fragment cannot be run on Linux; these checks keep its safety
 * properties from drifting, and the Windows installed-app check runs it on every upgrade and
 * uninstall in CI.
 */
const DESKTOP = join(process.cwd(), "apps", "desktop", "src-tauri");
const wxs = readFileSync(join(DESKTOP, "wix", "stop-running.wxs"), "utf8");
const conf = JSON.parse(readFileSync(join(DESKTOP, "tauri.conf.json"), "utf8")) as {
  bundle: { windows: { wix: { fragmentPaths?: string[]; componentRefs?: string[] } } };
};

describe("the MSI stops Forerunner's own processes before it replaces files (U-018)", () => {
  it("is linked into the installer through its component", () => {
    const wix = conf.bundle.windows.wix;
    expect(wix.fragmentPaths).toContain("wix/stop-running.wxs");
    expect(wix.componentRefs).toContain("StopRunningForerunner");
    expect(wxs).toContain('<Component Id="StopRunningForerunner"');
  });

  it("runs before the files-in-use check, only when a version is installed, and never fails the install", () => {
    const custom = /<Custom Action="StopRunningForerunner" Before="([^"]+)">([^<]+)<\/Custom>/.exec(
      wxs,
    );
    expect(custom?.[1]).toBe("InstallValidate");
    expect(custom?.[2]?.trim()).toBe("Installed OR WIX_UPGRADE_DETECTED");
    expect(wxs).toMatch(/Return="ignore"/);
    // Immediate (the default): it runs as the person installing, who owns the processes.
    expect(wxs).not.toMatch(/Execute="(deferred|commit)"/);
  });

  it("ends only processes started from the install folder, never every node.exe", () => {
    const command = /ExeCommand="([^"]+)"/.exec(wxs)?.[1] ?? "";
    expect(command).toContain("Where-Object Path -Like '[INSTALLDIR]*'");
    expect(command).toContain("Stop-Process -Force");
    expect(command).not.toMatch(/-Name|node\.exe|taskkill/i);
  });
});
