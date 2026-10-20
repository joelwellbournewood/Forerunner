import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isForerunnerError, join, type RunOptions, type RunResult } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { detectAdapter } from "../src/desktop/adapters/detect.ts";
import {
  detectLinuxTools,
  hexWindowId,
  LinuxDesktopAdapter,
  type LinuxTools,
  linuxArgv,
  parseWmctrlLine,
} from "../src/desktop/adapters/linux.ts";
import {
  base64Arg,
  escapeSendKeys,
  parseWindowsList,
  toSendKeys,
  WINDOWS_SCRIPTS,
  WindowsDesktopAdapter,
  windowsArgv,
} from "../src/desktop/adapters/windows.ts";
import { parseKey, validateText } from "../src/desktop/keys.ts";

const whichOf = (present: Record<string, string>) => async (cmd: string) => present[cmd] ?? null;
const SHELLS = new Set(["sh", "bash", "zsh", "cmd", "cmd.exe", "/bin/sh", "/bin/bash"]);

function recorder(
  reply: (argv: readonly string[]) => Partial<RunResult> | undefined = () => undefined,
) {
  const calls: { argv: string[]; opts: RunOptions | undefined }[] = [];
  const run = async (argv: readonly string[], opts?: RunOptions): Promise<RunResult> => {
    calls.push({ argv: [...argv], opts });
    return {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      durationMs: 1,
      ...(reply(argv) ?? {}),
    };
  };
  return { calls, run };
}

const linuxTools: LinuxTools = {
  xdotool: "/usr/bin/xdotool",
  wmctrl: "/usr/bin/wmctrl",
  screenshot: { tool: "import", path: "/usr/bin/import" },
};

describe("adapter detection", () => {
  it("linux: reports every missing tool and gives no adapter", async () => {
    const d = await detectAdapter({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: whichOf({}),
    });
    expect(d.adapter).toBeNull();
    expect(d.displayServer).toBe("x11");
    expect(d.missing).toEqual([
      "xdotool",
      "wmctrl",
      "a screenshot tool (import, scrot, gnome-screenshot)",
    ]);
    const partial = await detectAdapter({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: whichOf({ xdotool: "/usr/bin/xdotool", scrot: "/usr/bin/scrot" }),
    });
    expect(partial.adapter).toBeNull();
    expect(partial.missing).toEqual(["wmctrl"]);
    expect(partial.found).toEqual({ xdotool: "/usr/bin/xdotool", scrot: "/usr/bin/scrot" });
  });

  it("linux: picks the adapter with xdotool, wmctrl, a screenshot tool and DISPLAY; prefers import", async () => {
    const which = whichOf({
      xdotool: "/usr/bin/xdotool",
      wmctrl: "/usr/bin/wmctrl",
      scrot: "/usr/bin/scrot",
      import: "/usr/bin/import",
    });
    const d = await detectAdapter({ platform: "linux", env: { DISPLAY: ":1" }, which });
    expect(d.adapter?.platform).toBe("linux");
    expect(d.missing).toEqual([]);
    const tools = await detectLinuxTools(which);
    expect(tools.tools?.screenshot).toEqual({ tool: "import", path: "/usr/bin/import" });
    const noDisplay = await detectAdapter({ platform: "linux", env: {}, which });
    expect(noDisplay.adapter).toBeNull();
    expect(noDisplay.displayServer).toBe("none");
    expect(noDisplay.missing[0]).toMatch(/DISPLAY/);
    const wayland = await detectAdapter({
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
      which,
    });
    expect(wayland.adapter?.platform).toBe("linux");
    expect(wayland.displayServer).toBe("wayland");
    expect(wayland.notes.join(" ")).toMatch(/XWayland/);
  });

  it("windows: needs powershell; other platforms are unsupported", async () => {
    const none = await detectAdapter({ platform: "windows", which: whichOf({}) });
    expect(none.adapter).toBeNull();
    expect(none.missing[0]).toMatch(/powershell/);
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const ok = await detectAdapter({ platform: "windows", which: whichOf({ powershell: ps }) });
    expect(ok.adapter?.platform).toBe("windows");
    expect(ok.found).toEqual({ powershell: ps });
    expect(ok.displayServer).toBe("win32");
    const mac = await detectAdapter({ platform: "macos", which: whichOf({}) });
    expect(mac.adapter).toBeNull();
    expect(mac.notes.join(" ")).toMatch(/Windows and Linux only/);
  });
});

