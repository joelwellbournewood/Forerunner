import { ForerunnerError } from "@forerunner/platform";
import type { DeviceRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";

/**
 * device.revoke (spec R.2, R.7): revoke a paired device at once. High risk (a permission
 * change) and not reversible: the device has to be paired again.
 */
const params = z.object({
  /** Device id or name. */
  device: z.string().min(1),
});
export type DeviceRevokeParams = z.infer<typeof params>;

async function findDevice(p: DeviceRevokeParams, ctx: CommandContext): Promise<DeviceRow> {
  const direct = await ctx.store.device.get(p.device);
  if (direct) {
    if (direct.owner_human_id !== ctx.humanId)
      throw new ForerunnerError("not_found", `no device ${p.device}`);
    return direct;
  }
  const mine = await ctx.store.device.active(ctx.humanId);
  const needle = p.device.trim().toLowerCase();
  const matches = mine.filter((d) => d.name.toLowerCase() === needle);
  const loose = matches.length
    ? matches
    : mine.filter((d) => d.name.toLowerCase().includes(needle));
  if (loose.length === 1) return loose[0] as DeviceRow;
  if (loose.length > 1) {
    throw new ForerunnerError("validation", `several devices match ${p.device}`, {
      details: { candidates: loose.map((d) => d.name) },
    });
  }
  throw new ForerunnerError("not_found", `no paired device named ${p.device}`);
}

function sentenceOf(d: DeviceRow): string {
  return `Revoked the device ${d.name}; it must be paired again to reconnect.`;
}

export const deviceRevoke: CommandDef<DeviceRevokeParams> = {
  name: "device.revoke",
  description: "Revoke a paired device (phone, desktop, runner) so its key stops working at once.",
  params,
  risk: "high",
  scope: "global",
  reversible: false,
  undoStrategy: "pair the device again",
  actionClass: "permission_change",
  async plan(p, ctx) {
    const d = await findDevice(p, ctx);
    if (d.revoked) throw new ForerunnerError("validation", `device ${d.name} is already revoked`);
    return buildCard({
      command: "device.revoke",
      what: `the device ${d.name}`,
      oldValue: "paired",
      newValue: "revoked",
      scope: "global",
      risk: "high",
      sentence: sentenceOf(d),
      reversible: false,
    });
  },
  async run(p, ctx) {
    const d = await findDevice(p, ctx);
    if (d.revoked) throw new ForerunnerError("validation", `device ${d.name} is already revoked`);
    await ctx.store.device.revoke(d.id, d.version);
    return {
      before: { device_id: d.id, revoked: false },
      after: { device_id: d.id, revoked: true },
      sentence: sentenceOf(d),
    };
  },
};
