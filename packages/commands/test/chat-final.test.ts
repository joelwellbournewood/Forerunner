import { describe, expect, it } from "vitest";
import { saidInLine } from "../src/commands/shared.ts";
import { CommandExecutor } from "../src/index.ts";
import { type World, world } from "./helpers.ts";

/**
 * l4-chat-final, run L4. L4h-left-1 (session lead decision 2026-11-24: "a note is the person's
 * when its words are in the person's own message; a note the model wrote without them is read
 * back", L4f's rule refined). In chat every note reaches a command through the model's call, so
 * before, every note in chat was the model's: "try the digest page again and tell it to use the
 * old layout" was read back as the model's note, said "The note goes into its next brief." and
 * was queued as the agent's. The person's own words in a chat note stay the person's.
 */

const PERSONS_LINE = "try the digest page again and tell it to use the old layout";
const PERSONS_NOTE = "Use the old layout.";
const MODEL_NOTE = "Put on hold by the person.";

async function failedWithCard(w: World, risk: "medium" | "high" = "medium") {
  const task = await w.store.task.insert({
    project_id: w.pharma.id,
    title: "Write the digest page",
    outcome: "digest.html",
    status: "failed",
  });
  const card = await w.store.humanRequest.insert({
    kind: "approval",
    why: '"Write the digest page" failed: the model did not answer.',
    options: ["Try again", "Mark done anyway", "Cancel task"],
    human_id: w.human.id,
    project_id: w.pharma.id,
    task_id: task.id,
    risk,
    blocking: true,
  });
  w.ports.cardWords = async (r) =>
    r.id === card.id
      ? {
          title:
            risk === "high"
              ? '"Write the digest page" failed 4 times'
              : '"Write the digest page" failed',
          choices: [
            { label: "Try again", explain: "Starts a session that tries again.", input: "note" },
            { label: "Mark done anyway", explain: null, input: null },
            { label: "Cancel task", explain: null, input: null },
          ],
          outcome: null,
        }
      : null;
  return { task, card };
}

async function readyTask(w: World, title: string) {
  return w.store.task.insert({
    project_id: w.pharma.id,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 1,
    status: "ready",
    priority: 5,
    reason: "planned",
    author_agent: w.agent.id,
  } as never);
}

function restarted(w: World) {
  return async () => {
    const again = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    const open = await w.store.humanRequest.list({ status: "open", kind: "approval" } as never, {
      limit: 50,
    });
    const armed = await again.restorePending(open, async (stored) => ({
      ...w.ctx(),
      actor: stored.actor,
      humanId: stored.humanId,
      agentId: stored.agentId,
      activeProjectId: stored.activeProjectId,
      source: stored.source,
      wordsUsed: stored.wordsUsed,
    }));
    return { again, armed };
  };
}

