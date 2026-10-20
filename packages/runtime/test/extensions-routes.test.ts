import { afterEach, describe, expect, it } from "vitest";
import { createExtensionsRoutes, ExtensionView } from "../src/extensions/index.ts";
import {
  FAKE_CATALOG_ID,
  fakeCatalogEntry,
  type RegistryHarness,
  registryHarness,
  startHttpFixture,
} from "./extensions-helpers.ts";

describe("extensions routes", () => {
  let h: RegistryHarness;
  afterEach(async () => {
    h.stopLogs();
    await h.registry.close();
    await h.store.close();
  });

  type Loose = Record<string, unknown> & {
    id?: string;
    status?: string;
    name?: string;
    code?: string;
    ok?: boolean;
    source?: string | null;
    remoteUrl?: string | null;
    entries?: { id: string }[];
    permissions?: { tools: string[] };
  };
  const read = async (r: Response): Promise<Loose> => (await r.json()) as Loose;
  const readList = async (r: Response): Promise<Loose[]> => (await r.json()) as Loose[];

  function app() {
    return createExtensionsRoutes({ registry: h.registry, actor: () => ({ humanId: "h-1" }) });
  }
  const json = (method: string, path: string, body?: unknown) =>
    new Request(`http://local${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("lists the catalog and the installed extensions", async () => {
    h = await registryHarness({ approval: "approved" });
    const a = app();
    const catalog = await read(await a.fetch(json("GET", "/extensions/catalog")));
    expect(catalog.remoteUrl).toBeNull();
    expect(catalog.entries?.some((e) => e.id === "browser")).toBe(true);
    expect(await readList(await a.fetch(json("GET", "/extensions")))).toEqual([]);
    const created = await a.fetch(json("POST", "/extensions", { catalogId: FAKE_CATALOG_ID }));
    expect(created.status).toBe(201);
    const view = ExtensionView.parse(await created.json());
    expect(view.status).toBe("enabled");
    const list = await readList(await a.fetch(json("GET", "/extensions?kind=connector")));
    expect(list).toHaveLength(1);
    expect(await readList(await a.fetch(json("GET", "/extensions?kind=skill")))).toEqual([]);
    expect((await a.fetch(json("GET", "/extensions?kind=bogus"))).status).toBe(400);
    const one = await a.fetch(json("GET", `/extensions/${view.id}`));
    expect(one.status).toBe(200);
    expect((await read(one)).name).toBe("fake");
    expect((await a.fetch(json("GET", "/extensions/nope"))).status).toBe(404);
  });

  it("install needs approval: 202 while pending, approve and deny routes answer it", async () => {
    h = await registryHarness({ approval: "pending" });
    const a = app();
    const res = await a.fetch(json("POST", "/extensions", { catalogId: FAKE_CATALOG_ID }));
    expect(res.status).toBe(202);
    const view = ExtensionView.parse(await res.json());
    expect(view.status).toBe("pending_approval");
    const toggle = await a.fetch(json("POST", `/extensions/${view.id}/toggle`, { enabled: true }));
    expect(toggle.status).toBe(403);
    expect((await read(toggle)).code).toBe("approval_required");
    const approved = await a.fetch(json("POST", `/extensions/${view.id}/approve`));
    expect(approved.status).toBe(200);
    expect((await read(approved)).status).toBe("enabled");
    expect((await a.fetch(json("POST", `/extensions/${view.id}/approve`))).status).toBe(400);
    const second = await a.fetch(json("POST", "/extensions", { url: "ftp://127.0.0.1/x" }));
    expect(second.status).toBe(400);
    const bad = await a.fetch(json("POST", "/extensions", { nope: 1 }));
    expect(bad.status).toBe(400);
    const notJson = await a.fetch(
      new Request("http://local/extensions", { method: "POST", body: "x" }),
    );
    expect(notJson.status).toBe(400);
  });

  it("toggle, permissions and delete change the row and are audited", async () => {
    h = await registryHarness({ approval: "approved" });
    const a = app();
    const view = ExtensionView.parse(
      await (await a.fetch(json("POST", "/extensions", { catalogId: FAKE_CATALOG_ID }))).json(),
    );
    const off = await a.fetch(json("POST", `/extensions/${view.id}/toggle`, { enabled: false }));
    expect((await read(off)).status).toBe("disabled");
    const narrowed = await a.fetch(
      json("PUT", `/extensions/${view.id}/permissions`, {
        permissions: { tools: ["fake.fetch_page"] },
      }),
    );
    expect(narrowed.status).toBe(200);
    expect((await read(narrowed)).permissions?.tools).toEqual(["fake.fetch_page"]);
    h.approvals.setMode("pending");
    const widened = await a.fetch(
      json("PUT", `/extensions/${view.id}/permissions`, {
        permissions: { domains: ["example.com", "other.example"] },
      }),
    );
    expect(widened.status).toBe(202);
    expect((await read(widened)).status).toBe("pending_approval");
    const denied = await a.fetch(json("POST", `/extensions/${view.id}/deny`));
    expect((await read(denied)).ok).toBe(true);
    expect((await read(await a.fetch(json("GET", `/extensions/${view.id}`)))).status).toBe(
      "disabled",
    );
    const invalid = await a.fetch(
      json("PUT", `/extensions/${view.id}/permissions`, { permissions: { domains: ["*"] } }),
    );
    expect(invalid.status).toBe(400);
    const del = await a.fetch(json("DELETE", `/extensions/${view.id}`));
    expect(del.status).toBe(200);
    expect((await a.fetch(json("GET", `/extensions/${view.id}`))).status).toBe(404);
    const ops = (await h.store.auditLog.list()).map((r) => r.tool);
    expect(ops).toEqual([
      "extensions.add",
      "extensions.approve",
      "extensions.disable",
      "extensions.update_permissions",
      "extensions.update_permissions",
      "extensions.deny",
      "extensions.remove",
    ]);
    for (const r of await h.store.auditLog.list()) expect(r.human_id).toBe("h-1");
  });

  it("adds from a URL that serves a manifest", async () => {
    const http = await startHttpFixture({
      "/m.json": fakeCatalogEntry({ id: "via-url", name: "via-url" }),
    });
    try {
      h = await registryHarness({ approval: "approved" });
      const a = app();
      const res = await a.fetch(json("POST", "/extensions", { url: http.url("/m.json") }));
      expect(res.status).toBe(201);
      const view = ExtensionView.parse(await res.json());
      expect(view.name).toBe("via-url");
      expect(view.source).toBe(http.url("/m.json"));
    } finally {
      await http.close();
    }
  });

  it("approve answers 202 after a discovery yes (the grant is still open) and 200 once granted", async () => {
    const http = await startHttpFixture({
      "/m.json": fakeCatalogEntry({ id: "two-step", name: "two-step" }),
    });
    try {
      h = await registryHarness({ approval: "pending" });
      const a = app();
      const res = await a.fetch(json("POST", "/extensions", { url: http.url("/m.json") }));
      expect(res.status).toBe(202);
      const view = ExtensionView.parse(await res.json());
      expect(view.pendingStage).toBe("discovery");
      expect(h.seen).toEqual([]);
      const discovery = await a.fetch(json("POST", `/extensions/${view.id}/approve`));
      expect(discovery.status).toBe(202);
      const discovered = ExtensionView.parse(await discovery.json());
      expect(discovered.status).toBe("pending_approval");
      expect(discovered.pendingStage).toBe("grant");
      expect(discovered.permissions.tools).toEqual([
        "two-step.fetch_page",
        "two-step.post_comment",
      ]);
      const grant = await a.fetch(json("POST", `/extensions/${view.id}/approve`));
      expect(grant.status).toBe(200);
      expect(ExtensionView.parse(await grant.json()).status).toBe("enabled");
      const ops = (await h.store.auditLog.list()).map((r) => r.tool);
      expect(ops).toEqual([
        "extensions.add",
        "extensions.approve_discovery",
        "extensions.discovered",
        "extensions.approve",
      ]);
    } finally {
      await http.close();
    }
  });
});
