import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isForerunnerError } from "../src/errors.ts";
import { join } from "../src/paths.ts";
import {
  cmdArgv,
  escapeCmdArgument,
  escapeCmdCommand,
  resolveWindowsCommand,
  run,
} from "../src/shell.ts";

/**
 * U-068: `.cmd` and `.bat` files (npm, npx, pnpm and other shims) run through `cmd.exe /c`, and
 * cmd reads `&`, `|`, `%VAR%` and quotes in the arguments: an MCP server for `D:\R&D\app` ran
 * `app` as a second command. Each argument is quoted and its cmd metacharacters escaped with `^`
 * (as cross-spawn does), twice: once for cmd's parse of the /c line, once for the batch file's
 * own parse of the line its `%*` lands in.
 */

/** What arrives, in order: every one must come back exactly as sent. */
const AWKWARD = [
  "a&b",
  "a|b",
  "%PATH%",
  'x"y',
  'x"&calc',
  "plain",
  "with space",
  "",
  "a^b",
  "(x)",
  "!x!",
  "back\\",
  'back\\"q',
  "100%",
  "%",
  "<in>",
  "a,b;c=d",
  "D:\\R&D\\app",
  "Zoë's [x] {y}",
];

describe("cmd.exe escaping (U-068)", () => {
  it("quotes an argument with the C runtime's rules, then escapes cmd's metacharacters twice", () => {
    expect(escapeCmdArgument("a&b")).toBe('^^^"a^^^&b^^^"');
    expect(escapeCmdArgument("%PATH%")).toBe('^^^"^^^%PATH^^^%^^^"');
    // A quote becomes \" for the C runtime; the backslashes before it are doubled.
    expect(escapeCmdArgument('x"y')).toBe('^^^"x\\^^^"y^^^"');
    expect(escapeCmdArgument('a\\"b')).toBe('^^^"a\\\\\\^^^"b^^^"');
    // Trailing backslashes are doubled so they do not escape the closing quote.
    expect(escapeCmdArgument("back\\")).toBe('^^^"back\\\\^^^"');
    expect(escapeCmdArgument("")).toBe('^^^"^^^"');
    // Backslashes elsewhere stay as they are.
    expect(escapeCmdArgument("C:\\x\\y")).toBe('^^^"C:\\x\\y^^^"');
  });

  it("escapes the script's own path once, spaces included", () => {
    expect(escapeCmdCommand("D:\\R&D x\\echo.cmd")).toBe("D:\\R^&D^ x\\echo.cmd");
    expect(escapeCmdCommand("C:\\Program Files\\nodejs\\npx.cmd")).toBe(
      "C:\\Program^ Files\\nodejs\\npx.cmd",
    );
  });

  it("builds cmd's /d /s /c line, to be passed verbatim", () => {
    expect(cmdArgv("D:\\R&D\\x.cmd", ["a|b", "c"])).toEqual([
      "/d",
      "/s",
      "/c",
      '"D:\\R^&D\\x.cmd ^^^"a^^^|b^^^" ^^^"c^^^""',
    ]);
  });

  it("refuses an argument cmd cannot carry: a line break would end the command", () => {
    let caught: unknown = null;
    try {
      cmdArgv("x.cmd", ["first\nsecond"]);
    } catch (e) {
      caught = e;
    }
    expect(isForerunnerError(caught, "validation")).toBe(true);
  });

  it("runs batch files and the npm shims through cmd, and an .exe found first directly", () => {
    const env = { Path: "C:\\tools;C:\\node", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const files = new Set(["C:\\node\\npx.CMD", "C:\\tools\\pnpm.EXE", "C:\\node\\pnpm.CMD"]);
    const isFile = (p: string) => files.has(p);
    const resolve = (cmd: string) => resolveWindowsCommand(cmd, { env, cwd: "C:\\w", isFile });
    expect(resolve("npx")).toEqual({ file: "C:\\node\\npx.CMD", viaCmd: true });
    // A standalone pnpm.exe comes first on PATH: it gets its arguments directly, no carets.
    expect(resolve("pnpm")).toEqual({ file: "C:\\tools\\pnpm.EXE", viaCmd: false });
    expect(resolve("D:\\R&D\\run.bat")).toEqual({ file: "D:\\R&D\\run.bat", viaCmd: true });
    expect(resolve("git")).toEqual({ file: "git", viaCmd: false });
    // Not found: cmd reports it as before.
    expect(resolve("yarn")).toEqual({ file: "yarn", viaCmd: true });
  });

  it.runIf(process.platform === "win32")(
    "a real .cmd that hands its arguments to node gets every one unchanged",
    async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "fr-cmd-")), "R&D x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "echo-args.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      );
      // The way npm's shims hand over: node, the script next to the .cmd, then %*.
      writeFileSync(
        join(dir, "echo-args.cmd"),
        `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`,
      );
      const r = await run([join(dir, "echo-args.cmd"), ...AWKWARD], { timeoutMs: 60_000 });
      expect(JSON.parse(r.stdout)).toEqual(AWKWARD);
    },
  );

  it.runIf(process.platform !== "win32")(
    "passes the same arguments verbatim elsewhere",
    async () => {
      const r = await run([
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        ...AWKWARD,
      ]);
      expect(JSON.parse(r.stdout)).toEqual(AWKWARD);
    },
  );
});
