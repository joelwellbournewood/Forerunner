import { EXTENSION_KINDS, type ExtensionRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { asObject, authorOf } from "./shared.ts";

/**
 * capability.grant (spec Q high risk, Security "always needs a human"): adds permissions to
 * an extension row (connector, MCP server, capability) and enables it. Always confirmed on a
 * paired device; an agent can never grant itself a capability without the human.
 */
const params = z.object({
  /** Extension name or id. */
  extension: z.string().min(1),
  kind: z.enum(EXTENSION_KINDS).default("capability"),
  permissions: z.array(z.string().min(1)).min(1),
});
export type CapabilityGrantParams = z.infer<typeof params>;

function permissionsOf(row: ExtensionRow | undefined): string[] {
  return Array.isArray(row?.permissions)
    ? row.permissions.filter((x): x is string => typeof x === "string")
    : [];
}

async function findRow(
  p: CapabilityGrantParams,
  ctx: CommandContext,
): Promise<ExtensionRow | undefined> {
  return (
    (await ctx.store.extension.get(p.extension)) ??
    (await ctx.store.extension.byName(p.kind, p.extension))
  );
}

function sentenceOf(name: string, granted: string[]): string {
  return `Granted ${name} the permission${granted.length === 1 ? "" : "s"} ${granted.join(", ")}. Undo.`;
}

export const capabilityGrant: CommandDef<CapabilityGrantParams> = {
  name: "capability.grant",
  description:
    "Grant an extension (connector, MCP server, capability) one or more permissions and enable it.",
  params,
  risk: "high",
  scope: "global",
  reversible: true,
  undoStrategy:
    "restore the previous permissions and enabled flag; delete a row this grant created",
  actionClass: "capability_grant",
  limit: true,
  async plan(p, ctx) {
    const row = await findRow(p, ctx);
    const current = permissionsOf(row);
    const next = [...new Set([...current, ...p.permissions])];
    return buildCard({
      command: "capability.grant",
      what: `the permissions of ${row?.name ?? p.extension}`,
      oldValue: current.length ? current.join(", ") : "none",
      newValue: next.join(", "),
      scope: "global",
      risk: "high",
      sentence: sentenceOf(row?.name ?? p.extension, p.permissions),
      reversible: true,
    });
  },
  async run(p, ctx) {
    const row = await findRow(p, ctx);
    const author = authorOf(ctx);
    if (!row) {
      const created = await ctx.store.extension.insert({
        kind: p.kind,
        name: p.extension,
        enabled: true,
        permissions: [...new Set(p.permissions)],
        ...author,
      });
      return {
        before: { extension_id: created.id, created: true, permissions: [], enabled: false },
        after: {
          extension_id: created.id,
          permissions: [...new Set(p.permissions)],
          enabled: true,
        },
        sentence: sentenceOf(p.extension, p.permissions),
      };
    }
    const current = permissionsOf(row);
    const next = [...new Set([...current, ...p.permissions])];
    await ctx.store.extension.update(row.id, row.version, {
      permissions: next,
      enabled: true,
      ...author,
    });
    return {
      before: { extension_id: row.id, created: false, permissions: current, enabled: row.enabled },
      after: { extension_id: row.id, permissions: next, enabled: true },
      sentence: sentenceOf(row.name, p.permissions),
    };
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.extension_id !== "string") return;
    const row = await ctx.store.extension.get(b.extension_id);
    if (!row) return;
    if (b.created === true) {
      await ctx.store.extension.delete(row.id);
      return;
    }
    await ctx.store.extension.update(row.id, row.version, {
      permissions: Array.isArray(b.permissions) ? b.permissions : [],
      enabled: b.enabled === true,
      ...authorOf(ctx),
    });
  },
};
