import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ForerunnerError, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CloudflareApprovalRequest,
  collectPagesFiles,
  FakeCloudflareApprovals,
  paidWorkerFeatures,
} from "../src/cloudflare/index.ts";
import {
  actorOf,
  cloudflareWorld,
  TOKEN,
  WORKER_SCRIPT,
  type World,
  ZONE_A,
  ZONE_A_NAME,
  ZONE_B,
  ZONE_OTHER,
} from "./helpers/cloudflare-world.ts";

let world: World | undefined;
const temps: string[] = [];

afterEach(async () => {
  await world?.stop();
  world = undefined;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function siteDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-pages-"));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), "fr-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target.txt"), "x");
    symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

async function failsWith(p: Promise<unknown>, code: string): Promise<ForerunnerError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ForerunnerError);
    expect((e as ForerunnerError).code).toBe(code);
    return e as ForerunnerError;
  }
  throw new Error(`expected ${code}`);
}

const worker = (env: "staging" | "production", over: Record<string, unknown> = {}) => ({
  env,
  name: "hello",
  script: WORKER_SCRIPT,
  bindings: [{ type: "plain_text", name: "GREETING", text: "hi" }],
  compatibilityDate: "2026-01-01",
  hosts: [`app.${ZONE_A_NAME}`],
  ...over,
});

