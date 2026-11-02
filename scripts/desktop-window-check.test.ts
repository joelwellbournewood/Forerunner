import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_ORIGINS,
  DOCKER_DESKTOP_URL,
  desktopScreenshot,
  installStandIn,
  isAppUrl,
  parseArgs,
  parseHandoffs,
  REPO,
  sameFolder,
  seedPrUrl,
  startLinkServer,
  summaryMarkdown,
  WEBVIEW2_DISABLED_FEATURES,
  windowEnv,
  // @ts-expect-error plain JS module
} from "./desktop-window-check.mjs";

/**
 * The pure parts of the desktop window check (scripts/desktop-window-check.mjs, phase F2): the
 * app's environment, the stand-in model's copy into an installed runtime, the shell's log lines
 * it reads back, and the PR link it writes into the store. The check itself runs only on a
 * Windows runner with the installed MSI (desktop.yml, job "window").
 */
const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-window-check-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const shellSource = (file: string) =>
  readFileSync(join(REPO, "apps", "desktop", "src-tauri", "src", file), "utf8");

describe("the window check's job (desktop.yml)", () => {
  it("installs the MSI the build job uploads and runs this script on it", () => {
    const yml = readFileSync(join(REPO, ".github", "workflows", "desktop.yml"), "utf8");
    const job = yml.slice(yml.indexOf("\n  window:"));
    expect(job).toContain("needs: build");
    expect(job).toContain("runs-on: windows-latest");
    // The build job uploads `desktop-${{ matrix.os }}`; the window job downloads Windows's.
    expect(yml).toContain(["name: desktop-$", "{{ matrix.os }}"].join(""));
    expect(job).toContain("name: desktop-windows-latest");
    expect(job).toContain("node scripts/desktop-window-check.mjs --exe");
    // A change to the script or to the stand-in it copies runs the workflow.
    expect(yml).toContain('"scripts/desktop-window-check.*"');
    expect(yml).toContain('"testenv/src/bench/**"');
  });
});

describe("the window check's options", () => {
  it("needs the installed app or a page to attach to, a data folder and an output folder", () => {
    const o = parseArgs([
      "--exe",
      "C:\\Program Files\\Forerunner\\f.exe",
      "--home",
      "h",
      "--out",
      "o",
    ]);
    expect(o).toMatchObject({
      exe: "C:\\Program Files\\Forerunner\\f.exe",
      attach: null,
      home: "h",
      out: "o",
      cdpPort: 9333,
      timeoutMin: 20,
    });
    expect(parseArgs(["--attach", "http://127.0.0.1:9", "--home", "h", "--out", "o"]).attach).toBe(
      "http://127.0.0.1:9",
    );
    expect(() => parseArgs(["--home", "h", "--out", "o"])).toThrow(/either --exe/);
    expect(() => parseArgs(["--exe", "a", "--attach", "b", "--home", "h", "--out", "o"])).toThrow(
      /either --exe/,
    );
    expect(() => parseArgs(["--exe", "a", "--out", "o"])).toThrow(/--home/);
    expect(() => parseArgs(["--exe", "a", "--home", "h"])).toThrow(/--out/);
    expect(() => parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--cdp-port", "x"])).toThrow(
      /whole number/,
    );
    expect(() => parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--fast"])).toThrow(
      /unknown argument --fast/,
    );
  });
});

describe("the installed app's environment", () => {
  it("names the stand-in model, the DevTools port and a fresh data folder, and passes no credential", () => {
    const env = windowEnv(
      {
        PATH: "C:\\Windows",
        ANTHROPIC_API_KEY: "sk-ant-not-passed",
        GITHUB_TOKEN: "ghs_not_passed",
        FORERUNNER_HOME: "C:\\elsewhere",
        FORERUNNER_RUNNER_IMAGE: "x",
      },
      { home: "D:\\fr window\\Zürich home", cdpPort: 9444 },
    );
    expect(env).toEqual({
      PATH: "C:\\Windows",
      FORERUNNER_HOME: "D:\\fr window\\Zürich home",
      FORERUNNER_DAEMON_PROVIDER: "bench",
      FORERUNNER_VAULT_BACKEND: "file",
      FORERUNNER_SANDBOX_ENGINE: "podman",
      FORERUNNER_BENCH_DELAY_MS: "100",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=9444 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
    });
    // wry's own list (the variable may replace the app's arguments) plus occlusion tracking,
    // which could stop painting the window once the system browser covers it.
    expect(WEBVIEW2_DISABLED_FEATURES).toEqual([
      "msWebOOUI",
      "msPdfOOUI",
      "msSmartScreenProtection",
      "CalculateNativeWinOcclusion",
    ]);
  });

  it("uses the variable and the provider name the shell forwards (supervisor.rs)", () => {
    const rust = shellSource("supervisor.rs");
    expect(rust).toContain('pub const DAEMON_PROVIDER_ENV: &str = "FORERUNNER_DAEMON_PROVIDER";');
    expect(rust).toMatch(/pub const DAEMON_PROVIDERS: \[&str; \d\] = \[[^\]]*"bench"/);
  });
});

