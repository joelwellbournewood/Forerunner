import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, Logger } from "@forerunner/platform";
import type { BrowserContext } from "playwright";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_UA_SUFFIX,
  BROWSER_EXECUTABLE_ENV,
  browserProfileDirs,
  DISABLE_FEATURES_ARG,
  FORERUNNER_DISABLED_FEATURES,
  HARDENING_ARGS,
  launchAgentBrowser,
  PLAYWRIGHT_DISABLED_FEATURES,
  resolveChromiumExecutable,
  sandboxRefusalOf,
} from "../src/browser/profile.ts";
import { navigationInterruptedRetry } from "../src/browser/session.ts";

describe("browser profile layout", () => {
  it("puts every agent under data/browser/<safe agent id>, never a shared or human profile", () => {
    const home = join(tmpdir(), "fr-profile-layout");
    const d = browserProfileDirs("Agent One/ß", { env: { FORERUNNER_HOME: home } });
    expect(d.root).toBe(join(home, "data", "browser", "Agent-One"));
    expect(d.profile).toBe(join(d.root, "profile"));
    expect(d.downloads).toBe(join(d.root, "downloads"));
    expect(d.screenshots).toBe(join(d.root, "screenshots"));
    const other = browserProfileDirs("agent-two", { env: { FORERUNNER_HOME: home } });
    expect(other.root).not.toBe(d.root);
  });

  it("identifies the browser as an AI agent", () => {
    expect(AI_AGENT_UA_SUFFIX).toMatch(/AI-Agent/);
  });

  it("resolves an explicit executable override and refuses a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-chromium-"));
    try {
      const fake = join(dir, "chrome");
      writeFileSync(fake, "");
      expect(resolveChromiumExecutable({ [BROWSER_EXECUTABLE_ENV]: fake })).toEqual({
        ok: true,
        executablePath: fake,
        reason: BROWSER_EXECUTABLE_ENV,
      });
      const missing = resolveChromiumExecutable({ [BROWSER_EXECUTABLE_ENV]: join(dir, "nope") });
      expect(missing.ok).toBe(false);
      expect(missing.reason).toContain(BROWSER_EXECUTABLE_ENV);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hardening flags", () => {
  it("disables features with exactly one flag that carries Playwright's list and ours", () => {
    const flags = HARDENING_ARGS.filter((a) => a.startsWith("--disable-features="));
    expect(flags).toEqual([DISABLE_FEATURES_ARG]);
    const features = DISABLE_FEATURES_ARG.slice("--disable-features=".length).split(",");
    for (const f of PLAYWRIGHT_DISABLED_FEATURES) expect(features).toContain(f);
    for (const f of FORERUNNER_DISABLED_FEATURES) expect(features).toContain(f);
    expect(features).toContain("LocalNetworkAccessChecks");
    expect(new Set(features).size).toBe(features.length);
  });

  it("blocks popups, permission prompts and the OS keychain", () => {
    expect(HARDENING_ARGS).toContain("--block-new-web-contents");
    expect(HARDENING_ARGS).toContain("--deny-permission-prompts");
    expect(HARDENING_ARGS).toContain("--password-store=basic");
  });

  // Chromium honours only the last --disable-features on the command line, so the copy in
  // profile.ts must match what the installed Playwright would have passed on its own.
  const installed = (() => {
    try {
      const requireFromHere = createRequire(import.meta.url);
      const playwright = requireFromHere.resolve("playwright/package.json");
      const requireFromPlaywright = createRequire(playwright);
      const core = requireFromPlaywright.resolve("playwright-core/package.json");
      const bundle = join(core.slice(0, -"package.json".length), "lib", "coreBundle.js");
      if (!existsSync(bundle)) return null;
      const src = readFileSync(bundle, "utf8");
      const m = /disabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(src);
      if (!m?.[1]) return null;
      const names = [...m[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1] ?? "");
      return names.length ? names : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(!installed)(
    installed
      ? "matches the disabled-feature list of the installed Playwright"
      : "skipped: the installed Playwright bundle could not be read for its disabled-feature list",
    () => {
      expect([...PLAYWRIGHT_DISABLED_FEATURES].sort()).toEqual([...(installed ?? [])].sort());
    },
  );
});

/**
 * W6-30 (the class of C-17): the agent browser starts Chromium with its own sandbox on
 * (Playwright's default turns it off), and only where it cannot start with it does it run
 * without, saying why. The launch seam replaces Playwright's `launchPersistentContext`.
 */
describe("the agent browser starts with Chromium's own sandbox (W6-30)", () => {
  function fakeContext() {
    const page = {
      evaluate: async () => "Mozilla/5.0 HeadlessChrome/141",
      close: async () => undefined,
    };
    return {
      newPage: async () => page,
      browser: () => ({ version: () => "141.0" }),
      close: async () => undefined,
      clearPermissions: async () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      setDefaultTimeout: () => undefined,
    } as unknown as BrowserContext;
  }

  it("asks for chromiumSandbox: true and keeps it when Chromium starts with it", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-browser-sbx-"));
    const seen: (boolean | undefined)[] = [];
    try {
      const launched = await launchAgentBrowser({
        agentId: "a1",
        executablePath: process.execPath,
        env: { FORERUNNER_HOME: home },
        launchContext: async (_dir, o) => {
          seen.push(o?.chromiumSandbox);
          return fakeContext();
        },
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => s === true)).toBe(true);
      expect(launched.unsandboxed).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back without it only where it cannot start, and says why", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-browser-sbx-"));
    const seen: (boolean | undefined)[] = [];
    try {
      const launched = await launchAgentBrowser({
        agentId: "a1",
        executablePath: process.execPath,
        env: { FORERUNNER_HOME: home },
        launchContext: async (_dir, o) => {
          seen.push(o?.chromiumSandbox);
          if (o?.chromiumSandbox)
            throw new Error(
              "browserType.launchPersistentContext: Target page closed\nRunning as root without --no-sandbox is not supported",
            );
          return fakeContext();
        },
      });
      // Tried with the sandbox once, then without it for this and every later launch.
      expect(seen[0]).toBe(true);
      expect(seen.slice(1).every((s) => s === false)).toBe(true);
      expect(launched.unsandboxed).toBe("Running as root without --no-sandbox is not supported");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // R-sandbox (W6-30): only a refusal that names the sandbox drops it. A first launch that fails
  // for another reason (a timeout, a profile another Chromium holds) is not retried without it.
  const notTheSandbox: [string, string][] = [
    [
      "a timeout",
      // Playwright's call log names the command line; the profile path here holds 'sandbox'.
      "browserType.launchPersistentContext: Timeout 60000ms exceeded.\nCall log:\n  - <launching> /usr/bin/chromium --disable-features=Translate --user-data-dir=/home/a/forerunner-sandbox/data/browser/a1/profile --remote-debugging-pipe about:blank\n  - <launched> pid=4242",
    ],
    [
      "a profile held by another Chromium",
      "browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n\n[pid=4242][err] [4242:4242:ERROR:process_singleton_posix.cc(358)] The profile appears to be in use by another Chromium process (4100) on another computer (pc).\n[pid=4242][err] [4242:4242:ERROR:chrome_browser_main.cc(1478)] Failed to create a ProcessSingleton for your profile directory.",
    ],
  ];
  for (const [what, message] of notTheSandbox) {
    it(`R-sandbox: ${what} is not retried without the sandbox and logs no unsandboxed line`, async () => {
      const home = mkdtempSync(join(tmpdir(), "fr-browser-sbx-"));
      const seen: (boolean | undefined)[] = [];
      const warned: string[] = [];
      const stop = Logger.addSink((r) => {
        if (r.level === "warn") warned.push(r.msg);
      });
      try {
        const launching = launchAgentBrowser({
          agentId: "a1",
          executablePath: process.execPath,
          env: { FORERUNNER_HOME: home },
          launchContext: async (_dir, o) => {
            seen.push(o?.chromiumSandbox);
            throw new Error(message);
          },
        });
        await expect(launching).rejects.toThrow(/browser could not be launched/);
        expect(seen).toEqual([true]);
        expect(warned.filter((w) => /sandbox/i.test(w))).toEqual([]);
      } finally {
        stop();
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("R-sandbox: Playwright's own 'Chromium sandboxing failed!' falls back and says why", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-browser-sbx-"));
    const seen: (boolean | undefined)[] = [];
    try {
      const launched = await launchAgentBrowser({
        agentId: "a1",
        executablePath: process.execPath,
        env: { FORERUNNER_HOME: home },
        launchContext: async (_dir, o) => {
          seen.push(o?.chromiumSandbox);
          if (o?.chromiumSandbox)
            throw new Error(
              "browserType.launchPersistentContext: Failed to launch the browser process.\nBrowser logs:\n\nChromium sandboxing failed!\n================================\nTo avoid the sandboxing issue, do either of the following:",
            );
          return fakeContext();
        },
      });
      expect(seen[0]).toBe(true);
      expect(seen.slice(1).every((s) => s === false)).toBe(true);
      expect(launched.unsandboxed).toBe("Chromium sandboxing failed!");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("R-sandbox: sandboxRefusalOf reads the browser's words, never the command line", () => {
    expect(sandboxRefusalOf(new Error(notTheSandbox[0]?.[1]))).toBeNull();
    expect(sandboxRefusalOf(new Error(notTheSandbox[1]?.[1]))).toBeNull();
    expect(
      sandboxRefusalOf(
        new Error(
          "browserType.launch: Target page closed\n[pid=9][err] [9:9:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel",
        ),
      ),
    ).toBe(
      "[pid=9][err] [9:9:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel",
    );
    expect(
      sandboxRefusalOf(
        new Error(
          "browserType.launch: Target page closed\n[pid=9][err] Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
        ),
      ),
    ).toMatch(/Failed to move to new namespace/);
  });

  // leftovers7-tailrun, wave 13 (TR-8): Playwright colours its call log where colour is forced
  // (it printed "\u001b[2m  - <launching> ..." on the bench), so the `<launching>` filter missed
  // the command line and a path holding a marker's words read as the browser's refusal.
  it("TR-8: a coloured call log's command line is never read as the browser's refusal; a coloured refusal is read, without its colour", () => {
    const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
    const commandLine =
      "  - <launching> /usr/bin/chromium --user-data-dir=/home/a/No usable sandbox/profile --remote-debugging-pipe about:blank";
    expect(
      sandboxRefusalOf(
        new Error(
          `browserType.launchPersistentContext: Timeout 60000ms exceeded.\nCall log:\n${dim(commandLine)}\n${dim("  - <launched> pid=4242")}`,
        ),
      ),
    ).toBeNull();
    // Each mark alone: the colour before the dash, between the dash and the tag, and 8-bit CSI.
    for (const line of [
      `\u001b[2m  - <launching> /tmp/setuid sandbox/chromium`,
      `  - \u001b[2m<launching>\u001b[22m /tmp/SUID sandbox/chromium`,
      `\u009b2m- <launching> /tmp/sandboxing failed/chromium`,
    ])
      expect(sandboxRefusalOf(new Error(`browserType.launch: Timeout\n${line}`))).toBeNull();
    // Playwright's own first line, coloured, is not the browser's words either.
    expect(
      sandboxRefusalOf(
        new Error(`\u001b[31mbrowserType.launch: No usable sandbox in path\u001b[39m`),
      ),
    ).toBeNull();
    // The browser's own refusal, coloured, is still read, and said without the escape codes.
    expect(
      sandboxRefusalOf(
        new Error(
          `browserType.launch: Target page closed\n\u001b[31m[pid=9][err] No usable sandbox! Update your kernel\u001b[39m`,
        ),
      ),
    ).toBe("[pid=9][err] No usable sandbox! Update your kernel");
  });
});

describe("a navigation interrupted by the same page is tried once more (R-9)", () => {
  it("retries after Chromium's error page and after a navigation to the same address, never another", () => {
    const url = "http://127.0.0.1:4321/chain";
    const interrupted = (to: string) =>
      `page.goto: Navigation to "${url}" is interrupted by another navigation to "${to}"`;
    expect(navigationInterruptedRetry(interrupted("chrome-error://chromewebdata/"), url)).toBe(
      true,
    );
    expect(navigationInterruptedRetry(interrupted(url), url)).toBe(true);
    expect(navigationInterruptedRetry(interrupted("http://127.0.0.1:4321/elsewhere"), url)).toBe(
      false,
    );
    expect(navigationInterruptedRetry("page.goto: net::ERR_ABORTED", url)).toBe(false);
  });
});
