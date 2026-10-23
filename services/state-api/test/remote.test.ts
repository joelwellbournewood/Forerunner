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

  it("the owner and agent filters leave another human's command for that human's runner", async () => {
    const bobPhone = await h.pairDevice(h.seed.bob.id);
    const bobs = await json<{ id: string }>(
      await bobPhone.post("/remote/commands", { target: "pc", command: "kill", params: {} }),
    );
    // Ada's runtime asks for Ada's commands only: Bob's stays pending.
    expect(
      (await h.admin.get(`/remote/commands/pending?target=pc&humanId=${h.seed.ada.id}`)).status,
    ).toBe(204);
    expect(
      (
        await h.admin.get(
          `/remote/commands/pending?target=pc&humanId=${h.seed.bob.id}&agentId=${h.seed.alice.id}`,
        )
      ).status,
    ).toBe(204);
    const picked = await json<{ id: string; status: string }>(
      await h.admin.get(
        `/remote/commands/pending?target=pc&humanId=${h.seed.bob.id}&agentId=${h.seed.bobAgent.id}`,
      ),
    );
    expect(picked).toMatchObject({ id: bobs.id, status: "picked_up" });
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

  it("a device's envelope is enqueued once per clientId: a repeat returns the first row, the outbox's replay is a duplicate, a different body is 409", async () => {
    const envelope = {
      v: 1,
      kind: "plan",
      plan: [{ name: "session.start", params: { project: h.seed.project.id } }],
      wordsUsed: "start the sample",
      card: { what: "Start a session" },
      clientId: "11111111-2222-4333-8444-555555555555",
      confirmedAt: h.clock.nowIso(),
    };
    const body = { target: "pc", command: "start", params: envelope };
    const first = await phone.post("/remote/commands", body);
    expect(first.status).toBe(201);
    const created = await json<{ id: string; status: string }>(first);
    expect(created.status).toBe("pending");

    // The answer was lost; the phone POSTs the same envelope again (re-signed, as the app's
    // client signs every attempt: a byte-identical replay is the signature guard's 401):
    // the first row, nothing new.
    await h.clock.advance(1_000);
    const again = await phone.post("/remote/commands", body);
    expect(again.status).toBe(200);
    expect(await json<{ id: string }>(again)).toMatchObject({ id: created.id });
    expect(await h.store.remoteCommand.count()).toBe(1);

    // The app's actual retry path: the outbox replays the envelope under the same clientId.
    const { results } = await json<{ results: { status: string; result: { id: string } }[] }>(
      await phone.post("/sync/outbox", {
        actions: [
          {
            clientId: envelope.clientId,
            kind: "remote.enqueue",
            payload: body,
            createdAt: h.clock.nowIso(),
          },
        ],
      }),
    );
    expect(results[0]).toMatchObject({ status: "duplicate", result: { id: created.id } });
    expect(await h.store.remoteCommand.count()).toBe(1);

    // The same clientId with a different body is a client bug, refused.
    const different = await phone.post("/remote/commands", {
      ...body,
      params: { ...envelope, plan: [{ name: "session.stop", params: { scope: "all" } }] },
    });
    expect(different.status).toBe(409);
    expect(await json<{ code: string; details: { commandId: string } }>(different)).toMatchObject({
      code: "version_conflict",
      details: { commandId: created.id },
    });
    expect(await h.store.remoteCommand.count()).toBe(1);

    // The other order: queued offline first, then the direct POST after the reconnect.
    const queued = {
      ...body,
      params: { ...envelope, clientId: "11111111-2222-4333-8444-666666666666" },
    };
    const viaOutbox = await json<{ results: { status: string; result: { id: string } }[] }>(
      await phone.post("/sync/outbox", {
        actions: [
          {
            clientId: queued.params.clientId,
            kind: "remote.enqueue",
            payload: queued,
            createdAt: h.clock.nowIso(),
          },
        ],
      }),
    );
    expect(viaOutbox.results[0]?.status).toBe("applied");
    const direct = await phone.post("/remote/commands", queued);
    expect(direct.status).toBe(200);
    expect(await json<{ id: string }>(direct)).toMatchObject({
      id: viaOutbox.results[0]?.result.id,
    });
    expect(await h.store.remoteCommand.count()).toBe(2);

    // Each issuing device is its own space: another phone's same clientId is its own command.
    const secondPhone = await h.pairDevice(h.seed.ada.id);
    expect((await secondPhone.post("/remote/commands", body)).status).toBe(201);
    expect(await h.store.remoteCommand.count()).toBe(3);

    // Without a clientId every POST is a new row, as before; admin callers too.
    const plain = { target: "pc", command: "start", params: { projectId: h.seed.project.id } };
    expect((await phone.post("/remote/commands", plain)).status).toBe(201);
    await h.clock.advance(1_000);
    expect((await phone.post("/remote/commands", plain)).status).toBe(201);
    const admin = { ...body, deviceId: h.seed.desktop.id };
    expect((await h.admin.post("/remote/commands", admin)).status).toBe(201);
    expect((await h.admin.post("/remote/commands", admin)).status).toBe(201);
    expect(await h.store.remoteCommand.count()).toBe(7);

    // A clientId that is not a short string is a validation error, not a command.
    for (const clientId of ["", 7, "x".repeat(201)]) {
      expect(
        (await phone.post("/remote/commands", { ...body, params: { ...envelope, clientId } }))
          .status,
      ).toBe(400);
    }
    expect(await h.store.remoteCommand.count()).toBe(7);
  });

  it("a phone's push-to-talk turn of the longest relayed length fits the JSON body cap (ADR 0080)", async () => {
    // 5 s of 16 kHz mono 16-bit PCM, base64: the PC's VOICE_RELAY_MAX_MS.
    const pcm = Buffer.alloc(16_000 * 2 * 5, 7).toString("base64");
    const envelope = (audio: string) => ({
      target: "pc",
      command: "start",
      params: {
        v: 1,
        kind: "voice",
        projectId: h.seed.project.id,
        clientId: `voice-${audio.length}`,
        audio: { pcm: audio, sampleRate: 16_000, channels: 1, durationMs: 5_000 },
      },
    });
    const ok = await phone.post("/remote/commands", envelope(pcm));
    expect(ok.status).toBe(201);
    const row = await json<{ params: { audio: { pcm: string } } }>(ok);
    expect(row.params.audio.pcm).toHaveLength(pcm.length);
    // Twice as long is over the body cap: refused, never stored.
    const tooLong = await phone.post("/remote/commands", envelope(pcm + pcm));
    expect(tooLong.status).toBe(413);
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
  });
});
