import { ForerunnerError, Logger, type LogRecord } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudflareClient,
  cloudflareSettingsOf,
  coverageWarnings,
  DEFAULT_CLOUDFLARE_SECRET_REF,
  isMoneyPath,
  normaliseHost,
  parseCloudflareSettings,
  scopeLines,
  staticTokenSource,
} from "../src/cloudflare/index.ts";
import {
  ACCOUNT,
  cloudflareWorld,
  settingsInput,
  settle,
  TOKEN,
  type World,
  ZONE_A,
  ZONE_B,
  ZONE_OTHER,
} from "./helpers/cloudflare-world.ts";

let world: World | undefined;

afterEach(async () => {
  await world?.stop();
  world = undefined;
});

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

describe("cloudflare settings", () => {
  it("parses with defaults and refuses a token value where a reference belongs", () => {
    const s = parseCloudflareSettings(settingsInput({ secret_ref: undefined }));
    expect(s.secret_ref).toBe(DEFAULT_CLOUDFLARE_SECRET_REF);
    expect(s.workers.staging_suffix).toBe("-staging");
    expect(s.pages.staging_branch).toBe("staging");
    expect(() => parseCloudflareSettings(settingsInput({ secret_ref: TOKEN }))).toThrow(
      ForerunnerError,
    );
    expect(() => parseCloudflareSettings({ account_id: "bad id!" })).toThrow(/account_id/);
  });

  it("reads the project settings and never silently widens the scope", () => {
    expect(cloudflareSettingsOf({ settings: {} })).toBeNull();
    const ok = cloudflareSettingsOf({ settings: { cloudflare: settingsInput() } });
    expect(ok?.zone_ids).toEqual([ZONE_A, ZONE_B]);
    expect(() =>
      cloudflareSettingsOf({ settings: { cloudflare: { account_id: "", zone_ids: "all" } } }),
    ).toThrow(ForerunnerError);
  });

  it("normalises hosts, allowing underscore labels, and rejects junk", () => {
    expect(normaliseHost("_acme-challenge.Example.Test.")).toBe("_acme-challenge.example.test");
    expect(() => normaliseHost("bad host")).toThrow(ForerunnerError);
    expect(() => normaliseHost("a..b")).toThrow(ForerunnerError);
  });
});

