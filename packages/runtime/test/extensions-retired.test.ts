import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { JsonObject } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { VoiceStatusView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { HumanRequestExtensionApprovals } from "../src/extensions/approvals.ts";
import { RETIRED_CATALOG_ENTRIES } from "../src/extensions/catalog.ts";
import type { ExtensionPermissions, ExtensionView } from "../src/extensions/types.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");

const permissions = (p: Partial<ExtensionPermissions> = {}): ExtensionPermissions => ({
  tools: [],
  actionClasses: [],
  domains: [],
  paths: [],
  secrets: [],
  scopes: [],
  ...p,
});

/**
 * U-023: Extensions and Settings overlapped. `voice-local` in the panel installed nothing (the
 * install is Settings -> Voice) and the `anthropic` row switched nothing (the model uses the key
 * or token from setup). The catalog no longer offers them; a row a 1.0.4 install already has is
 * taken out at the next start, its open Inbox card with it, and nothing else changes. Crosses
 * the lifecycle: the rows are written by one runtime and read by the next on the same home.
 */
describe("rows of catalog entries another screen owns are retired at the next start (U-023)", () => {
  it("an installed voice-local row and a pending anthropic row from 1.0.4 leave the panel once; the rest stays", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ext-retired-"));
    const env = { FORERUNNER_HOME: home };
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const vault = new MemoryVault();
    const compose = () =>
      composeRuntime({
        env,
        dirs: appDirs({ env }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault,
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "1.0.5-test",
        startServices: false,
      });

    // 1.0.4 wrote these rows the way its registry did (catalog id in the config).
    let rt: RuntimeApp = await compose();
    const humanId = rt.human.id;
    const catalogRow = (
      catalogId: string,
      kind: string,
      p: ExtensionPermissions,
      extra: Record<string, unknown> = {},
    ) =>
      rt.store.extension.insert({
        kind,
        name: catalogId,
        ext_version: "1.0.0",
        enabled: extra.status !== "pending_approval",
        permissions: p as unknown as JsonObject,
        source_url: `catalog:${catalogId}`,
        status: (extra.status as string | undefined) ?? "installed",
        config: {
          catalogId,
          description: `${catalogId} as 1.0.4 installed it`,
          module: null,
          transport: null,
          review: null,
          pendingStage: extra.status === "pending_approval" ? "grant" : null,
          ...extra,
        } as unknown as JsonObject,
        author_human: humanId,
      });
    const local = await catalogRow(
      "voice-local",
      "capability",
      permissions({ actionClasses: ["read"], scopes: ["microphone and speaker on this machine"] }),
    );
    const anthropicPermissions = permissions({
      domains: ["api.anthropic.com"],
      secrets: ["anthropic_api_key"],
    });
    const anthropic = await catalogRow("anthropic", "model_provider", anthropicPermissions, {
      status: "pending_approval",
    });
    // Its grant card waits in the Inbox, as 1.0.4 filed it.
    const asked = await new HumanRequestExtensionApprovals(rt.store.humanRequest).ask({
      extensionId: anthropic.id,
      name: "anthropic",
      kind: "model_provider",
      humanId,
      stage: "grant",
      why: 'Install model_provider "anthropic": granting a new capability needs your approval.',
      review: {
        tools: [],
        resources: [],
        permissions: anthropicPermissions,
        risk: "high",
        summary: ["needs secret:anthropic_api_key"],
      },
      permissions: anthropicPermissions,
      previous: null,
      sourceUrl: "catalog:anthropic",
    });
    if (asked.outcome !== "pending" || !asked.requestId) throw new Error("expected an open card");
    const requestId: string = asked.requestId;
    const fresh = await rt.store.extension.mustGet(anthropic.id);
    await rt.store.extension.update(anthropic.id, fresh.version, {
      config: {
        ...(fresh.config as Record<string, unknown>),
        pendingRequestId: requestId,
      } as unknown as JsonObject,
    });
    const browser = await catalogRow(
      "browser",
      "capability",
      permissions({ tools: ["browser_navigate"], actionClasses: ["read"] }),
    );
    expect((await rt.store.humanRequest.get(requestId))?.status).toBe("open");
    await rt.close();

    // The next start: the panel, the Inbox and voice as the person meets them.
    rt = await compose();
    try {
      const { app, token } = createDaemonApp(rt);
      const call = (path: string, init: RequestInit = {}) =>
        app.request(path, {
          ...init,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        });
      const listed = (await (await call("/extensions")).json()) as ExtensionView[];
      expect(listed.map((e) => e.id)).toContain(browser.id);
      expect(listed.map((e) => e.id)).not.toContain(local.id);
      expect(listed.map((e) => e.id)).not.toContain(anthropic.id);
      // The card nobody can act on any more left the Inbox.
      expect((await rt.store.humanRequest.get(requestId))?.status).toBe("withdrawn");
      const inbox = (await (await call("/inbox")).json()) as { requests: { id: string }[] };
      expect(inbox.requests.map((r) => r.id)).not.toContain(requestId);
      // Each retirement is an audit row with the reason the person can read.
      const audit = await rt.store.auditLog.list({ tool: "extensions.retire" });
      expect(audit.map((a) => JSON.parse(a.input_summary).extensionId).sort()).toEqual(
        [local.id, anthropic.id].sort(),
      );
      const localAudit = audit.find((a) => JSON.parse(a.input_summary).extensionId === local.id);
      expect(JSON.parse(localAudit?.result_summary ?? "{}")).toMatchObject({
        reason: RETIRED_CATALOG_ENTRIES["voice-local"],
      });
      // Voice still answers, and no retired row is named in it.
      const voice = VoiceStatusView.parse(await (await call("/voice/status")).json());
      expect(JSON.stringify(voice.preferences)).not.toContain("voice-local");
      // Adding it again is refused with the place that owns it.
      const again = await call("/extensions", {
        method: "POST",
        body: JSON.stringify({ catalogId: "voice-local" }),
      });
      expect(again.status).toBe(400);
      expect(((await again.json()) as { message: string }).message).toContain("Settings → Voice");
    } finally {
      await rt.close();
    }

    // A third start finds nothing more to retire.
    rt = await compose();
    try {
      expect(await rt.store.auditLog.list({ tool: "extensions.retire" })).toHaveLength(2);
      expect((await rt.store.extension.get(browser.id))?.enabled).toBe(true);
    } finally {
      await rt.close();
    }
  });

  it("U-075: a 1.0.4 `email` row switched off no longer gates email off against the Email page", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ext-retired-email-"));
    const env = { FORERUNNER_HOME: home };
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const compose = () =>
      composeRuntime({
        env,
        dirs: appDirs({ env }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault: new MemoryVault(),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "1.0.5-test",
        startServices: false,
      });
    let rt: RuntimeApp = await compose();
    // The catalog's email row, installed and then switched off in Extensions: it owned the
    // email_* tools, so the gate refused them whatever the Email page said.
    const row = await rt.store.extension.insert({
      kind: "capability",
      name: "email",
      ext_version: "1.0.0",
      enabled: false,
      permissions: permissions({
        tools: ["email_list", "email_read", "email_draft", "email_send"],
        actionClasses: ["read", "routine_reversible", "external_send"],
        secrets: ["agent_mailbox_password"],
      }) as unknown as JsonObject,
      source_url: "catalog:email",
      status: "installed",
      config: { catalogId: "email", description: "email as 1.0.4 installed it" } as JsonObject,
    });
    const send = rt.capabilities.email.ports.tools.find((t) => t.name === "email_send");
    if (!send) throw new Error("no email_send tool");
    await expect(rt.gate.check(send)).rejects.toMatchObject({ code: "tool_not_allowed" });
    await rt.close();

    rt = await compose();
    try {
      // The Email page alone decides now: the gate lets the tool through to the email policy.
      const tool = rt.capabilities.email.ports.tools.find((t) => t.name === "email_send");
      if (!tool) throw new Error("no email_send tool");
      await expect(rt.gate.check(tool)).resolves.toBeUndefined();
      expect(await rt.store.extension.get(row.id)).toBeUndefined();
      const audit = await rt.store.auditLog.list({ tool: "extensions.retire" });
      expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toMatchObject({
        catalogId: "email",
        reason: RETIRED_CATALOG_ENTRIES.email,
      });
    } finally {
      await rt.close();
    }
  });
});