describe("the stand-in model in an installed runtime", () => {
  it("lands where `fr daemon --provider bench` looks for it", () => {
    const runtime = tempDir();
    const cli = join(runtime, "packages", "runtime", "src", "cli", "main.ts");
    mkdirSync(join(runtime, "packages", "runtime", "src", "cli"), { recursive: true });
    writeFileSync(cli, "// the installed CLI\n");
    const copied = installStandIn(REPO, runtime);
    expect(copied).toEqual([
      join("testenv", "package.json"),
      join("testenv", "src", "bench"),
      join("testenv", "src", "provider"),
    ]);
    // main.ts's BENCH_ENTRY, resolved from the installed CLI's own place.
    const main = readFileSync(join(REPO, "packages", "runtime", "src", "cli", "main.ts"), "utf8");
    const rel = /const BENCH_ENTRY = new URL\("([^"]+)", import\.meta\.url\)/.exec(main)?.[1];
    expect(rel).toBeTruthy();
    const entry = fileURLToPath(new URL(rel as string, pathToFileURL(cli)));
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(join(runtime, "testenv", "src", "provider", "fake-provider.ts"))).toBe(true);
    expect(JSON.parse(readFileSync(join(runtime, "testenv", "package.json"), "utf8")).type).toBe(
      "module",
    );
  });

  it("refuses a folder that is no installed runtime", () => {
    expect(() => installStandIn(REPO, tempDir())).toThrow(/is not an installed runtime/);
  });
});

describe("the shell's hand-offs in its log", () => {
  it("reads the lines the shell writes (tauri-plugin-log format, CRLF on Windows)", () => {
    const log = [
      "[2026-11-02][08:01:02][forerunner_desktop_lib::actions][INFO] the daemon is up at http://127.0.0.1:50000 (version 1.0.4)",
      "[2026-11-02][08:03:04][forerunner_desktop_lib::windows][INFO] handed to the system browser (link): http://127.0.0.1:4100/acme/window-check/pull/1",
      "[2026-11-02][08:03:09][forerunner_desktop_lib::windows][INFO] handed to the system browser (new window): https://example.org/a%20b (query not logged)",
      "[2026-11-02][08:03:12][forerunner_desktop_lib::windows][WARN] opening file from the window refused (link)",
      "[2026-11-02][08:03:20][forerunner_desktop_lib::folder][INFO] handed to the file manager: C:\\Users\\runneradmin\\fr window\\Zürich home\\data\\projects\\p1\\workspace",
      "[2026-11-02][08:03:30][forerunner_desktop_lib::windows][WARN] could not open https://example.org/x in the browser: no handler",
    ].join("\r\n");
    expect(parseHandoffs(log)).toEqual([
      {
        kind: "browser",
        via: "link",
        target: "http://127.0.0.1:4100/acme/window-check/pull/1",
      },
      { kind: "browser", via: "new window", target: "https://example.org/a%20b" },
      { kind: "refused", scheme: "file", via: "link" },
      {
        kind: "folder",
        target: "C:\\Users\\runneradmin\\fr window\\Zürich home\\data\\projects\\p1\\workspace",
      },
    ]);
    expect(parseHandoffs("")).toEqual([]);
  });

  it("reads the words the shell writes (windows.rs and folder.rs)", () => {
    expect(shellSource("windows.rs")).toContain(
      'pub const HANDED_TO_BROWSER: &str = "handed to the system browser";',
    );
    expect(shellSource("windows.rs")).toContain('"opening {} from the window refused ({})"');
    expect(shellSource("folder.rs")).toContain(
      'pub const HANDED_TO_FILE_MANAGER: &str = "handed to the file manager";',
    );
    // The exact line the shell's own test pins (windows.rs, a_hand_off_to_the_browser_is_logged...).
    expect(
      parseHandoffs("handed to the system browser (link): http://127.0.0.1:4100/acme/site/pull/1"),
    ).toEqual([{ kind: "browser", via: "link", target: "http://127.0.0.1:4100/acme/site/pull/1" }]);
  });

  it("knows the app's own pages and compares folders as Windows does", () => {
    expect(isAppUrl("http://tauri.localhost/projects/p1/tasks")).toBe(true);
    expect(isAppUrl("tauri://localhost")).toBe(true);
    expect(isAppUrl("http://tauri.localhost.evil.example/")).toBe(false);
    expect(isAppUrl("http://127.0.0.1:4100/acme/window-check/pull/1")).toBe(false);
    expect(isAppUrl("http://127.0.0.1:1871/inbox", ["http://127.0.0.1:1871"])).toBe(true);
    expect(APP_ORIGINS).toContain("http://tauri.localhost");
    expect(sameFolder("C:\\Users\\A\\Work\\", "c:/users/a/work", true)).toBe(true);
    expect(sameFolder("C:\\Users\\A\\Work", "C:\\Users\\A\\Other", true)).toBe(false);
    expect(sameFolder("/home/a/Work/", "/home/a/Work", false)).toBe(true);
    expect(sameFolder("/home/a/Work", "/home/a/work", false)).toBe(false);
    expect(sameFolder("", "", true)).toBe(false);
  });

  it("clicks the Docker link the Settings card shows (readiness-types.ts)", () => {
    const words = readFileSync(
      join(REPO, "packages", "runtime", "src", "sandbox", "readiness-types.ts"),
      "utf8",
    );
    expect(words).toContain(`export const DOCKER_DESKTOP_URL = "${DOCKER_DESKTOP_URL}";`);
  });
});