describe("deployWorker", () => {
  it("staging at autonomy 3: multipart upload, suffixed name, route in the configured zone, audit rows with the scope", async () => {
    world = await cloudflareWorld();
    const outcome = await world.deployer.deployWorker(worker("staging"), actorOf(world, 3));
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.result.script).toBe("hello-staging");
    expect(outcome.scope).toBe(`account:${world.settings.account_id} zone:${ZONE_A}`);
    expect(world.approvals.requests).toEqual([]);

    const upload = world.fake.requests.find((r) => r.method === "PUT");
    expect(upload?.path).toBe(
      `/accounts/${world.settings.account_id}/workers/scripts/hello-staging`,
    );
    expect(upload?.contentType).toMatch(/^multipart\/form-data/);
    const stored = world.fake.scripts.get("hello-staging");
    expect(stored?.metadata).toEqual({
      main_module: "index.js",
      bindings: [{ type: "plain_text", name: "GREETING", text: "hi" }],
      compatibility_date: "2026-01-01",
    });
    expect(stored?.modules["index.js"]).toBe(WORKER_SCRIPT);
    expect(stored?.contentTypes["index.js"]).toBe("application/javascript+module");
    expect(world.fake.routes.get(ZONE_A)).toEqual([
      { id: "route1", pattern: `app.${ZONE_A_NAME}/*`, script: "hello-staging" },
    ]);

    const rows = await world.store.auditLog.list({ sessionId: "session-1" });
    expect(rows.map((r) => [r.tool, r.allowed])).toEqual([
      ["cloudflare.deploy_worker", true],
      ["cloudflare.worker_route", true],
    ]);
    expect(rows[0]?.input_summary).toContain(`zone:${ZONE_A}`);
    expect(rows[0]?.agent_id).toBe("agent-alice");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("a second deploy updates the existing route instead of adding one", async () => {
    world = await cloudflareWorld();
    await world.deployer.deployWorker(worker("staging"), actorOf(world, 3));
    await world.deployer.deployWorker(worker("production"), actorOf(world, 4));
    expect(world.fake.routes.get(ZONE_A)).toEqual([
      { id: "route1", pattern: `app.${ZONE_A_NAME}/*`, script: "hello" },
    ]);
    const again = await world.deployer.deployWorker(worker("production"), actorOf(world, 4));
    expect(again.status === "done" && again.result.routes).toEqual([
      { pattern: `app.${ZONE_A_NAME}/*`, zoneId: ZONE_A, action: "unchanged" },
    ]);
  });

  it("a host outside the configured zones is refused before any write", async () => {
    world = await cloudflareWorld();
    await failsWith(
      world.deployer.deployWorker(
        worker("staging", { hosts: ["www.other.test"] }),
        actorOf(world, 4),
      ),
      "domain_not_allowed",
    );
    expect(world.fake.writes()).toEqual([]);
    expect(world.fake.scripts.size).toBe(0);
    expect(world.fake.requests.some((r) => r.path.includes(ZONE_OTHER))).toBe(false);
  });

  it("production at autonomy 3 waits for a human; approved, it deploys to the bare name; level 4 never asks", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const pending = await world.deployer.deployWorker(worker("production"), actorOf(world, 3));
    expect(pending.status).toBe("awaiting_approval");
    if (pending.status !== "awaiting_approval") return;
    expect(pending.actionClass).toBe("deploy_production");
    expect(world.approvals.requests).toHaveLength(1);
    expect(world.approvals.requests[0]).toMatchObject({
      operation: "deploy_worker",
      env: "production",
      actionClass: "deploy_production",
      oneShot: false,
      tool: "cloudflare.deploy_worker",
      scope: `account:${world.settings.account_id} zone:${ZONE_A}`,
    });
    expect(world.fake.writes()).toEqual([]);
    const denied = (await world.store.auditLog.list({ allowed: false }))[0];
    expect(denied?.denied_reason).toBe("approval_required: pending");
    await world.stop();

    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("approved") });
    const done = await world.deployer.deployWorker(worker("production"), actorOf(world, 3));
    expect(done.status === "done" && done.result.script).toBe("hello");
    expect(world.approvals.requests).toHaveLength(1);
    await world.stop();

    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("denied") });
    const free = await world.deployer.deployWorker(worker("production"), actorOf(world, 4));
    expect(free.status).toBe("done");
    expect(world.approvals.requests).toEqual([]);
  });

  it("staging below autonomy 3 asks, and a denial refuses with approval_required before any write", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("denied") });
    const e = await failsWith(
      world.deployer.deployWorker(worker("staging"), actorOf(world, 2)),
      "approval_required",
    );
    expect(e.details.outcome).toBe("denied");
    expect(world.approvals.requests[0]?.actionClass).toBe("deploy_staging");
    expect(world.fake.writes()).toEqual([]);
    await world.stop();

    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const level0 = await world.deployer.deployWorker(worker("staging"), actorOf(world, 0));
    expect(level0.status).toBe("awaiting_approval");
  });

  it("a direct call without a tool asks with a script digest, never the script source", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const held = await world.deployer.deployWorker(worker("staging"), actorOf(world, 2));
    expect(held.status).toBe("awaiting_approval");
    const [req] = world.approvals.requests;
    expect(req?.tool).toBe("cloudflare.deploy_worker");
    expect(req?.input).toEqual({
      name: "hello",
      env: "staging",
      hosts: [`app.${ZONE_A_NAME}`],
      scriptChars: WORKER_SCRIPT.length,
      scriptSha256: createHash("sha256").update(WORKER_SCRIPT).digest("hex"),
    });
    expect(JSON.stringify(world.approvals.requests)).not.toContain(WORKER_SCRIPT);
    expect(world.fake.writes()).toEqual([]);
  });

  it("a paid resource is refused without a one-shot human answer at every level, even 4", async () => {
    const paid = { migrations: { new_sqlite_classes: ["Counter"] }, logpush: true };
    expect(paidWorkerFeatures(paid)).toHaveLength(2);
    expect(paidWorkerFeatures({})).toEqual([]);

    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const held = await world.deployer.deployWorker(worker("staging", paid), actorOf(world, 4));
    expect(held.status).toBe("awaiting_approval");
    expect(held.status === "awaiting_approval" && held.actionClass).toBe("financial");
    expect(world.approvals.requests).toHaveLength(1);
    expect(world.approvals.requests[0]).toMatchObject({ actionClass: "financial", oneShot: true });
    expect(world.approvals.requests[0]?.why).toMatch(/Durable Object/);
    expect(world.fake.writes()).toEqual([]);
    await world.stop();

    // Production with a paid feature at level 3: the autonomy answer first, the money answer last.
    const seen: CloudflareApprovalRequest[] = [];
    world = await cloudflareWorld({
      approvals: new FakeCloudflareApprovals((req) => {
        seen.push(req);
        return "approved";
      }),
    });
    const done = await world.deployer.deployWorker(worker("production", paid), actorOf(world, 3));
    expect(done.status).toBe("done");
    expect(seen.map((r) => [r.actionClass, r.oneShot])).toEqual([
      ["deploy_production", false],
      ["financial", true],
    ]);
    expect(world.fake.scripts.get("hello")?.metadata).toMatchObject({
      migrations: { new_sqlite_classes: ["Counter"] },
      logpush: true,
    });
  });
});

