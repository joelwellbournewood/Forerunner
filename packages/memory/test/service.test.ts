import { mkdir, writeFile } from "node:fs/promises";
import { isForerunnerError, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantFor, MemoryService } from "../src/service.ts";
import { estimateTokens } from "../src/types.ts";
import { DAY_MS, TEXTS, type World, world } from "./helpers.ts";

describe("MemoryService", () => {
  let w: World;
  let svc: MemoryService;
  beforeEach(async () => {
    w = await world();
    svc = new MemoryService(w.ctx);
  });
  afterEach(async () => {
    await w.close();
  });

  const writeInstructions = async (agentId: string, text: string) => {
    const dir = w.files.scopeRoot("agent_private", agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instructions.md"), text, "utf8");
  };

  it("rememberFromSession records valid lessons, rejects the rest and writes the catalog", async () => {
    const res = await svc.rememberFromSession({
      agentId: w.alice,
      sessionId: "ses_1",
      projectId: w.project,
      lessons: [
        { text: TEXTS.windows, tags: ["windows"], confidence: 0.7 },
        { text: "nope", tags: ["x"] },
        { text: TEXTS.vault, tags: ["Vault"] },
        { text: TEXTS.vitest, pinned: true },
      ],
    });
    expect(res.recorded.map((r) => r.action)).toEqual(["inserted", "inserted"]);
    expect(res.rejected).toEqual([
      { text: "nope", error: expect.stringMatching(/invalid lesson/) },
      { text: TEXTS.vault, error: expect.stringMatching(/kebab/) },
    ]);
    for (const r of res.recorded) {
      expect(r.lesson.scope).toBe("agent_private");
      expect(r.lesson.owner_agent_id).toBe(w.alice);
      expect(r.lesson.author_agent).toBe(w.alice);
      expect(r.lesson.source).toBe("session:ses_1");
      expect(r.lesson.project_id).toBe(w.project);
    }
    expect(res.recorded[1]?.lesson.pinned).toBe(true);
    expect(
      await w.files.exists(join(w.files.scopeRoot("agent_private", w.alice), "catalog.md")),
    ).toBe(true);

    const critic = await svc.rememberFromSession({
      agentId: w.critic,
      sessionId: "ses_2",
      scope: "critic",
      lessons: [{ text: TEXTS.budget, source: "review:rev_9" }],
    });
    expect(critic.recorded[0]?.lesson.scope).toBe("critic");
    expect(critic.recorded[0]?.lesson.owner_agent_id).toBeNull();
    expect(critic.recorded[0]?.lesson.source).toBe("review:rev_9");
  });

  it("recallForSession loads standing notes first, then lessons as data, under the budget", async () => {
    await writeInstructions(w.alice, "Prefer small PRs.\nAsk before spending money.\n");
    await svc.rememberFromSession({
      agentId: w.alice,
      sessionId: "ses_1",
      projectId: w.project,
      lessons: [{ text: TEXTS.windows, tags: ["windows"] }],
    });
    await svc.rememberFromSession({
      agentId: w.critic,
      sessionId: "ses_1",
      scope: "shared",
      lessons: [{ text: TEXTS.budget, tags: ["budget"] }],
    });
    const memory = await svc.recallForSession({
      grant: grantFor("principal", w.alice),
      projectId: w.project,
      brief: "Fix the Windows CI job and watch the budget",
      tags: ["windows", "budget"],
      maxTokens: 300,
    });
    expect(memory.instructions).toBe("Prefer small PRs.\nAsk before spending money.");
    expect(memory.block.startsWith("# Standing notes\nPrefer small PRs.")).toBe(true);
    expect(memory.block).toContain("# Lessons from memory");
    expect(memory.block.indexOf("## private")).toBeLessThan(memory.block.indexOf("## shared"));
    expect(memory.result.lessons.map((l) => l.lesson.text).sort()).toEqual(
      [TEXTS.budget, TEXTS.windows].sort(),
    );
    expect(memory.tokens).toBe(estimateTokens(memory.block));
    expect(memory.tokens).toBeLessThanOrEqual(300);
    expect(memory.result.maxTokens).toBeLessThan(300);

    const tight = await svc.recallForSession({
      grant: grantFor("principal", w.alice),
      projectId: w.project,
      brief: "Fix the Windows CI job",
      tags: ["windows", "budget"],
      maxTokens: 60,
    });
    expect(tight.tokens).toBeLessThanOrEqual(60);
    expect(tight.block).toContain("# Standing notes");
  });

  it("refuses when instructions.md alone exceeds the budget, and an empty grant yields nothing", async () => {
    await writeInstructions(w.alice, "x".repeat(400));
    try {
      await svc.recallForSession({
        grant: grantFor("principal", w.alice),
        brief: "b",
        maxTokens: 50,
      });
      throw new Error("expected a throw");
    } catch (e) {
      expect(isForerunnerError(e, "budget_exceeded")).toBe(true);
    }
    const none = await svc.recallForSession({
      grant: grantFor("specialist", "agt_spec"),
      brief: "b",
    });
    expect(none).toEqual({
      block: "",
      instructions: "",
      tokens: 0,
      result: expect.objectContaining({ lessons: [], tokensUsed: 0 }),
    });
  });

  it("4 simulated weeks: repeated findings become lessons that later sessions recall under budget", async () => {
    const findings = [
      {
        tag: "windows-paths",
        text: "Path separators broke the Windows CI job; run the Windows job before merging path changes.",
      },
      {
        tag: "secret-logging",
        text: "A vault secret value reached a log line; log secret names only, never their values.",
      },
      {
        tag: "temp-dirs",
        text: "Filesystem tests shared one temp directory and raced; create one temp directory per test.",
      },
    ];
    const budget = 400;
    const repeats: number[] = [];
    const tokens: number[] = [];
    for (let week = 1; week <= 4; week++) {
      // Session start: the principal recalls what earlier sessions learned about this project.
      const memory = await svc.recallForSession({
        grant: grantFor("principal", w.alice),
        projectId: w.project,
        brief: "Session: fix the CI pipeline, the secret handling and the filesystem tests.",
        tags: findings.map((f) => f.tag),
        maxTokens: budget,
      });
      tokens.push(memory.tokens);
      expect(memory.tokens).toBeLessThanOrEqual(budget);
      // A finding repeats when no recalled lesson covers it.
      const covered = new Set(memory.result.lessons.flatMap((l) => l.lesson.tags));
      const repeated = findings.filter((f) => !covered.has(f.tag));
      repeats.push(repeated.length);
      // Session end: the critic turns each repeated finding into a shared project lesson.
      const recorded = await svc.rememberFromSession({
        agentId: w.critic,
        sessionId: `ses_${week}`,
        projectId: w.project,
        scope: "shared",
        lessons: repeated.map((f) => ({
          text: f.text,
          tags: [f.tag, "ci"],
          confidence: 0.8,
          source: `review:rev_${week}`,
        })),
      });
      expect(recorded.rejected).toEqual([]);
      await w.clock.advance(7 * DAY_MS);
    }
    expect(repeats).toEqual([3, 0, 0, 0]);
    expect(tokens[0]).toBe(0);
    expect(Math.max(...tokens)).toBeLessThanOrEqual(budget);

    const active = await w.store.lesson.list({ scope: "shared", status: "active" });
    expect(active).toHaveLength(3);
    for (const l of active) {
      expect(l.hit_count).toBe(3);
      expect(l.last_used).toBe(new Date(w.clock.now() - 7 * DAY_MS).toISOString());
    }
    // Recording the same findings again merges into the existing lessons instead of duplicating.
    const again = await svc.rememberFromSession({
      agentId: w.critic,
      sessionId: "ses_5",
      projectId: w.project,
      scope: "shared",
      lessons: findings.map((f) => ({ text: f.text, tags: [f.tag] })),
    });
    expect(again.recorded.map((r) => r.action)).toEqual(["merged", "merged", "merged"]);
    expect(await w.store.lesson.list({ scope: "shared", status: "active" })).toHaveLength(3);
  });
});
