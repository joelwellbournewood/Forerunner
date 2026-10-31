import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform/paths";
import { describe, expect, it } from "vitest";

/**
 * U-018 (ADR 0094), U-066: the MSI ends what runs from the install folder before Windows
 * Installer checks for files in use. These checks keep its safety properties from drifting: it
 * runs before InstallValidate, only when a version is installed, never fails the install, and
 * ends only processes started from the install folder plus the daemon's own tree. The command
 * is formatted the way Windows Installer formats it and split the way Windows splits a command
 * line, so a folder named with an apostrophe, brackets or braces is tested as such. On Windows
 * the formatted command also runs against real processes; the installed-app check
 * (scripts/installed-check.ps1) runs the real MSI with Forerunner running.
 */
const DESKTOP = join(process.cwd(), "apps", "desktop", "src-tauri");
const wxs = readFileSync(join(DESKTOP, "wix", "stop-running.wxs"), "utf8");
const conf = JSON.parse(readFileSync(join(DESKTOP, "tauri.conf.json"), "utf8")) as {
  bundle: { windows: { wix: { fragmentPaths?: string[]; componentRefs?: string[] } } };
};

function unxml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(element: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(element);
  return m ? unxml(m[1] as string) : undefined;
}

/** Windows Installer's formatting of a property value: [\x] escapes, [NAME] references. */
function msiFormat(text: string, props: Record<string, string>): string {
  return text.replace(/\[(\\.|[^[\]]*)\]/g, (_, inner: string) => {
    if (inner.startsWith("\\")) return inner.slice(1);
    if (!(inner in props)) throw new Error(`unexpected property reference [${inner}]`);
    return props[inner] as string;
  });
}

/** How a Windows program splits its command line (CommandLineToArgvW and the C runtime). */
function windowsArgv(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  // The program name: quotes group, backslashes are literal.
  let program = "";
  if (cmd[0] === '"') {
    const end = cmd.indexOf('"', 1);
    program = cmd.slice(1, end);
    i = end + 1;
  } else {
    while (i < cmd.length && !/\s/.test(cmd[i] as string)) program += cmd[i++];
  }
  out.push(program);
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i] as string)) i++;
    if (i >= cmd.length) break;
    let arg = "";
    let quoted = false;
    while (i < cmd.length && (quoted || !/\s/.test(cmd[i] as string))) {
      let slashes = 0;
      while (cmd[i] === "\\") {
        slashes++;
        i++;
      }
      if (cmd[i] === '"') {
        arg += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          arg += '"';
        } else if (quoted && cmd[i + 1] === '"') {
          arg += '"';
          i++;
        } else {
          quoted = !quoted;
        }
        i++;
      } else {
        arg += "\\".repeat(slashes);
        if (i < cmd.length && (quoted || !/\s/.test(cmd[i] as string))) arg += cmd[i++];
      }
    }
    out.push(arg);
  }
  return out;
}

const property = /<Property Id="WixQuietExec64CmdLine" Value="([^"]+)"/.exec(wxs)?.[1] ?? "";
const raw = unxml(property);
const customAction = /<CustomAction\s[^>]*Id="StopRunningForerunner"[^>]*\/>/.exec(wxs)?.[0] ?? "";

// An install folder and a profile whose names would break a quoted or a wildcard command.
const INSTALLDIR = "D:\\It's [x] {y} & 100%\\Forerunner\\";
const LOCALAPPDATA = "C:\\Users\\Zoë O'Neil\\AppData\\Local\\";
const SYSTEM64 = "C:\\Windows\\System32\\";
const formatted = msiFormat(raw, {
  INSTALLDIR,
  LocalAppDataFolder: LOCALAPPDATA,
  System64Folder: SYSTEM64,
});
const argv = windowsArgv(formatted);
const script = argv[argv.indexOf("-Command") + 1] ?? "";