describe("deployPages", () => {
  it("direct upload: manifest, missing-file negotiation, only missing files uploaded, staging branch", async () => {
    world = await cloudflareWorld();
    const dir = siteDir({
      "index.html": "<h1>hi</h1>",
      "assets/app.js": "console.log(1)",
      "assets/copy.js": "console.log(1)",
      "img/logo.svg": "<svg/>",
    });
    const files = collectPagesFiles(dir);
    expect(files.map((f) => f.path)).toEqual([
      "/assets/app.js",
      "/assets/copy.js",
      "/img/logo.svg",
      "/index.html",
    ]);
    // Pretend the host already has the svg from an earlier deploy.
    const svgHash = files.find((f) => f.path === "/img/logo.svg")?.hash ?? "";
    world.fake.assets.get("my-site")?.add(svgHash);

    const outcome = await world.deployer.deployPages(
      { env: "staging", project: "my-site", directory: dir },
      actorOf(world, 3),
    );
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.result).toMatchObject({ branch: "staging", uploaded: 2, total: 4 });
    expect(outcome.result.url).toMatch(/pages\.dev$/);

    const paths = world.fake.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual([
      `GET /accounts/${world.settings.account_id}/pages/projects/my-site`,
      `GET /accounts/${world.settings.account_id}/pages/projects/my-site/upload-token`,
      "POST /pages/assets/check-missing",
      "POST /pages/assets/upload",
      "POST /pages/assets/upsert-hashes",
      `POST /accounts/${world.settings.account_id}/pages/projects/my-site/deployments`,
    ]);
    expect(world.fake.uploads.map((u) => u.contentType).sort()).toEqual([
      "application/javascript",
      "text/html",
    ]);
    const deployment = world.fake.deployments[0];
    expect(deployment?.environment).toBe("preview");
    expect(Object.keys(deployment?.manifest ?? {})).toEqual(files.map((f) => f.path));
    expect(world.fake.requests[2]?.authorization).toBe(`Bearer ${world.fake.uploadJwt}`);
    const rows = await world.store.auditLog.list({});
    expect(rows.map((r) => r.tool)).toEqual(["cloudflare.pages_upload", "cloudflare.deploy_pages"]);
    expect(JSON.stringify(rows)).not.toContain(world.fake.uploadJwt);
  });

  it("production goes to the project's production branch and needs approval below 4", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const dir = siteDir({ "index.html": "<h1>prod</h1>" });
    const held = await world.deployer.deployPages(
      { env: "production", project: "my-site", directory: dir },
      actorOf(world, 3),
    );
    expect(held.status).toBe("awaiting_approval");
    expect(world.fake.writes()).toEqual([]);
    const done = await world.deployer.deployPages(
      { env: "production", project: "my-site", directory: dir },
      actorOf(world, 4),
    );
    expect(done.status === "done" && done.result.branch).toBe("main");
    expect(world.fake.deployments[0]?.environment).toBe("production");
  });

  it("refuses an unknown project, an empty directory and a staging branch equal to production", async () => {
    world = await cloudflareWorld({ settings: { pages: { staging_branch: "main" } } });
    const dir = siteDir({ "index.html": "x" });
    await failsWith(
      world.deployer.deployPages(
        { env: "staging", project: "nope", directory: dir },
        actorOf(world, 4),
      ),
      "not_found",
    );
    await failsWith(
      world.deployer.deployPages(
        { env: "staging", project: "my-site", directory: dir },
        actorOf(world, 4),
      ),
      "validation",
    );
    const empty = siteDir({});
    await failsWith(
      world.deployer.deployPages(
        { env: "production", project: "my-site", directory: empty },
        actorOf(world, 4),
      ),
      "validation",
    );
    expect(world.fake.writes()).toEqual([]);
  });

  it.skipIf(!canSymlink)(
    "skips symlinks instead of following them (symlinks not creatable here)",
    () => {
      const outside = siteDir({ "secret.txt": "outside" });
      const dir = siteDir({ "index.html": "x" });
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
      symlinkSync(outside, join(dir, "leakdir"));
      expect(collectPagesFiles(dir).map((f) => f.path)).toEqual(["/index.html"]);
    },
  );
});

