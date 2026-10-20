import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isInside, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { createDataRoutes, DATA_ROUTES } from "../src/data/routes.ts";
import { DataAssetView, ImportResultView } from "../src/data/types.ts";
import { csvText, type DataHarness, dataHarness, makeZip, writeFixture } from "./data-helpers.ts";

type Loose = Record<string, unknown> & { id?: string; code?: string; ok?: boolean; name?: string };

describe("data routes", () => {
  let h: DataHarness;
  afterEach(async () => {
    await h?.close();
  });

  function app(actor: { humanId?: string } = { humanId: "h-1" }, worktree?: string) {
    return createDataRoutes({
      assets: h.assets,
      importer: h.importer,
      actor: () => actor,
      worktreeFor: () => worktree,
    });
  }
  const json = (method: string, path: string, body?: unknown) =>
    new Request(`http://local${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = async (r: Response): Promise<Loose> => (await r.json()) as Loose;

  it("lists, registers (JSON), describes, samples and removes; errors carry codes", async () => {
    h = await dataHarness();
    const a = app();
    expect(DATA_ROUTES).toContain("DELETE /data/:id");
    const empty = await a.fetch(json("GET", `/projects/${h.projectId}/data`));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    const p = writeFixture(join(h.src, "items.csv"), csvText(6));
    const created = await a.fetch(
      json("POST", `/projects/${h.projectId}/data`, { locator: p, kind: "csv" }),
    );
    expect(created.status).toBe(201);
    const view = DataAssetView.parse(await created.json());
    expect(view.kind).toBe("file");
    expect(view.format).toBe("csv");
    expect(view.projectIds).toEqual([h.projectId]);
    expect(view.registeredBy).toBe("h-1");
    const list = (await (
      await a.fetch(json("GET", `/projects/${h.projectId}/data`))
    ).json()) as unknown[];
    expect(list).toHaveLength(1);
    const one = await a.fetch(json("GET", `/data/${view.id}`));
    expect(one.status).toBe(200);
    expect(DataAssetView.parse(await one.json()).id).toBe(view.id);
    const sample = await a.fetch(json("GET", `/data/${view.id}/sample?rows=2`));
    expect(sample.status).toBe(200);
    expect(((await sample.json()) as { rows: unknown[] }).rows).toHaveLength(2);
    expect((await a.fetch(json("GET", `/data/${view.id}/sample?rows=zero`))).status).toBe(400);
    expect((await a.fetch(json("GET", "/data/nope"))).status).toBe(404);
    const bad = await a.fetch(json("POST", `/projects/${h.projectId}/data`, { nope: 1 }));
    expect(bad.status).toBe(400);
    expect((await read(bad)).code).toBe("validation");
    expect(
      (
        await a.fetch(
          json("POST", `/projects/${h.projectId}/data`, { locator: join(h.src, "missing.csv") }),
        )
      ).status,
    ).toBe(404);
    expect((await a.fetch(json("POST", "/projects/nope/data", { locator: p }))).status).toBe(404);
    expect(
      (await a.fetch(json("POST", `/projects/${h.projectId}/data`, { locator: "ftp://x/y" })))
        .status,
    ).toBe(400);
    const remote = await a.fetch(
      json("POST", `/projects/${h.projectId}/data`, {
        locator: "r2://bucket/big.parquet",
        kind: "dataset",
        sizeBytes: 5,
      }),
    );
    expect(remote.status).toBe(201);
    expect(DataAssetView.parse(await remote.json()).storage).toBe("remote");
    const del = await a.fetch(json("DELETE", `/data/${view.id}`));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, id: view.id, deletedFromDisk: false });
    expect((await a.fetch(json("DELETE", `/data/${view.id}`))).status).toBe(404);
    const noHuman = app({});
    const refused = await noHuman.fetch(
      json(
        "DELETE",
        `/data/${DataAssetView.parse(await (await a.fetch(json("GET", `/projects/${h.projectId}/data`))).json().then((l) => (l as unknown[])[0])).id}`,
      ),
    );
    expect(refused.status).toBe(403);
    expect((await read(refused)).code).toBe("approval_required");
  });

  it("uploads multipart files into the project data dir and refuses oversized ones with 413", async () => {
    h = await dataHarness({ uploadMaxBytes: 100 });
    const a = app();
    const boundary = "----forerunner-data-boundary";
    const content = "a,b\n1,2\n";
    const body = (text: string, filename: string) =>
      new TextEncoder().encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="kind"',
          "",
          "csv",
          `--${boundary}`,
          `Content-Disposition: form-data; name="file"; filename="${filename}"`,
          "Content-Type: text/csv",
          "",
          text,
          `--${boundary}--`,
          "",
        ].join("\r\n"),
      );
    const res = await a.fetch(
      new Request(`http://local/projects/${h.projectId}/data`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: body(content, "../../evil name.csv"),
      }),
    );
    expect(res.status).toBe(201);
    const view = DataAssetView.parse(await res.json());
    expect(view.storage).toBe("copied");
    expect(view.sizeBytes).toBe(content.length);
    expect(view.name).not.toContain("..");
    expect(isInside(h.assets.projectDataDir(h.projectId), view.locator)).toBe(true);
    expect(readFileSync(view.locator, "utf8")).toBe(content);
    expect(view.metadata?.columns).toEqual([
      { name: "a", type: "integer" },
      { name: "b", type: "integer" },
    ]);
    expect(await h.store.auditLog.count({ tool: "data.upload" })).toBe(1);
    const big = await a.fetch(
      new Request(`http://local/projects/${h.projectId}/data`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: body("x".repeat(500), "big.csv"),
      }),
    );
    expect(big.status).toBe(413);
    expect((await read(big)).code).toBe("validation");
    expect(await h.assets.list(h.projectId)).toHaveLength(1);
    const noFile = await a.fetch(
      new Request(`http://local/projects/${h.projectId}/data`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: new TextEncoder().encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\ncsv\r\n--${boundary}--\r\n`,
        ),
      }),
    );
    expect(noFile.status).toBe(400);
  });

  it("imports a zip or a folder and runs the gitignore guard when the worktree is known", async () => {
    h = await dataHarness();
    const wt = join(h.src, "wt");
    mkdirSync(wt, { recursive: true });
    const a = app({ humanId: "h-1" }, wt);
    const zip = makeZip(join(h.src, "b.zip"), [{ name: "d/x.csv", data: "a\n1\n" }]);
    const res = await a.fetch(
      json("POST", `/projects/${h.projectId}/data/import`, { source: "zip", path: zip }),
    );
    expect(res.status).toBe(200);
    const result = ImportResultView.parse(await res.json());
    expect(result.imported.map((f) => f.rel)).toEqual(["d/x.csv"]);
    expect(result.gitignore?.added).toEqual(["/.forerunner-data/"]);
    expect(existsSync(join(wt, ".gitignore"))).toBe(true);
    const folder = join(h.src, "folder");
    writeFixture(join(folder, "y.txt"), "y");
    const fres = await a.fetch(
      json("POST", `/projects/${h.projectId}/data/import`, { source: "folder", locator: folder }),
    );
    expect(fres.status).toBe(200);
    expect(ImportResultView.parse(await fres.json()).destination).toBeNull();
    expect(await h.assets.list(h.projectId)).toHaveLength(2);
    expect(
      (await a.fetch(json("POST", `/projects/${h.projectId}/data/import`, { source: "zip" })))
        .status,
    ).toBe(400);
    expect(
      (
        await a.fetch(
          json("POST", `/projects/${h.projectId}/data/import`, { source: "repo", path: zip }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await a.fetch(
          json("POST", `/projects/${h.projectId}/data/import`, { source: "zip", path: "rel.zip" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await a.fetch(
          json("POST", `/projects/${h.projectId}/data/import`, {
            source: "folder",
            path: join(h.src, "nope"),
          }),
        )
      ).status,
    ).toBe(404);
  });
});