describe("l4-chat-final, run L4: the person's own words in a chat note stay the person's (L4h-left-1)", () => {
  it("whose words: the note's words, together and in order, in the person's line; case and punctuation do not matter; not right after a turning word of its clause", () => {
    expect(saidInLine(PERSONS_LINE, PERSONS_NOTE)).toBe(true);
    expect(saidInLine('pause it, note: "Wait for the logo"', "wait for the logo")).toBe(true);
    expect(
      saidInLine("Pause it. Don’t skip the intro; use the old layout", "use the old layout"),
    ).toBe(true);
    // Words the person never said, or said apart, or turned around.
    expect(saidInLine("the logo is late, so publishing must wait", MODEL_NOTE)).toBe(false);
    expect(saidInLine("use the layout that is old", "use the old layout")).toBe(false);
    expect(saidInLine("pause it but don't tell it to skip the intro", "skip the intro")).toBe(
      false,
    );
    expect(saidInLine("try it again without the old layout", "the old layout")).toBe(false);
    expect(
      saidInLine("versuch es nochmal, aber nicht mit dem alten Layout", "mit dem alten Layout"),
    ).toBe(false);
    expect(saidInLine(PERSONS_LINE, "  ")).toBe(false);
  });

  it("a move with the person's own words as its note: no note in the read-back, 'Your note' after the yes, queued as the person's, and its reason is the person's words", async () => {
    const w = await world();
    const faq = await readyTask(w, "Write the FAQ");
    const agent = { kind: "agent", id: w.agent.id } as const;
    const asked = await w.executor.execute({
      name: "task.pause",
      params: { task: "Write the FAQ", note: "Wait for the logo." },
      ctx: w.ctx({
        actor: agent,
        source: "chat",
        onPersonsWords: true,
        wordsUsed: "pause the FAQ and tell it to wait for the logo",
      }),
    });
    if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
    expect(asked.readback).toBe(
      'Pause "Write the FAQ"? No session runs it until you press Resume.',
    );
    const yes = await w.executor.confirmByText(asked.pendingId, "yes", w.ctx().actor);
    expect((yes as { sentence: string }).sentence).toBe(
      'Paused "Write the FAQ": no session runs it until you press Resume. Your note goes into its next brief.',
    );
    const notes = await w.store.queue.list({ project_id: w.pharma.id } as never, { limit: 10 });
    expect(notes.map((n) => [n.author_human, n.author_agent])).toEqual([[w.human.id, null]]);
    await w.store.close();
    void faq;
  });

  it("a note the model wrote without the person's words is read back, 'The note' after the yes and the agent's, its words never the task's reason (L4h-left-6)", async () => {
    const w = await world();
    const faq = await readyTask(w, "Write the FAQ");
    const agent = { kind: "agent", id: w.agent.id } as const;
    const asked = await w.executor.execute({
      name: "task.pause",
      params: { task: "Write the FAQ", note: MODEL_NOTE },
      ctx: w.ctx({
        actor: agent,
        source: "chat",
        onPersonsWords: true,
        wordsUsed: "the logo is late, so the FAQ must wait",
      }),
    });
    if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
    expect(asked.readback).toBe(
      'Pause "Write the FAQ"? No session runs it until you press Resume. Note for its next brief: "Put on hold by the person."',
    );
    const yes = await w.executor.confirmByText(asked.pendingId, "yes", w.ctx().actor);
    expect((yes as { sentence: string }).sentence).toBe(
      'Paused "Write the FAQ": no session runs it until you press Resume. The note goes into its next brief.',
    );
    const notes = await w.store.queue.list({ project_id: w.pharma.id } as never, { limit: 10 });
    expect(notes.map((n) => [n.author_human, n.author_agent])).toEqual([[null, w.agent.id]]);
    expect((await w.store.task.mustGet(faq.id)).reason).toBe("Paused by you");
    await w.store.close();
  });

  it("a failed task's card: the person's own words answer its Try again with the note, read back without it; after a restart the yes still answers it so", async () => {
    for (const restart of [false, true]) {
      const w = await world();
      const { card } = await failedWithCard(w);
      const asked = await w.executor.execute({
        name: "task.transition",
        params: { task: "digest", to: "ready", note: PERSONS_NOTE },
        ctx: w.ctx({
          actor: { kind: "agent", id: w.agent.id },
          source: "chat",
          onPersonsWords: true,
          wordsUsed: PERSONS_LINE,
        }),
      });
      if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
      expect(asked.card?.command, `restart: ${restart}`).toBe("request.answer");
      expect(asked.readback, `restart: ${restart}`).toBe(
        'Try again ("Write the digest page" failed)? Starts a session that tries again.',
      );
      let executor = w.executor;
      if (restart) {
        const { again, armed } = await restarted(w)();
        expect(armed).toContain(asked.pendingId);
        expect(again.getPending(asked.pendingId)?.readback).toBe(asked.readback);
        executor = again;
      }
      const yes = await executor.confirmByText(asked.pendingId, "yes", w.ctx().actor);
      expect(yes.status, `restart: ${restart}`).toBe("done");
      expect((await w.store.humanRequest.mustGet(card.id)).answer, `restart: ${restart}`).toEqual({
        choice: "Try again",
        note: PERSONS_NOTE,
      });
      await w.store.close();
    }
  });

  it("the person's own words on an option that takes no note keep the move, so their words are kept; the model's own note on it answers the card with the option alone", async () => {
    const w = await world();
    const { task, card } = await failedWithCard(w);
    const agent = { kind: "agent", id: w.agent.id } as const;
    const own = await w.executor.execute({
      name: "task.transition",
      params: { task: "digest", to: "cancelled", note: "the customer dropped the digest" },
      ctx: w.ctx({
        actor: agent,
        source: "chat",
        onPersonsWords: true,
        wordsUsed: "cancel the digest page, the customer dropped the digest",
      }),
    });
    if (own.status !== "pending") throw new Error(JSON.stringify(own));
    expect(own.card?.command).toBe("task.transition");
    const yes = await w.executor.confirmByText(own.pendingId, "yes", w.ctx().actor);
    expect((yes as { sentence: string }).sentence).toMatch(
      / Your note goes into its brief if you reopen it\.$/,
    );
    expect((await w.store.task.mustGet(task.id)).status).toBe("cancelled");
    const notes = await w.store.queue.list({ project_id: w.pharma.id } as never, { limit: 10 });
    expect(notes.map((n) => n.text)).toEqual([
      expect.stringContaining("the customer dropped the digest"),
    ]);
    // The card was withdrawn by the move, as the drawer's Cancel withdraws it.
    expect((await w.store.humanRequest.mustGet(card.id)).status).not.toBe("open");
    await w.store.close();

    const m = await world();
    const second = await failedWithCard(m);
    const model = await m.executor.execute({
      name: "task.transition",
      params: { task: "digest", to: "cancelled", note: MODEL_NOTE },
      ctx: m.ctx({
        actor: { kind: "agent", id: m.agent.id },
        source: "chat",
        onPersonsWords: true,
        wordsUsed: "cancel the digest page",
      }),
    });
    expect(model.card?.command).toBe("request.answer");
    expect((model as { readback: string }).readback).toBe(
      'Cancel task ("Write the digest page" failed)?',
    );
    await m.executor.cancel((model as { pendingId: string }).pendingId, m.ctx().actor);
    expect((await m.store.humanRequest.mustGet(second.card.id)).status).toBe("open");
    await m.store.close();
  });

  // L4h-left-4: a card that needs this computer's OK is answered on the card only; chat files
  // nothing. Before, the reply said nothing of the note the person gave, which went nowhere.
  it("a card that needs this computer's OK: the reply says where the person's note goes, or that it was not kept", async () => {
    const ask = async (to: "ready" | "cancelled", note: string, words: string) => {
      const w = await world();
      const { card } = await failedWithCard(w, "high");
      const r = await w.executor.execute({
        name: "task.transition",
        params: { task: "digest", to, note },
        ctx: w.ctx({
          actor: { kind: "agent", id: w.agent.id },
          source: "chat",
          onPersonsWords: true,
          wordsUsed: words,
        }),
      });
      expect((await w.store.humanRequest.mustGet(card.id)).status).toBe("open");
      expect(await w.store.humanRequest.open({ humanId: w.human.id }, { limit: 10 })).toHaveLength(
        1,
      );
      await w.store.close();
      return r.status === "refused" ? r.reason : `not refused: ${r.status}`;
    };
    expect(await ask("ready", PERSONS_NOTE, PERSONS_LINE)).toBe(
      'Answer it on its card in the Inbox: "Write the digest page" failed 4 times. Nothing else was filed; type your note there with Try again.',
    );
    expect(
      await ask(
        "cancelled",
        "the customer dropped the digest",
        "cancel the digest page, the customer dropped the digest",
      ),
    ).toBe(
      'Answer it on its card in the Inbox: "Write the digest page" failed 4 times. Nothing else was filed, and your note was not kept.',
    );
    expect(await ask("ready", MODEL_NOTE, "try the digest page again")).toBe(
      'Answer it on its card in the Inbox: "Write the digest page" failed 4 times. Nothing else was filed; type the note there with Try again.',
    );
    // No note: as before.
    const w = await world();
    await failedWithCard(w, "high");
    const plain = await w.executor.execute({
      name: "task.transition",
      params: { task: "digest", to: "ready" },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect(plain.status === "refused" ? plain.reason : plain.status).toBe(
      'Answer it on its card in the Inbox: "Write the digest page" failed 4 times. Nothing else was filed.',
    );
    await w.store.close();
  });
});
