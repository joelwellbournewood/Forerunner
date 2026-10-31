import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChangeLogView,
  ChatReplyView,
  CommandResultViewSchema,
  type HumanRequestView,
  InboxView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

/**
 * U-029: a medium-risk change asked for in Chat or by voice waits as a change card in the
 * Inbox. On a default local install (a `sqlite:` store, the background services on, remote
 * commands off, so no remote watcher) the card's answer went nowhere: only the remote watcher
 * applied it. These tests do what a person does: ask in Chat, open the Inbox, click the option
 * the Inbox shows, and look at what changed. A last one restarts the daemon in between.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

interface Daemon {
  rt: RuntimeApp;
  req: (path: string, init?: RequestInit) => Promise<Response>;
}

async function daemon(clock: SimulatedClock, home: string, stateUrl: string): Promise<Daemon> {
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  // A default local install: no `startServices: false` and no remote option.
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl,
    vault: new MemoryVault(),
    provider: new FakeProvider({
      replies: [textReply("Noted.", { times: Number.POSITIVE_INFINITY })],
      clock,
      latency: "none",
    }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  const { app, token } = createDaemonApp(rt);
  const req = (path: string, init: RequestInit = {}) =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );
  return { rt, req };
}

async function project(rt: RuntimeApp): Promise<string> {
  const p = await rt.store.project.insert({
    name: "PharmaWatch",
    goal: "Watch pharma news",
    autonomy_level: 2,
    settings: { members: [rt.agent.id] },
  });
  return p.id;
}

/** "set autonomy for PharmaWatch to N" in Chat, as the Chat page sends it. */
async function chat(d: Daemon, text: string): Promise<ChatReplyView> {
  const r = await d.req("/chat", {
    method: "POST",
    body: JSON.stringify({ humanId: d.rt.human.id, agentId: d.rt.agent.id, text }),
  });
  expect(r.status).toBe(200);
  return ChatReplyView.parse(await r.json());
}

/** The open request with this id as the Inbox shows it. */
async function shown(d: Daemon, id: string): Promise<HumanRequestView | undefined> {
  const inbox = InboxView.parse(await (await d.req("/inbox")).json());
  return inbox.requests.find((r) => r.id === id && r.status === "open");
}

/** A click on the option the Inbox shows: the body the Inbox page sends. */
async function click(d: Daemon, request: HumanRequestView, option: string): Promise<Response> {
  return d.req(`/requests/${request.id}/answer`, {
    method: "POST",
    body: JSON.stringify({ version: request.version, answer: option }),
  });
}

async function changes(d: Daemon): Promise<ChangeLogView[]> {
  const rows = (await (await d.req("/changes")).json()) as Json[];
  return rows.map((r) => ChangeLogView.parse(r));
}

const autonomyChanges = (rows: ChangeLogView[]) =>
  rows.filter((r) => r.commands.some((c) => (c as { name?: string }).name === "autonomy.set"));