describe("linux adapter", () => {
  it("builds argv arrays: the tool first, the model's text as one argument after --, never a shell", () => {
    const text = "-rf $(id) `whoami` ; echo";
    const all = [
      linuxArgv.listWindows(linuxTools.wmctrl),
      linuxArgv.activeWindow(linuxTools.xdotool),
      linuxArgv.activate(linuxTools.xdotool, "0x03a00003"),
      linuxArgv.type(linuxTools.xdotool, text, 12),
      linuxArgv.key(linuxTools.xdotool, "ctrl+shift+s"),
      linuxArgv.click(linuxTools.xdotool, 10, 20, "right"),
      linuxArgv.screenshot(linuxTools.screenshot, "/tmp/x.png", "0x03a00003"),
      linuxArgv.screenshot({ tool: "scrot", path: "/usr/bin/scrot" }, "/tmp/x.png", "0x1"),
      linuxArgv.screenshot(
        { tool: "gnome-screenshot", path: "/usr/bin/gnome-screenshot" },
        "/tmp/x.png",
      ),
    ];
    for (const argv of all) {
      expect(argv.length).toBeGreaterThan(1);
      expect(SHELLS.has(argv[0] ?? "")).toBe(false);
      expect(argv.some((a) => a.includes("-c") && a.length === 2)).toBe(false);
    }
    expect(linuxArgv.type(linuxTools.xdotool, text, 12)).toEqual([
      "/usr/bin/xdotool",
      "type",
      "--clearmodifiers",
      "--delay",
      "12",
      "--",
      text,
    ]);
    expect(linuxArgv.click(linuxTools.xdotool, 10, 20, "right")).toEqual([
      "/usr/bin/xdotool",
      "mousemove",
      "--sync",
      "10",
      "20",
      "click",
      "3",
    ]);
    expect(linuxArgv.screenshot(linuxTools.screenshot, "/tmp/x.png", "0x03a00003")).toEqual([
      "/usr/bin/import",
      "-window",
      "0x03a00003",
      "/tmp/x.png",
    ]);
    expect(linuxArgv.screenshot(linuxTools.screenshot, "/tmp/x.png")).toEqual([
      "/usr/bin/import",
      "-window",
      "root",
      "/tmp/x.png",
    ]);
  });

  it("parses wmctrl -l -p -x lines and maps xdotool decimal ids to wmctrl hex", () => {
    expect(
      parseWmctrlLine("0x03a00003  0 11     code.Code             host Visual Studio Code"),
    ).toEqual({
      id: "0x03a00003",
      pid: 11,
      windowClass: "code.Code",
      title: "Visual Studio Code",
    });
    expect(parseWmctrlLine("0x03C00004 -1 12 N/A host")).toEqual({
      id: "0x03c00004",
      pid: 12,
      windowClass: "",
      title: "",
    });
    expect(parseWmctrlLine("garbage")).toBeNull();
    expect(hexWindowId("60817411\n")).toBe("0x03a00003");
    expect(hexWindowId("0x1")).toBe("0x00000001");
  });

  it("runs the whole sequence through the injected runner with the expected argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-desktop-linux-"));
    const shot = join(dir, "s.png");
    try {
      const wmctrlOut =
        "0x03a00003  0 11     code.Code             host Visual Studio Code\n" +
        "0x03c00004  1 12     Navigator.firefox     host Bank login\n";
      const { calls, run } = recorder((argv) => {
        if (argv[1] === "-l") return { stdout: wmctrlOut };
        if (argv[1] === "getactivewindow") return { stdout: "60817411\n" };
        if (argv[0] === "/usr/bin/import") writeFileSync(argv[3] ?? shot, "png");
        return undefined;
      });
      const adapter = new LinuxDesktopAdapter({
        tools: linuxTools,
        run,
        readComm: async (pid) => (pid === 11 ? "code" : null),
      });
      const windows = await adapter.listWindows();
      expect(windows).toEqual([
        {
          id: "0x03a00003",
          pid: 11,
          windowClass: "code.Code",
          title: "Visual Studio Code",
          exe: "code",
        },
        {
          id: "0x03c00004",
          pid: 12,
          windowClass: "Navigator.firefox",
          title: "Bank login",
          exe: "navigator",
        },
      ]);
      const active = await adapter.activeWindow();
      expect(active?.id).toBe("0x03a00003");
      const focused = await adapter.focus("code");
      expect(focused.exe).toBe("code");
      await adapter.typeText("hello\r\nworld");
      await adapter.pressKey("ctrl+s");
      await adapter.click(10, 20, { button: "right" });
      const signal = new AbortController().signal;
      const r = await adapter.screenshot(shot, { window: focused, signal });
      expect(r).toEqual({ path: shot, bytes: 3 });
      const argvs = calls.map((c) => c.argv);
      expect(argvs).toContainEqual(["/usr/bin/xdotool", "windowactivate", "--sync", "0x03a00003"]);
      expect(argvs).toContainEqual([
        "/usr/bin/xdotool",
        "type",
        "--clearmodifiers",
        "--delay",
        "12",
        "--",
        "hello\nworld",
      ]);
      expect(argvs).toContainEqual(["/usr/bin/xdotool", "key", "--clearmodifiers", "--", "ctrl+s"]);
      expect(argvs).toContainEqual([
        "/usr/bin/xdotool",
        "mousemove",
        "--sync",
        "10",
        "20",
        "click",
        "3",
      ]);
      expect(argvs).toContainEqual(["/usr/bin/import", "-window", "0x03a00003", shot]);
      expect(calls.at(-1)?.opts?.signal).toBe(signal);
      for (const c of calls) expect(SHELLS.has(c.argv[0] ?? "")).toBe(false);
      await expect(adapter.focus("gimp")).rejects.toMatchObject({ code: "not_found" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad keys, control characters and out-of-range clicks before any process starts", async () => {
    const { calls, run } = recorder();
    const adapter = new LinuxDesktopAdapter({ tools: linuxTools, run });
    await expect(adapter.pressKey("ctrl+bogus")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.pressKey("hyper+a")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.typeText("a\u0000b")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.typeText("")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.click(-1, 0)).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.click(1.5, 0)).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(0);
    expect(parseKey("Ctrl+Shift+S")).toEqual({
      modifiers: ["ctrl", "shift"],
      key: "S",
      named: false,
    });
    expect(parseKey("enter")).toEqual({ modifiers: [], key: "Return", named: true });
    expect(parseKey("ctrl++")).toEqual({ modifiers: ["ctrl"], key: "+", named: false });
    expect(validateText("a\r\nb\tc")).toBe("a\nb\tc");
  });
});