describe("CloudflareClient: token", () => {
  it("verifies the token and reports its scopes and coverage warnings, never the value", async () => {
    world = await cloudflareWorld({ settings: { zone_ids: [ZONE_A, ZONE_B, ZONE_OTHER] } });
    const v = await world.client.verifyToken();
    expect(v.status).toBe("active");
    expect(v.scopesKnown).toBe(true);
    expect(v.scopes).toContain(`Workers Scripts Write on account ${ACCOUNT}`);
    expect(v.scopes.some((s) => s.startsWith("DNS Write on"))).toBe(true);
    expect(v.warnings).toEqual([`the token's permissions do not name zone ${ZONE_OTHER}`]);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(world.fake.requests.map((r) => r.path)).toEqual([
      "/user/tokens/verify",
      "/user/tokens/tok1",
    ]);
    expect(world.fake.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("says when the token cannot read its own permissions", async () => {
    world = await cloudflareWorld({ fake: { tokenId: "tok-other" } });
    world.fake.failNext({
      status: 200,
      body: { success: true, result: { id: "tok1", status: "active" } },
    });
    const v = await world.client.verifyToken();
    expect(v.scopesKnown).toBe(false);
    expect(v.scopes).toEqual([]);
    expect(v.warnings[0]).toMatch(/API Tokens Read/);
  });

  it("resolves the token from the vault by reference on every call", async () => {
    world = await cloudflareWorld();
    await world.client.getAccount();
    const rotated = ["cf", "rotated", "token", "value", "9876543210"].join("-"); // not-a-secret
    await world.vault.set("cloudflare_api_token", rotated);
    world.fake.failNext({
      status: 200,
      body: { success: true, result: { id: ACCOUNT, name: "x" } },
    });
    await world.client.getAccount();
    expect(world.fake.requests.map((r) => r.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${rotated}`,
    ]);
  });

  it("maps an authentication failure to provider_auth without the token in the message", async () => {
    world = await cloudflareWorld();
    await world.vault.set("cloudflare_api_token", ["wrong", "token", "value", "abc"].join("-")); // not-a-secret
    const e = await failsWith(world.client.getAccount(), "provider_auth");
    expect(e.message).toMatch(/Authentication error/);
    expect(e.message).not.toContain("wrong-token");
  });

  it("scrubs a token echoed back by the server out of errors and logs", async () => {
    world = await cloudflareWorld();
    const records: LogRecord[] = [];
    const stop = Logger.addSink((r) => records.push(r));
    try {
      world.fake.failNext({ status: 400, echoAuth: true });
      const e = await failsWith(world.client.getAccount(), "validation");
      expect(e.message).toContain("[REDACTED]");
      expect(JSON.stringify(e.toJSON())).not.toContain(TOKEN);
      expect(JSON.stringify(records)).not.toContain(TOKEN);
    } finally {
      stop();
    }
  });
});

describe("CloudflareClient: scope", () => {
  it("refuses a zone outside the configured list in code before any request", async () => {
    world = await cloudflareWorld();
    const e = await failsWith(world.client.listDnsRecords(ZONE_OTHER), "tool_not_allowed");
    expect(e.details.allowedZones).toEqual([ZONE_A, ZONE_B]);
    await failsWith(world.client.getZone(ZONE_OTHER), "tool_not_allowed");
    await failsWith(world.client.createWorkerRoute(ZONE_OTHER, "x/*", "s"), "tool_not_allowed");
    await failsWith(world.client.zoneForHost("www.other.test"), "domain_not_allowed");
    expect(world.fake.writes()).toEqual([]);
    expect(
      world.fake.requests.every((r) => r.method === "GET" && r.path.startsWith("/zones/")),
    ).toBe(true);
    expect(world.fake.requests.some((r) => r.path.includes(ZONE_OTHER))).toBe(false);
  });

  it("lists only the configured zones although the account has more", async () => {
    world = await cloudflareWorld();
    const zones = await world.client.listZones();
    expect(zones.map((z) => z.id).sort()).toEqual([ZONE_A, ZONE_B].sort());
    expect(world.fake.requests[0]?.query["account.id"]).toBe(ACCOUNT);
    const zone = await world.client.zoneForHost("api.example-two.test");
    expect(zone.id).toBe(ZONE_B);
  });

  it("only knows the configured account", async () => {
    world = await cloudflareWorld();
    expect(world.client.accountPath("/x")).toBe(`/accounts/${ACCOUNT}/x`);
    expect(() => world?.client.assertAccount("someone-else")).toThrow(ForerunnerError);
  });
});

describe("CloudflareClient: money and rate limits", () => {
  it("refuses plan and billing paths without a human's answer, at every level", async () => {
    world = await cloudflareWorld();
    expect(isMoneyPath(`/zones/${ZONE_A}/subscription`)).toBe(true);
    expect(isMoneyPath("/accounts/x/billing/profile")).toBe(true);
    expect(isMoneyPath(`/zones/${ZONE_A}/dns_records`)).toBe(false);
    const e = await failsWith(
      world.client.changeZonePlan(ZONE_A, "pro", { moneyApproved: false }),
      "approval_required",
    );
    expect(e.details.actionClass).toBe("financial");
    expect(world.fake.requests).toEqual([]);
    const r = await world.client.changeZonePlan(ZONE_A, "pro", { moneyApproved: true });
    expect(r.planId).toBe("pro");
    expect(world.fake.planChanges).toEqual([{ zoneId: ZONE_A, planId: "pro" }]);
  });

  it("waits for Retry-After on 429 using the clock, then retries once", async () => {
    world = await cloudflareWorld();
    world.fake.failNext({ status: 429, headers: { "retry-after": "2" } });
    const p = world.client.getAccount();
    while (world.clock.pendingTimers() === 0) await new Promise((r) => setImmediate(r));
    await world.clock.advance(2000);
    const a = await p;
    expect(a.id).toBe(ACCOUNT);
    expect(world.fake.requests).toHaveLength(2);
  });

  it("gives up with a retryable provider_rate_limit when the wait exceeds the bound", async () => {
    world = await cloudflareWorld();
    const client = new CloudflareClient({
      scope: world.client.scope,
      token: staticTokenSource(TOKEN),
      baseUrl: world.fake.baseUrl,
      clock: world.clock,
      maxRateLimitWaitSec: 1,
    });
    world.fake.failNext({ status: 429, headers: { "retry-after": "5" } });
    const e = await failsWith(client.getAccount(), "provider_rate_limit");
    expect(e.retryable).toBe(true);
    expect(e.details.retryAfterMs).toBe(5000);
  });

  it("maps 404 and 5xx and keeps the configured path in the details", async () => {
    world = await cloudflareWorld();
    await failsWith(
      world.client.getPagesProject("nope").then((p) => {
        if (p === null) throw new ForerunnerError("not_found", "null");
        return p;
      }),
      "not_found",
    );
    world.fake.failNext({ status: 503, times: 3 });
    const e = await failsWith(settle(world.clock, world.client.getAccount()), "provider_error");
    expect(e.retryable).toBe(true);
    expect(e.details.status).toBe(503);
  });
});

describe("scope lines", () => {
  it("describes policies as human-readable lines and warns about uncovered zones", () => {
    const policies = [
      {
        effect: "allow" as const,
        permissionGroups: [{ id: "1", name: "DNS Write" }],
        resources: [`com.cloudflare.api.account.zone.${ZONE_A}`],
      },
      {
        effect: "deny" as const,
        permissionGroups: [{ id: "2", name: "Zone Delete" }],
        resources: ["com.cloudflare.api.account.zone.*"],
      },
    ];
    expect(scopeLines(policies)).toEqual([
      `DNS Write on zone ${ZONE_A}`,
      "deny Zone Delete on all zones",
    ]);
    expect(coverageWarnings(policies, { accountId: ACCOUNT, zoneIds: [ZONE_A, ZONE_B] })).toEqual([
      `the token's permissions do not name zone ${ZONE_B}`,
      `the token's permissions do not name account ${ACCOUNT} (Workers and Pages need account permissions)`,
    ]);
  });
});