describe("a change card from Chat answered in the Inbox (U-029)", () => {
  const clock = new SimulatedClock("2026-10-31T10:00:00Z");
  const open: RuntimeApp[] = [];
  afterEach(async () => {
    for (const rt of open.splice(0)) await rt.close();
  });

  it("Inbox yes runs the change, with its change log row and undo, on a default local install", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u029-yes-"));
    const d = await daemon(clock, home, "sqlite::memory:");
    open.push(d.rt);
    expect(d.rt.remote.enabled).toBe(false);
    expect(d.rt.remote.watcher).toBeNull();
    const projectId = await project(d.rt);

    const reply = await chat(d, "set autonomy for PharmaWatch to 3");
    expect(reply.pendingConfirmation?.decision).toBe("needs_yes");
    expect(reply.pendingConfirmation?.commands).toEqual(["autonomy.set"]);
    const card = await shown(d, reply.pendingConfirmation?.id ?? "");
    expect(card?.options).toEqual(["yes", "no"]);
    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(2);

    const answered = await click(
      d,
      card as HumanRequestView,
      (card as HumanRequestView).options[0] as string,
    );
    expect(answered.status).toBe(200);

    // The change ran: the project's autonomy, the change log row the Changes page lists, no
    // card left in the Inbox and nothing pending.
    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(3);
    const rows = autonomyChanges(await changes(d));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "chat", undoable: true });
    expect(await shown(d, card?.id ?? "")).toBeUndefined();
    expect(await (await d.req("/commands/pending")).json()).toEqual([]);

    // Its undo works as for any change.
    const undone = CommandResultViewSchema.parse(
      await (await d.req(`/changes/${rows[0]?.id}/undo`, { method: "POST" })).json(),
    );
    expect(undone.status).toBe("done");
    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(2);
  });

  it("Inbox no cancels the change: nothing runs and nothing stays pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u029-no-"));
    const d = await daemon(clock, home, "sqlite::memory:");
    open.push(d.rt);
    const projectId = await project(d.rt);

    const reply = await chat(d, "set autonomy for PharmaWatch to 3");
    const card = (await shown(d, reply.pendingConfirmation?.id ?? "")) as HumanRequestView;
    expect(card.options).toEqual(["yes", "no"]);
    expect((await click(d, card, card.options[1] as string)).status).toBe(200);

    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(2);
    expect(autonomyChanges(await changes(d))).toHaveLength(0);
    expect(await (await d.req("/commands/pending")).json()).toEqual([]);
    expect(await shown(d, card.id)).toBeUndefined();
    // A later yes for the same card finds nothing to run.
    const late = CommandResultViewSchema.parse(
      await (
        await d.req(`/commands/${card.id}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "yes" }),
        })
      ).json(),
    );
    expect(late.status).toBe("refused");
    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(2);
  });

  it("a high-risk card answered with the Inbox's approve option runs as this PC's desktop row; reject cancels", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u029-high-"));
    const d = await daemon(clock, home, "sqlite::memory:");
    open.push(d.rt);
    const projectId = await project(d.rt);
    expect(d.rt.remote.device?.kind).toBe("desktop");

    const high = await chat(d, "set autonomy for PharmaWatch to 4");
    expect(high.pendingConfirmation?.decision).toBe("needs_device");
    const card = (await shown(d, high.pendingConfirmation?.id ?? "")) as HumanRequestView;
    expect(card.options).toEqual(["approve on device", "reject"]);
    expect((await click(d, card, card.options[0] as string)).status).toBe(200);
    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(4);
    expect(autonomyChanges(await changes(d))).toHaveLength(1);

    const back = await chat(d, "set autonomy for PharmaWatch to 0");
    expect(back.pendingConfirmation?.decision).toBe("needs_device");
    const second = (await shown(d, back.pendingConfirmation?.id ?? "")) as HumanRequestView;
    expect((await click(d, second, second.options[1] as string)).status).toBe(200);
    expect((await d.rt.store.project.mustGet(projectId)).autonomy_level).toBe(4);
    expect(await (await d.req("/commands/pending")).json()).toEqual([]);
  });

  it("after a restart a card that can no longer run leaves the Inbox and the person is told to ask again", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u029-restart-"));
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const first = await daemon(clock, home, stateUrl);
    const projectId = await project(first.rt);
    const reply = await chat(first, "set autonomy for PharmaWatch to 3");
    const id = reply.pendingConfirmation?.id ?? "";
    expect(await shown(first, id)).toBeDefined();
    await first.rt.close();

    // The change's closure lived in the daemon that stopped; the card must not stay in the
    // Inbox as a button that does nothing.
    const second = await daemon(clock, home, stateUrl);
    open.push(second.rt);
    expect(await shown(second, id)).toBeUndefined();
    const row = await second.rt.store.humanRequest.mustGet(id);
    expect(row.status).toBe("expired");
    const inbox = InboxView.parse(await (await second.req("/inbox")).json());
    expect(inbox.messages.some((m) => /not made/i.test(m.body) && /ask again/i.test(m.body))).toBe(
      true,
    );
    expect((await second.rt.store.project.mustGet(projectId)).autonomy_level).toBe(2);

    // A third start tells nobody twice.
    await second.rt.close();
    open.splice(0);
    const third = await daemon(clock, home, stateUrl);
    open.push(third.rt);
    const again = InboxView.parse(await (await third.req("/inbox")).json());
    expect(again.messages.filter((m) => /not made/i.test(m.body))).toHaveLength(1);
  });
});
