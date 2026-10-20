import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DeviceClient, type Harness, harness, json } from "./helpers.ts";

describe("remote commands", () => {
  let h: Harness;
  let phone: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(() => h.close());

  it("the phone enqueues; the PC picks up atomically; completion is reported back", async () => {
    const created = await json<{ id: string; status: string; deviceId: string; command: string }>(
      await phone.post("/remote/commands", {
        target: "pc",
        command: "start",
        params: { projectId: h.seed.project.id },
      }),
    );
    expect(created.status).toBe("pending");
    expect(created.deviceId).toBe(phone.deviceId);

    const picked = await h.admin.get(
      `/remote/commands/pending?target=pc&deviceId=${h.seed.desktop.id}`,
    );
    expect(picked.status).toBe(200);
    const cmd = await json<{ id: string; status: string; pickedUpAt: string }>(picked);
    expect(cmd.id).toBe(created.id);
    expect(cmd.status).toBe("picked_up");
    expect(cmd.pickedUpAt).toBe(h.clock.nowIso());

    expect((await h.admin.get("/remote/commands/pending?target=pc")).status).toBe(204);
    const done = await json<{ status: string; result: unknown }>(
      await h.admin.post(`/remote/commands/${cmd.id}/complete`, { result: { sessionId: "s1" } }),
    );
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ sessionId: "s1" });
    const mine = await json<{ commands: { id: string; status: string }[] }>(
      await phone.get("/remote/commands"),
    );
    expect(mine.commands).toEqual([expect.objectContaining({ id: cmd.id, status: "done" })]);
  });

  it("two pickers racing for one command: exactly one wins", async () => {
    await phone.post("/remote/commands", { target: "cloud", command: "stop", params: {} });
    const [a, b] = await Promise.all([
      h.admin.get("/remote/commands/pending?target=cloud"),
      h.admin.get("/remote/commands/pending?target=cloud"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 204]);
  });

  it("commands addressed to one device are not picked up by another; cloud and pc queues are separate", async () => {
    const other = await h.store.device.register({
      owner_human_id: h.seed.ada.id,
      name: "Ada's desktop",
      platform: "windows",
      public_key: "other-public-key",
      kind: "desktop",
    });
    await phone.post("/remote/commands", {
      target: "pc",
      targetDeviceId: other.id,
      command: "pause",
      params: {},
    });
    expect(
      (await h.admin.get(`/remote/commands/pending?target=pc&deviceId=${h.seed.desktop.id}`))
        .status,
    ).toBe(204);
    expect((await h.admin.get("/remote/commands/pending?target=cloud")).status).toBe(204);
    expect(
      (await h.admin.get(`/remote/commands/pending?target=pc&deviceId=${other.id}`)).status,
    ).toBe(200);
  });

  it("failure is recorded; illegal lifecycle moves are 400; devices cannot pick up or complete", async () => {
    const created = await json<{ id: string }>(
      await phone.post("/remote/commands", { target: "pc", command: "kill", params: {} }),
    );
    expect((await phone.get("/remote/commands/pending?target=pc")).status).toBe(403);
    expect((await phone.post(`/remote/commands/${created.id}/complete`, {})).status).toBe(403);
    const failed = await json<{ status: string }>(
      await h.admin.post(`/remote/commands/${created.id}/fail`, {
        result: { error: "no such session" },
      }),
    );
    expect(failed.status).toBe("failed");
    expect((await h.admin.post(`/remote/commands/${created.id}/complete`, {})).status).toBe(400);
    expect((await h.admin.post("/remote/commands/missing/complete", {})).status).toBe(404);
    expect((await h.admin.get("/remote/commands/pending?target=moon")).status).toBe(400);
  });

  it("validates the command name and the target device's owner", async () => {
    expect(
      (await phone.post("/remote/commands", { target: "pc", command: "format-disk", params: {} }))
        .status,
    ).toBe(400);
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    const res = await bobPhone.post("/remote/commands", {
      target: "pc",
      targetDeviceId: h.seed.desktop.id,
      command: "start",
      params: {},
    });
    expect(res.status).toBe(403);
    expect(
      (
        await bobPhone.get(
          `/remote/commands/${(await json<{ id: string }>(await phone.post("/remote/commands", { target: "pc", command: "start", params: {} }))).id}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await h.admin.post("/remote/commands", { target: "pc", command: "start", params: {} }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.admin.post("/remote/commands", {
          target: "pc",
          command: "start",
          params: {},
          deviceId: h.seed.desktop.id,
        })
      ).status,
    ).toBe(201);
    // Quick chat from the approvals web or the phone is a `chat` command (ADR 0034 item 5).
    const chat = await json<{ command: string; params: Record<string, unknown> }>(
      await phone.post("/remote/commands", {
        target: "pc",
        command: "chat",
        params: { text: "what's next?", projectId: h.seed.project.id },
      }),
    );
    expect(chat).toMatchObject({ command: "chat", params: { text: "what's next?" } });
  });
});