describe("the PR link written into the store", () => {
  it("sets the task's pr_url, bumps its version and refuses a task that is not there", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(tempDir(), "state.sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE "task" ("id" TEXT PRIMARY KEY, "updated_at" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "pr_url" TEXT)',
    );
    db.prepare('INSERT INTO "task" ("id", "updated_at") VALUES (?, ?)').run(
      "t1",
      "2026-11-01T00:00:00Z",
    );
    db.close();
    await seedPrUrl(
      file,
      "t1",
      "http://127.0.0.1:4100/acme/window-check/pull/1",
      "2026-11-02T08:00:00Z",
    );
    const check = new DatabaseSync(file);
    expect(
      check
        .prepare('SELECT "pr_url", "updated_at", "version" FROM "task" WHERE "id" = ?')
        .get("t1"),
    ).toEqual({
      pr_url: "http://127.0.0.1:4100/acme/window-check/pull/1",
      updated_at: "2026-11-02T08:00:00Z",
      version: 2,
    });
    check.close();
    await expect(seedPrUrl(file, "nope", "http://x", "2026-11-02T08:00:00Z")).rejects.toThrow(
      /no task nope/,
    );
  });

  it("writes the column the Tasks tab's PR link reads (task.pr_url)", () => {
    const schema = readFileSync(join(REPO, "packages", "state", "src", "schema.ts"), "utf8");
    expect(schema).toContain('text("pr_url"');
    const views = readFileSync(
      join(REPO, "packages", "runtime", "src", "daemon", "views.ts"),
      "utf8",
    );
    expect(views).toContain("prUrl: t.pr_url");
  });
});

describe("the page the system browser opens", () => {
  it("records every request on 127.0.0.1", async () => {
    const link = await startLinkServer();
    try {
      expect(link.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${link.base}/acme/window-check/pull/1`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("The system browser opened this page.");
      expect(link.hits.map((h: { path: string }) => h.path)).toEqual(["/acme/window-check/pull/1"]);
    } finally {
      await link.close();
    }
  });
});

describe("the screen where the journey stopped (Windows runner)", () => {
  type Call = { cmd: string; args: string[]; opts: { env: Record<string, string> } };
  it("is copied by Windows PowerShell into the file the check names, the path never in the script", () => {
    const dir = join(tempDir(), "fr window");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "99-stopped-desktop.png");
    const calls: Call[] = [];
    const run = (cmd: string, args: string[], opts: Call["opts"]) => {
      calls.push({ cmd, args, opts });
      writeFileSync(opts.env.FR_SHOT as string, "png");
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(desktopScreenshot(file, { platform: "win32", run })).toBe(`desktop screenshot: ${file}`);
    expect(calls).toHaveLength(1);
    const [c] = calls as [Call];
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(c.args[3]).toContain("CopyFromScreen");
    expect(c.args[3]).toContain("$env:FR_SHOT");
    expect(c.args[3]).not.toContain(file);
    expect(c.opts.env.FR_SHOT).toBe(file);
  });

  it("says why there is none: not Windows, or PowerShell's own words", () => {
    const calls: unknown[] = [];
    const never = (...a: unknown[]) => {
      calls.push(a);
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(desktopScreenshot(join(tempDir(), "a.png"), { platform: "linux", run: never })).toBe(
      "no desktop screenshot (not Windows)",
    );
    expect(calls).toEqual([]);
    const refused = () => ({ status: 1, stdout: "", stderr: "Add-Type : no desktop\r\n" });
    expect(desktopScreenshot(join(tempDir(), "b.png"), { platform: "win32", run: refused })).toBe(
      "desktop screenshot failed: Add-Type : no desktop",
    );
    // A zero exit that left no file is no screenshot either.
    const empty = () => ({ status: 0, stdout: "", stderr: "" });
    expect(desktopScreenshot(join(tempDir(), "c.png"), { platform: "win32", run: empty })).toBe(
      "desktop screenshot failed: exit 0",
    );
  });
});

describe("the step summary", () => {
  it("says which required checks failed and marks skipped checks and notes", () => {
    const md = summaryMarkdown("Window", [
      { name: "a", ok: true },
      { name: "b", ok: false, detail: "no line" },
      { name: "c", ok: false, skipped: true, detail: "no shell" },
      { name: "d", ok: false, required: false, detail: "not fetched" },
    ]);
    expect(md).toContain("**1 required check(s) failed.**");
    expect(md).toContain("- ok: a");
    expect(md).toContain("- FAILED: b (no line)");
    expect(md).toContain("- skipped: c (no shell)");
    expect(md).toContain("- note: d (not fetched)");
    expect(summaryMarkdown("W", [{ name: "a", ok: true }])).toContain(
      "Every required check passed.",
    );
  });
});
