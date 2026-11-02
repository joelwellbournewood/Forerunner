import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { errorMessage, join } from "@forerunner/platform";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { NO_BROWSER_SANDBOX, resolveChromiumExecutable, tryPages } from "../src/browser/index.ts";

/**
 * "Try it" in a real headless Chromium (ADR 0104): a page is opened from its folder as a person
 * would open it, the network off, and what a person meets is the evidence. Skipped with the
 * reason when this computer has no Chromium Playwright can drive (`playwright install` is never
 * run).
 */
async function probe(): Promise<{ ok: boolean; reason: string }> {
  const found = resolveChromiumExecutable();
  if (!found.ok) return { ok: false, reason: found.reason };
  try {
    const b = await chromium.launch({
      headless: true,
      ...(found.executablePath ? { executablePath: found.executablePath } : {}),
    });
    await b.close();
    return { ok: true, reason: found.reason };
  } catch (e) {
    return { ok: false, reason: errorMessage(e).split("\n")[0] ?? "launch failed" };
  }
}
const ready = await probe();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function folder(files: Record<string, string>): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "fr try page "));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, out: join(root, "..", `${root.split(/[\\/]/).pop()}-shots`) };
}

describe.skipIf(!ready.ok)(`tryPages in a real browser (${ready.reason})`, () => {
  it("a working page: its title, the text a person sees and a screenshot at each width", async () => {
    const { root, out } = folder({
      "index.html":
        '<!doctype html><html><head><title>Garden club</title><link rel="stylesheet" href="styles.css"></head><body><h1>Garden club</h1><p>Welcome, gardeners.</p><script src="script.js"></script></body></html>',
      "styles.css": "body { font-family: serif; }",
      "script.js": "document.querySelector('p').textContent += ' See you soon.';",
    });
    dirs.push(out);
    const r = await tryPages({ root, pages: ["index.html"], outDir: out, filePrefix: "k/" });
    if (!("tried" in r)) throw new Error(r.unavailable);
    const [t] = r.tried;
    expect(t).toMatchObject({ target: "index.html", ok: true, blocking: false });
    expect(t?.output).toContain("title: Garden club");
    expect(t?.output).toContain("Welcome, gardeners. See you soon.");
    expect(t?.screenshots.map((s) => s.file)).toEqual(["k/index-1280.png", "k/index-390.png"]);
    // What runs on the page (the review tells whose change an error belongs to from it).
    expect(t?.pageFiles).toEqual(["index.html", "styles.css", "script.js"]);
    expect(existsSync(join(out, "index-1280.png"))).toBe(true);
    expect(existsSync(join(out, "index-390.png"))).toBe(true);
  }, 60_000);

  it("a linked file that is missing is a problem, not a block; an error thrown by the page blocks", async () => {
    const { root, out } = folder({
      "index.html":
        '<!doctype html><html><head><title>Quotes</title><link rel="stylesheet" href="styles.css"></head><body><p id="q">…</p></body></html>',
      "broken.html":
        '<!doctype html><html><head><title>Broken</title></head><body><script>document.getElementById("nope").textContent = "x";</script></body></html>',
    });
    dirs.push(out);
    const r = await tryPages({ root, pages: ["index.html", "broken.html"], outDir: out });
    if (!("tried" in r)) throw new Error(r.unavailable);
    const [missing, broken] = r.tried;
    expect(missing).toMatchObject({ ok: false, blocking: false });
    expect(missing?.output).toContain("problem: styles.css did not load (not found)");
    // A file the page asked for counts whether it was found or not.
    expect(missing?.pageFiles).toEqual(["index.html", "styles.css"]);
    expect(broken).toMatchObject({ ok: false, blocking: true });
    expect(broken?.output).toMatch(/problem: error on the page: .*null/);
  }, 60_000);

  it("the network is off: a request to another site is blocked and said, and nothing outside the folder is served", async () => {
    const { root, out } = folder({
      "index.html":
        '<!doctype html><html><head><title>Fonts</title><link rel="stylesheet" href="https://fonts.example.test/css"></head><body><p>Hello</p><img src="../secret.png"></body></html>',
    });
    dirs.push(out);
    writeFileSync(join(root, "..", "secret.png"), "not served");
    const r = await tryPages({ root, pages: ["index.html"], outDir: out, widths: [1280] });
    if (!("tried" in r)) throw new Error(r.unavailable);
    const [t] = r.tried;
    expect(t?.output).toContain("blocked (the network is off during the try): fonts.example.test");
    // "../secret.png" resolves inside the served root (the URL is normalised), where it is absent.
    expect(t?.output).toContain("secret.png did not load (not found)");
    expect(t?.blocking).toBe(false);
  }, 60_000);

  it("a page that does not exist did not open: the try blocks", async () => {
    const { root, out } = folder({ "readme.md": "# nothing" });
    dirs.push(out);
    const r = await tryPages({ root, pages: ["index.html"], outDir: out, widths: [1280] });
    if (!("tried" in r)) throw new Error(r.unavailable);
    expect(r.tried[0]).toMatchObject({ ok: false, blocking: true });
    expect(r.tried[0]?.output).toContain("index.html did not open (status 404)");
    expect(r.tried[0]?.screenshots).toEqual([]);
  }, 60_000);

  it("Chromium's own sandbox is asked for: where it starts nothing is said, where it cannot the light review's try says so and a full review's page is not opened (C-17, ADR 0110)", async () => {
    const { root, out } = folder({ "index.html": "<title>Hi</title><p>Hi</p>" });
    dirs.push(out);
    const light = await tryPages({ root, pages: ["index.html"], outDir: out, widths: [1280] });
    if (!("tried" in light)) throw new Error(light.unavailable);
    const full = await tryPages({
      root,
      pages: ["index.html"],
      outDir: out,
      widths: [1280],
      requireBrowserSandbox: true,
    });
    const said = light.tried[0]?.output.includes(NO_BROWSER_SANDBOX) ?? false;
    if (said) {
      // This computer cannot start Chromium's sandbox (Linux as root, no user namespaces).
      expect(light.tried[0]?.output).toMatch(
        /the browser ran without its own sandbox: it could not start with it on this computer \(.+\)$/,
      );
      expect("unavailable" in full && full.unavailable).toMatch(
        /^the browser could not start with its own sandbox on this computer \(.+\), and a page of a full-review task is only opened with it$/,
      );
    } else {
      expect("tried" in full && full.tried[0]?.ok).toBe(true);
    }
  }, 60_000);
});
