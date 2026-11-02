import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import type { Browser, LaunchOptions } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { tryPages } from "../src/browser/try-page.ts";

/**
 * How the page try starts its browser (C-17, R-1; ADR 0110), without a real Chromium: a launcher
 * that records its options and a browser stand-in that opens every page. Chromium's own sandbox
 * is asked for first; where it cannot start (Linux as root, no user namespaces) a light-review
 * page is opened without it and the evidence says so, a full-review page is not opened at all.
 * The browser is closed on every path, also when the folder cannot be served.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function folder(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "fr try launch "));
  dirs.push(root);
  return { root, out: join(root, "shots") };
}

/** A browser stand-in: every page opens with status 200, title "Garden club", text "Hello". */
function fakeBrowser(): Browser & { closed: number } {
  const page = {
    on: () => undefined,
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => undefined,
    title: async () => "Garden club",
    evaluate: async () => "Hello",
    screenshot: async () => Buffer.from(""),
  };
  const context = {
    route: async () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  };
  const browser = {
    closed: 0,
    newContext: async () => context,
    close: async () => {
      browser.closed++;
    },
  };
  return browser as unknown as Browser & { closed: number };
}

/** A launcher that refuses Chromium's sandbox the way Linux as root does, and records each call. */
function launcher(opts: { sandboxWorks: boolean; browser?: Browser }) {
  const calls: LaunchOptions[] = [];
  const browser = opts.browser ?? fakeBrowser();
  return {
    calls,
    browser,
    launch: async (o: LaunchOptions) => {
      calls.push(o);
      if (o.chromiumSandbox && !opts.sandboxWorks)
        throw new Error(
          "browserType.launch: Target page, context or browser has been closed\nRunning as root without --no-sandbox is not supported.",
        );
      return browser;
    },
  };
}

describe("the page try's browser (C-17, R-1)", () => {
  it("starts Chromium with its own sandbox on; nothing about a fallback is said when it starts", async () => {
    const { root, out } = folder();
    const l = launcher({ sandboxWorks: true });
    const r = await tryPages({
      root,
      pages: ["index.html"],
      outDir: out,
      widths: [1280],
      launch: l.launch,
      serve: async () => ({ server: { close: (cb) => cb?.() }, origin: "http://127.0.0.1:1" }),
      env: { FORERUNNER_BROWSER_EXECUTABLE: process.execPath },
    });
    expect(l.calls.map((c) => c.chromiumSandbox)).toEqual([true]);
    if (!("tried" in r)) throw new Error(r.unavailable);
    expect(r.tried[0]?.output).not.toMatch(/sandbox/);
    expect((l.browser as Browser & { closed: number }).closed).toBe(1);
  });

  it("where the sandbox cannot start, a light review's page is opened without it and the evidence says so", async () => {
    const { root, out } = folder();
    const l = launcher({ sandboxWorks: false });
    const r = await tryPages({
      root,
      pages: ["index.html"],
      outDir: out,
      widths: [1280],
      launch: l.launch,
      serve: async () => ({ server: { close: (cb) => cb?.() }, origin: "http://127.0.0.1:1" }),
      env: { FORERUNNER_BROWSER_EXECUTABLE: process.execPath },
    });
    expect(l.calls.map((c) => c.chromiumSandbox)).toEqual([true, false]);
    if (!("tried" in r)) throw new Error(r.unavailable);
    expect(r.tried[0]?.ok).toBe(true);
    expect(r.tried[0]?.output).toContain(
      "the browser ran without its own sandbox: it could not start with it on this computer (Running as root without --no-sandbox is not supported.)",
    );
  });

  it("a full review's page is never opened without the browser's sandbox: not tried, and why", async () => {
    const { root, out } = folder();
    const l = launcher({ sandboxWorks: false });
    const r = await tryPages({
      root,
      pages: ["index.html"],
      outDir: out,
      launch: l.launch,
      requireBrowserSandbox: true,
      env: { FORERUNNER_BROWSER_EXECUTABLE: process.execPath },
    });
    expect(l.calls.map((c) => c.chromiumSandbox)).toEqual([true]);
    expect(r).toEqual({
      unavailable:
        "the browser could not start with its own sandbox on this computer (Running as root without --no-sandbox is not supported.), and a page of a full-review task is only opened with it",
    });
  });

  it("R-1: a folder that cannot be served leaves no browser running", async () => {
    const { root, out } = folder();
    const l = launcher({ sandboxWorks: true });
    const r = await tryPages({
      root,
      pages: ["index.html"],
      outDir: out,
      launch: l.launch,
      serve: async () => {
        throw new Error("listen EADDRINUSE: address already in use 127.0.0.1");
      },
      env: { FORERUNNER_BROWSER_EXECUTABLE: process.execPath },
    });
    expect((l.browser as Browser & { closed: number }).closed).toBe(1);
    expect(r).toEqual({
      unavailable:
        "the task's folder could not be served to the browser (listen EADDRINUSE: address already in use 127.0.0.1)",
    });
  });

  it("R-1: a screenshot folder that cannot be made leaves no browser running", async () => {
    const { root } = folder();
    const l = launcher({ sandboxWorks: true });
    let closedServer = 0;
    const r = await tryPages({
      root,
      pages: ["index.html"],
      // A file where the folder should be: mkdir fails.
      outDir: join(process.execPath, "shots"),
      launch: l.launch,
      serve: async () => ({
        server: {
          close: (cb) => {
            closedServer++;
            cb?.();
          },
        },
        origin: "http://127.0.0.1:1",
      }),
      env: { FORERUNNER_BROWSER_EXECUTABLE: process.execPath },
    });
    expect((l.browser as Browser & { closed: number }).closed).toBe(1);
    expect(closedServer).toBe(1);
    expect("unavailable" in r && r.unavailable).toMatch(/^the screenshots could not be stored \(/);
  });
});