describe("the MSI stops Forerunner's own processes before it replaces files (U-018, U-066)", () => {
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
    expect(attr(customAction, "Return")).toBe("ignore");
    // Immediate: it runs as the person installing, who owns the processes and the daemon.json.
    expect(attr(customAction, "Execute")).toBe("immediate");
    expect(attr(customAction, "Impersonate")).not.toBe("no");
  });

  it("runs hidden through WiX's quiet exec, 64-bit, with the command line it formats once", () => {
    expect(attr(customAction, "BinaryKey")).toBe("WixCA");
    expect(attr(customAction, "DllEntry")).toBe("WixQuietExec64");
    expect(attr(customAction, "ExeCommand")).toBeUndefined();
    // QuietExec refuses a command that does not start with a quoted program.
    expect(formatted.startsWith(`"${SYSTEM64}WindowsPowerShell\\v1.0\\powershell.exe" `)).toBe(
      true,
    );
    expect(argv.slice(1, argv.indexOf("-Command"))).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    // The only property references are the three folders; every other bracket and brace in
    // the script is escaped, so formatting cannot eat a piece of PowerShell.
    const refs = [...raw.matchAll(/\[([^\\[\]][^[\]]*)\]/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(["System64Folder", "INSTALLDIR", "LocalAppDataFolder"]));
    expect(raw.replace(/\[\\.\]/g, "")).not.toMatch(/[{}]/);
  });

  it("passes the folders as separate arguments, so apostrophes and brackets cannot break it", () => {
    expect(argv.at(-2)).toBe(`${INSTALLDIR}.`);
    expect(argv.at(-1)).toBe(`${LOCALAPPDATA}.`);
    expect(argv.length).toBe(argv.indexOf("-Command") + 4);
    // PowerShell joins what follows -Command into one command: the folders land after the
    // script's closing comment and are read from the process's own arguments instead.
    expect(script.trimEnd().endsWith("#")).toBe(true);
    expect(script).not.toContain(INSTALLDIR.slice(0, -1));
    expect(script).toContain("[Environment]::GetCommandLineArgs()");
    expect(script).toContain("$dir = $a[-2]; $local = $a[-1];");
  });

  it("ends only what runs from the install folder, compared without wildcards, and the daemon's own tree", () => {
    expect(script).toContain("$ci = [StringComparison]::OrdinalIgnoreCase;");
    expect(script).toContain(
      "Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir, $ci) }",
    );
    expect(script).toContain("$left | Stop-Process -Force");
    expect(script).not.toMatch(/-Like|-Match|-Name|node\.exe|Get-Process -Name/i);
    // A folder that is not a full path (an empty property) or a drive's root stops nothing.
    expect(script).toContain("if (-not [IO.Path]::IsPathRooted($dir)) { exit 0 };");
    expect(script).toContain("if ([IO.Path]::GetPathRoot($dir) -eq $dir) { exit 0 };");
    // The tree: only the pid daemon.json names, only while it runs from the install folder,
    // and before the sweep (ending the daemon first would orphan what it started).
    const tree = script.indexOf("taskkill.exe /PID $id /T /F");
    const sweep = script.indexOf("Stop-Process -Force");
    expect(tree).toBeGreaterThan(0);
    expect(tree).toBeLessThan(sweep);
    expect(script).toContain(
      "if ($p.Path -and $p.Path.StartsWith($dir, $ci)) { taskkill.exe /PID $id /T /F | Out-Null }",
    );
    expect(script.match(/taskkill/g)).toHaveLength(1);
    expect(script).toContain("[IO.Path]::Combine($h, 'runtime', 'daemon.json')");
    expect(script).toContain(
      "[IO.Path]::Combine([IO.Path]::GetFullPath($local), 'forerunner', 'runtime', 'daemon.json')",
    );
  });

  it.runIf(process.platform === "win32")(
    "on Windows: ends the processes in the install folder and the daemon's tree, and nothing else",
    { timeout: 180_000 },
    async () => {
      // A long path: the runner's temp folder may be an 8.3 short name.
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fr-msi-step-")));
      const installDir = join(root, "It's [x] {y} & 100%", "Forerunner");
      mkdirSync(installDir, { recursive: true });
      const node = join(installDir, "node.exe");
      copyFileSync(process.execPath, node);
      const local = join(root, "Local");
      const childPidFile = join(root, "child.pid");
      const idle = "setInterval(() => {}, 1000)";
      const start = (exe: string, args: string[]) =>
        spawn(exe, args, { stdio: "ignore", windowsHide: true });
      const exited = (c: ChildProcess) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) resolve();
          else c.once("exit", () => resolve());
        });
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // The shell or the tsx parent: runs from the install folder.
      const inFolder = start(node, ["-e", idle]);
      // The daemon: from the install folder, with a child outside it (the voice python, npx).
      const daemon = start(node, [
        "-e",
        `const c = require("child_process").spawn(process.argv[1], ["-e", ${JSON.stringify(idle)}], { stdio: "ignore" }); require("fs").writeFileSync(process.argv[2], String(c.pid)); ${idle}`,
        process.execPath,
        childPidFile,
      ]);
      // Someone else's program, outside the folder and not the daemon's child: untouched.
      const bystander = start(process.execPath, ["-e", idle]);
      try {
        let daemonChild = 0;
        for (let i = 0; i < 200 && !daemonChild; i++) {
          daemonChild = Number(readFileSync(childPidFile, { encoding: "utf8", flag: "a+" }) || 0);
          if (!daemonChild) await new Promise((r) => setTimeout(r, 50));
        }
        expect(daemonChild).toBeGreaterThan(0);
        mkdirSync(join(local, "forerunner", "runtime"), { recursive: true });
        writeFileSync(
          join(local, "forerunner", "runtime", "daemon.json"),
          JSON.stringify({ pid: daemon.pid }),
        );
        const system64 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\`;
        const command = msiFormat(raw, {
          INSTALLDIR: `${installDir}\\`,
          LocalAppDataFolder: `${local}\\`,
          System64Folder: system64,
        });
        // What QuietExec does: CreateProcess with the formatted command line as it is.
        const program = command.slice(1, command.indexOf('"', 1));
        const rest = command.slice(command.indexOf('"', 1) + 2);
        const env = { ...process.env };
        delete env.FORERUNNER_HOME;
        const r = spawnSync(program, [rest], {
          argv0: `"${program}"`,
          windowsVerbatimArguments: true,
          windowsHide: true,
          encoding: "utf8",
          timeout: 120_000,
          env,
        });
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
        await Promise.all([exited(inFolder), exited(daemon)]);
        for (let i = 0; i < 100 && alive(daemonChild); i++)
          await new Promise((r) => setTimeout(r, 100));
        expect(alive(daemonChild), "the daemon's child outside the folder still runs").toBe(false);
        expect(alive(bystander.pid as number), "a program outside the folder was ended").toBe(true);
      } finally {
        for (const c of [inFolder, daemon, bystander]) c.kill();
      }
    },
  );
});
