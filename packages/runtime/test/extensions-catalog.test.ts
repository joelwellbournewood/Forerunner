import { describe, expect, it } from "vitest";
import {
  CATALOG_URL_ENV,
  catalogUrlFromEnv,
  ExtensionCatalog,
  fetchCatalog,
  fetchJson,
  loadBuiltinCatalog,
  parseCatalog,
  parseCatalogEntry,
} from "../src/extensions/catalog.ts";
import { fakeCatalogEntry, startHttpFixture } from "./extensions-helpers.ts";

describe("extension catalog", () => {
  it("ships a valid built-in catalog with the capabilities this repo provides", () => {
    const file = loadBuiltinCatalog();
    const ids = file.entries.map((e) => e.id);
    for (const id of [
      "browser",
      "email",
      "desktop-control",
      "cloudflare",
      "voice-local",
      "voice-deepgram",
      "voice-cartesia",
      "voice-elevenlabs",
      "anthropic",
      "mcp-filesystem",
      "mcp-fetch",
      "mcp-github",
    ]) {
      expect(ids).toContain(id);
    }
    const connectors = file.entries.filter((e) => e.kind === "connector");
    expect(connectors.length).toBeGreaterThanOrEqual(3);
    for (const c of connectors) expect(c.transport).toBeDefined();
    const github = file.entries.find((e) => e.id === "mcp-github");
    expect(github?.transport?.type).toBe("stdio");
    if (github?.transport?.type === "stdio") {
      expect(Object.values(github.transport.env)).toEqual(["secret:github_pat"]);
      expect(Array.isArray(github.transport.args)).toBe(true);
    }
    expect(file.entries.find((e) => e.id === "desktop-control")?.requiresAutonomy).toBe(3);
    // nothing hardcoded to an org, host or user path
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/\/home\/|C:\\\\Users|joel|wellbourne/i);
  });

  it("rejects duplicate ids, connectors without a transport and wildcard domains", () => {
    const good = fakeCatalogEntry();
    expect(() => parseCatalog({ version: 1, entries: [good, good] })).toThrow(/duplicate id/);
    expect(() => parseCatalogEntry({ ...good, transport: undefined })).toThrow(/needs a transport/);
    expect(() =>
      parseCatalogEntry({ ...good, permissions: { ...good.permissions, domains: ["*"] } }),
    ).toThrow(/invalid catalog entry/);
    expect(() =>
      parseCatalogEntry({ ...good, permissions: { ...good.permissions, tools: ["*"] } }),
    ).toThrow(/invalid catalog entry/);
    expect(() => parseCatalogEntry({ ...good, kind: "capability" })).toThrow(/only connectors/);
    expect(() =>
      parseCatalogEntry({ ...good, transport: { type: "http", url: "ftp://x" } }),
    ).toThrow();
  });

  it("merges a remote catalog over http without letting it override built-in ids", async () => {
    const remote = {
      version: 1,
      entries: [
        fakeCatalogEntry({ id: "remote-one", name: "remote-one" }),
        fakeCatalogEntry({ id: "browser", name: "evil-browser", kind: "connector" }),
      ],
    };
    const http = await startHttpFixture({ "/catalog.json": remote });
    try {
      const catalog = new ExtensionCatalog(loadBuiltinCatalog(), {
        remoteUrl: http.url("/catalog.json"),
      });
      expect(catalog.get("remote-one")).toBeUndefined();
      const r = await catalog.refresh();
      expect(r).toEqual({ remote: 1, skipped: ["browser"] });
      expect(catalog.get("remote-one")?.name).toBe("remote-one");
      expect(catalog.get("browser")?.name).toBe("browser");
      expect(catalog.entries().some((e) => e.id === "remote-one")).toBe(true);
      await expect(fetchCatalog(http.url("/missing.json"))).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(fetchJson("file:///etc/passwd")).rejects.toMatchObject({ code: "validation" });
    } finally {
      await http.close();
    }
  });

  it("reads the remote catalog URL from the environment only", () => {
    expect(catalogUrlFromEnv({})).toBeNull();
    expect(catalogUrlFromEnv({ [CATALOG_URL_ENV]: " https://catalog.example/x.json " })).toBe(
      "https://catalog.example/x.json",
    );
    expect(() => new ExtensionCatalog().mustGet("nope")).toThrow(/not found/);
  });
});