describe("dnsUpsert", () => {
  const record = {
    type: "CNAME" as const,
    name: `app.${ZONE_A_NAME}`,
    content: "hello.workers.dev",
  };

  it("creates, then updates, then leaves an equal record alone; the zone comes from the name", async () => {
    world = await cloudflareWorld();
    const created = await world.deployer.dnsUpsert({ record }, actorOf(world, 4));
    expect(created.status === "done" && created.result.action).toBe("create");
    expect(created.scope).toBe(`account:${world.settings.account_id} zone:${ZONE_A}`);
    const updated = await world.deployer.dnsUpsert(
      { record: { ...record, content: "other.workers.dev", proxied: true } },
      actorOf(world, 4),
    );
    expect(updated.status === "done" && updated.result.action).toBe("update");
    const same = await world.deployer.dnsUpsert(
      { record: { ...record, content: "other.workers.dev", proxied: true } },
      actorOf(world, 4),
    );
    expect(same.status === "done" && same.result.action).toBe("unchanged");
    expect(world.fake.dns.get(ZONE_A)).toEqual([
      expect.objectContaining({
        id: "dns1",
        name: `app.${ZONE_A_NAME}`,
        content: "other.workers.dev",
        proxied: true,
      }),
    ]);
    expect(world.fake.writes().map((r) => r.method)).toEqual(["POST", "PUT"]);
  });

  it("is a production action: asks below autonomy 4 and refuses names outside the zones before any request", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const held = await world.deployer.dnsUpsert({ record }, actorOf(world, 3));
    expect(held.status).toBe("awaiting_approval");
    expect(world.approvals.requests[0]?.actionClass).toBe("deploy_production");
    await failsWith(
      world.deployer.dnsUpsert(
        { record: { ...record, name: "www.other.test" } },
        actorOf(world, 4),
      ),
      "domain_not_allowed",
    );
    await failsWith(
      world.deployer.dnsUpsert({ zoneId: ZONE_OTHER, record }, actorOf(world, 4)),
      "tool_not_allowed",
    );
    await failsWith(
      world.deployer.dnsUpsert({ zoneId: ZONE_B, record }, actorOf(world, 4)),
      "domain_not_allowed",
    );
    expect(world.fake.writes()).toEqual([]);
  });
});

describe("plan and plan changes", () => {
  it("plan() lists what would change and sends no writes and no approval", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("denied") });
    const w = await world.deployer.plan(
      { kind: "worker", ...worker("production") },
      actorOf(world, 3),
    );
    expect(w).toMatchObject({
      operation: "deploy_worker",
      env: "production",
      actionClass: "deploy_production",
      decision: "approval_required",
      paid: [],
    });
    expect(w.changes).toEqual([
      { resource: "worker_script", action: "create", target: "hello", detail: expect.any(String) },
      {
        resource: "worker_route",
        action: "create",
        target: `app.${ZONE_A_NAME}/*`,
        detail: `zone ${ZONE_A_NAME}`,
      },
    ]);
    const d = await world.deployer.plan(
      { kind: "dns", record: { type: "A", name: ZONE_A_NAME, content: "192.0.2.1" } },
      actorOf(world, 4),
    );
    expect(d.decision).toBe("allow");
    expect(d.changes[0]).toMatchObject({ resource: "dns_record", action: "create" });
    const dir = siteDir({ "index.html": "x" });
    const p = await world.deployer.plan(
      { kind: "pages", env: "staging", project: "my-site", directory: dir },
      actorOf(world, 3),
    );
    expect(p.decision).toBe("allow");
    expect(p.changes[0]?.target).toBe("my-site@staging");
    const z = await world.deployer.plan(
      { kind: "zone_plan", zoneId: ZONE_A, planId: "pro" },
      actorOf(world, 4),
    );
    expect(z.actionClass).toBe("financial");
    expect(z.decision).toBe("approval_required");
    expect(world.fake.writes()).toEqual([]);
    expect(world.approvals.requests).toEqual([]);
  });

  it("changeZonePlan is money: one-shot approval at every level, refused when pending", async () => {
    world = await cloudflareWorld({ approvals: new FakeCloudflareApprovals("pending") });
    const held = await world.deployer.changeZonePlan(
      { zoneId: ZONE_A, planId: "pro" },
      actorOf(world, 4),
    );
    expect(held.status).toBe("awaiting_approval");
    expect(world.approvals.requests[0]).toMatchObject({ actionClass: "financial", oneShot: true });
    expect(world.fake.planChanges).toEqual([]);
    await world.stop();
    world = await cloudflareWorld();
    const done = await world.deployer.changeZonePlan(
      { zoneId: ZONE_A, planId: "pro" },
      actorOf(world, 4),
    );
    expect(done.status === "done" && done.result.planId).toBe("pro");
    expect(world.fake.planChanges).toEqual([{ zoneId: ZONE_A, planId: "pro" }]);
    const rows = await world.store.auditLog.list({ tool: "cloudflare.change_plan" });
    expect(rows).toHaveLength(1);
  });
});
