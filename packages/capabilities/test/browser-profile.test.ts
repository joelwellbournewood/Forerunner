import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_UA_SUFFIX,
  BROWSER_EXECUTABLE_ENV,
  browserProfileDirs,
  DISABLE_FEATURES_ARG,
  FORERUNNER_DISABLED_FEATURES,
  HARDENING_ARGS,
  PLAYWRIGHT_DISABLED_FEATURES,
  resolveChromiumExecutable,
} from "../src/browser/profile.ts";

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