describe("windows adapter", () => {
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  it("invokes powershell with -File <script in the temp dir> and arguments, never -Command or a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-desktop-win-"));
    try {
      const { calls, run } = recorder((argv) => {
        const script = argv[6] ?? "";
        if (script.endsWith("list-windows.ps1")) {
          return {
            stdout: JSON.stringify([
              {
                id: "1234",
                pid: 7,
                exe: "Code",
                windowClass: "Chrome_WidgetWin_1",
                title: "x",
                active: true,
              },
              {
                id: "99",
                pid: 8,
                exe: "notepad",
                windowClass: "Notepad",
                title: "Untitled",
                active: false,
              },
            ]),
          };
        }
        if (script.endsWith("screenshot.ps1")) {
          writeFileSync(Buffer.from(argv[7] ?? "", "base64").toString("utf8"), "png!");
        }
        return undefined;
      });
      const adapter = new WindowsDesktopAdapter({ powershell: ps, run, scriptDir: dir });
      const text = "evil $(Remove-Item x) -NoProfile `n";
      await adapter.typeText(text);
      const typed = calls[0];
      if (!typed) throw new Error("no call");
      expect(typed.argv.slice(0, 6)).toEqual([
        ps,
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
      ]);
      expect(typed.argv[6]).toBe(join(dir, "send-keys.ps1"));
      expect(typed.argv).toHaveLength(8);
      expect(Buffer.from(typed.argv[7] ?? "", "base64").toString("utf8")).toBe(
        escapeSendKeys(text),
      );
      expect(typed.argv[7]?.startsWith("-")).toBe(false);
      // The script on disk is the constant: no input was spliced into it.
      expect(readFileSync(join(dir, "send-keys.ps1"), "utf8")).toBe(
        `\uFEFF${WINDOWS_SCRIPTS["send-keys.ps1"]}`,
      );
      expect(WINDOWS_SCRIPTS["send-keys.ps1"]).not.toContain("evil");

      await adapter.pressKey("alt+F4");
      expect(Buffer.from(calls[1]?.argv[7] ?? "", "base64").toString("utf8")).toBe("%{F4}");
      await adapter.click(5, 6, { button: "middle" });
      expect(calls[2]?.argv.slice(6)).toEqual([join(dir, "click.ps1"), "5", "6", "middle"]);
      const windows = await adapter.listWindows();
      expect(windows).toEqual([
        { id: "1234", pid: 7, exe: "code", windowClass: "Chrome_WidgetWin_1", title: "x" },
        { id: "99", pid: 8, exe: "notepad", windowClass: "Notepad", title: "Untitled" },
      ]);
      expect((await adapter.activeWindow())?.id).toBe("1234");
      const w = await adapter.focus("notepad");
      expect(calls.at(-1)?.argv.slice(6)).toEqual([join(dir, "focus.ps1"), "8", "99"]);
      const shot = join(dir, "shot.png");
      const r = await adapter.screenshot(shot, { window: w });
      expect(r).toEqual({ path: shot, bytes: 4 });
      expect(calls.at(-1)?.argv.slice(6)).toEqual([
        join(dir, "screenshot.ps1"),
        base64Arg(shot),
        "99",
      ]);
      for (const c of calls) {
        expect(c.argv).not.toContain("-Command");
        expect(c.argv).not.toContain("-c");
        expect(SHELLS.has(c.argv[0] ?? "")).toBe(false);
      }
      await adapter.dispose();
      expect(existsSync(dir)).toBe(true); // a caller-owned scriptDir is left alone
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes SendKeys specials, maps named keys and modifiers, refuses the Windows key", () => {
    expect(escapeSendKeys("a+b (c)[d]{e}^%~\n\tz")).toBe(
      "a{+}b {(}c{)}{[}d{]}{{}e{}}{^}{%}{~}{ENTER}{TAB}z",
    );
    expect(toSendKeys(parseKey("ctrl+shift+s"))).toBe("^+s");
    expect(toSendKeys(parseKey("alt+F4"))).toBe("%{F4}");
    expect(toSendKeys(parseKey("Return"))).toBe("{ENTER}");
    expect(toSendKeys(parseKey("ctrl++"))).toBe("^{+}");
    expect(() => toSendKeys(parseKey("super+d"))).toThrow(/Windows key/);
    expect(parseWindowsList("")).toEqual([]);
    expect(parseWindowsList(JSON.stringify({ id: 5, exe: "x.exe", active: false }))).toEqual([
      { id: "5", pid: undefined, exe: "x", windowClass: "", title: "", active: false },
    ]);
    expect(() => parseWindowsList("not json")).toThrow(/JSON/);
    expect(windowsArgv("pwsh", "C:\\s.ps1", ["a"])).toEqual([
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\s.ps1",
      "a",
    ]);
  });

  it("creates its own script directory on first use and removes it on dispose", async () => {
    const { run } = recorder(() => ({ stdout: "[]" }));
    const adapter = new WindowsDesktopAdapter({ powershell: ps, run });
    await adapter.listWindows();
    const path = adapter.scriptPath("list-windows.ps1");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("GetForegroundWindow");
    await adapter.dispose();
    expect(existsSync(path)).toBe(false);
    const e = await adapter
      .pressKey("super+x")
      .then(() => null)
      .catch((err: unknown) => err);
    expect(isForerunnerError(e, "not_supported")).toBe(true);
    await adapter.dispose();
  });
});
