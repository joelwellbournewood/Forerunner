import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { StartCheckView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { chatHoldReply } from "../src/session/credential-words.ts";
import { credWorld, seedProject, setPolicy } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-8 (live check 4, L4-creds-3; C5L-C3-left-4): with a refused key, chat
 * said "I can still add, move and start tasks" while the Start dialog's Start was off, and chat's
 * "start a session" was read back and "started" while the dialog refused it. Composed as `fr
 * daemon` composes it (no injected provider): the only credential is a key the Messages API
 * stand-in refuses, through POST /chat as the Chat tab sends it.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const REFUSED_KEY_REPLY =
  "Anthropic refused your API key, so I have not answered. Save a new key in Settings; until then I can still add and change tasks.";

describe("l4-cred-engine, run L4: chat under a refused credential follows the Start dialog", () => {
  it("key_only with a refused key: the hold reply promises no start, and chat's start is refused with the dialog's sentence", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, subscription: false, prefix: "fr-chat-refused-" });
    homes.push(world.home);
    world.setKey("refused");
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "key_only");
      const { project } = await seedProject(rt, "Field notes", ["Write notes/field.md"]);
      const chat = async (text: string) =>
        (
          await req<{ reply: string; pendingConfirmation: unknown }>("/chat", {
            humanId: rt.human.id,
            agentId: rt.agent.id,
            projectId: project.id,
            projectTab: true,
            text,
            source: "text",
          })
        ).body;

      const asked = await chat("What is next on this project?");
      expect(asked.reply).toBe(REFUSED_KEY_REPLY);
      expect(asked.reply.toLowerCase()).not.toContain("start");
      // Asked again: held before any call, the same words; the refused key gets no new request.
      const calls = world.keyCalls().length;
      expect((await chat("And after that?")).reply).toBe(REFUSED_KEY_REPLY);
      expect(world.keyCalls().length).toBe(calls);

      // The Start dialog refuses, and chat's start says the dialog's sentence with no read-back.
      const check = (await req<StartCheckView>(`/projects/${project.id}/start-check`)).body;
      expect(check.blocked?.sentence).toBe(
        "Nothing can run until you save a new API key in Settings.",
      );
      const start = await chat("start a session");
      expect(start.reply).toBe(check.blocked?.sentence);
      expect(start.reply).not.toMatch(/Start a session on/);
      expect(start.pendingConfirmation ?? null).toBeNull();
      // No work session began (the conversation keeps its own row, "conversation").
      const sessions = await rt.store.session.list({ project_id: project.id } as never);
      expect(sessions.filter((s) => s.summary !== "conversation")).toHaveLength(0);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);

  // fixup-l4-cred-engine (review of L4-creds-8): the usual way a person meets a refusal is the
  // Start they pressed: the run meets it, files the card, and the session ends kept to go on
  // (S-10). Before, chat's "start a session" then said 'Your session of 10:00 goes on by itself
  // once its Claude credential is back.', which names no action, while the Start dialog on
  // screen said 'Nothing can run until you save a new API key in Settings.' with Start off.
  const chatOf =
    (req: Awaited<ReturnType<ReturnType<typeof credWorld>["compose"]>>["req"], rt: RuntimeApp) =>
    async (projectId: string, text: string) =>
      (
        await req<{ reply: string; pendingConfirmation: unknown }>("/chat", {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          projectId,
          projectTab: true,
          text,
          source: "text",
        })
      ).body;
  const workSessions = async (rt: RuntimeApp, projectId: string) =>
    (await rt.store.session.list({ project_id: projectId } as never)).filter(
      (s) => s.summary !== "conversation",
    );

  it("a refused key met by the person's Start: chat's start says the dialog's sentence, also after a restart", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, subscription: false, prefix: "fr-chat-refused-kept-" });
    homes.push(world.home);
    world.setKey("refused");
    let { rt, req } = await world.compose();
    let projectId = "";
    try {
      await setPolicy(rt, "key_only");
      const { project } = await seedProject(rt, "Field notes", ["Write notes/field.md"]);
      projectId = project.id;
      // As the Start dialog sends it; the run meets the refusal and ends to wait.
      const started = await req<Record<string, unknown>>("/sessions", {
        agentId: rt.agent.id,
        projectId,
        trigger: "manual",
      });
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      await settleSessions(rt);
      expect(await workSessions(rt, projectId)).toHaveLength(1);
      // The person's session is kept to go on (S-10) while the dialog refuses a new Start.
      expect(await rt.continuations.waiting(projectId)).toMatch(
        /^Your session of .+ goes on by itself/,
      );
      const check = (await req<StartCheckView>(`/projects/${projectId}/start-check`)).body;
      expect(check.blocked?.sentence).toBe(
        "Nothing can run until you save a new API key in Settings.",
      );
      const calls = world.keyCalls().length;
      const start = await chatOf(req, rt)(projectId, "start a session");
      expect(start.reply).toBe(check.blocked?.sentence);
      expect(start.pendingConfirmation ?? null).toBeNull();
      expect(await workSessions(rt, projectId)).toHaveLength(1);
      expect(world.keyCalls().length).toBe(calls);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
    // Forerunner opens again: the kept session and the refusal are read from the store.
    ({ rt, req } = await world.compose());
    try {
      const check = (await req<StartCheckView>(`/projects/${projectId}/start-check`)).body;
      expect(check.blocked?.sentence).toBe(
        "Nothing can run until you save a new API key in Settings.",
      );
      const start = await chatOf(req, rt)(projectId, "start a session");
      expect(start.reply).toBe(check.blocked?.sentence);
      expect(start.pendingConfirmation ?? null).toBeNull();
      expect(await workSessions(rt, projectId)).toHaveLength(1);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 90_000);

  it("a refused sign-in met by the person's Start: chat's start says the dialog's sentence", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, key: false, prefix: "fr-chat-refused-signin-" });
    homes.push(world.home);
    world.refuseSubscription();
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_wait");
      const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
      const started = await req<Record<string, unknown>>("/sessions", {
        agentId: rt.agent.id,
        projectId: project.id,
        trigger: "manual",
      });
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      await settleSessions(rt);
      expect(await workSessions(rt, project.id)).toHaveLength(1);
      const check = (await req<StartCheckView>(`/projects/${project.id}/start-check`)).body;
      expect(check.blocked?.sentence).toBe(
        "Nothing can run until you save a new Claude sign-in in Settings.",
      );
      const calls = world.sdkCalls.length;
      const start = await chatOf(req, rt)(project.id, "start a session");
      expect(start.reply).toBe(check.blocked?.sentence);
      expect(start.pendingConfirmation ?? null).toBeNull();
      expect(await workSessions(rt, project.id)).toHaveLength(1);
      expect(world.sdkCalls.length).toBe(calls);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 90_000);

  it("the hold reply by reason: a refused sign-in says to sign in again; a limit promises no start", () => {
    expect(chatHoldReply({ reason: "refused", kind: "api_key" }, null)).toBe(REFUSED_KEY_REPLY);
    expect(chatHoldReply({ reason: "refused", kind: "subscription" }, null)).toBe(
      "Anthropic refused your Claude sign-in, so I have not answered. Sign in again in Settings; until then I can still add and change tasks.",
    );
    expect(chatHoldReply({ reason: "limit", kind: "subscription" }, "15:40")).toBe(
      "Your Claude subscription is at its limit until 15:40, so I have not answered. I can still add and change tasks.",
    );
    expect(chatHoldReply({ reason: "share", kind: "subscription" }, "1 Dec")).toBe(
      "Your Claude subscription is at the share Forerunner may use until 1 Dec, so I have not answered. I can still add and change tasks.",
    );
    expect(chatHoldReply({ reason: "key_month", kind: "api_key" }, "1 Dec")).toBe(
      "Your API key is at its monthly cap until 1 Dec, so I have not answered. I can still add and change tasks.",
    );
  });
});
