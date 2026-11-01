import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { daemonProvider } from "../src/cli/main.ts";

/**
 * `fr daemon --provider <name>`: the install's own provider by default, the echoing fake, and
 * the test bench's development options (scripts/bench/README.md), which load testenv/ from a
 * repository checkout and refuse with the reason anywhere else.
 */
describe("fr daemon --provider", () => {
  const home = () => mkdtempSync(join(tmpdir(), "fr-provider-"));

  it("injects nothing for anthropic or no flag: the install's own credentials decide", async () => {
    expect(await daemonProvider(undefined, {})).toBeUndefined();
    expect(await daemonProvider("anthropic", {})).toBeUndefined();
  });

  it("fake is the echoing shim", async () => {
    expect((await daemonProvider("fake", {}))?.name).toBe("fake");
  });

  it("refuses an unknown name instead of starting with another provider", async () => {
    await expect(daemonProvider("bnech", {})).rejects.toThrow(/unknown provider "bnech"/);
  });

  it("bench refuses with the reason where testenv/ is absent (an installed app)", async () => {
    const missing = pathToFileURL(join(home(), "testenv", "src", "bench", "index.ts"));
    await expect(daemonProvider("bench", {}, missing)).rejects.toThrow(
      /development option of the test bench.*testenv/,
    );
  });

  it("bench is the stand-in model on the ladder's fake rungs, logging to the home", async () => {
    const h = home();
    const p = await daemonProvider("bench", { FORERUNNER_HOME: h, FORERUNNER_BENCH_DELAY_MS: "0" });
    expect(p?.name).toBe("fake");
    const r = await p?.complete({
      model: "fake-haiku",
      messages: [{ role: "user", content: "# Now\n- now: x\n\nhello" }],
      system: "# Projects\n- A",
      max_tokens: 100,
      origin: { label: "conversation", sessionId: "s", runId: "r" },
    });
    expect(JSON.stringify(r?.content)).toContain("[stand-in model]");
    const log = join(h, "bench", "model-calls.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(JSON.parse(readFileSync(log, "utf8").trim()).role).toBe("chat");
  });

  it("bench-live needs a key in the environment and never makes a call to check it", async () => {
    await expect(daemonProvider("bench-live", { FORERUNNER_HOME: home() })).rejects.toThrow(
      /needs ANTHROPIC_API_KEY/,
    );
    const key = ["sk-ant-api03-", "x".repeat(40)].join(""); // not-a-secret
    const p = await daemonProvider("bench-live", {
      FORERUNNER_HOME: home(),
      ANTHROPIC_API_KEY: key,
    });
    expect(p?.name).toBe("anthropic");
  });
});

/**
 * The bench's model-call log on the real `--provider bench-live` path (the live run of
 * 2026-11-01): every line says what it cost in USD from the app's own price table, with the row
 * it used, so the live helper keeps to its spend cap without its own script; and a key in the
 * environment never reaches the file, whole or in part, whatever the API echoes. The Messages
 * API is a local stub answering with the usage the real intake calls had (fixtures).
 */
describe("fr daemon --provider bench-live: the model-call log", () => {
  const home = () => mkdtempSync(join(tmpdir(), "fr-provider-log-"));
  const USAGE = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "live1-intake-usage.json"), "utf8"),
  ) as {
    calls: {
      model: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    }[];
  };
  // Built in parts so the secret scan does not take the test value for a key (not-a-secret).
  const KEY = ["sk-ant-api03-", "Qm7vX2pLr9TzK4wYc8NdB6hJf3", "GsUa5eRk1Vn0MqWtZy"].join("");

  const sse = (events: unknown[]) =>
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");

  async function stubApi(): Promise<{ url: string; keys: string[]; close: () => Promise<void> }> {
    const keys: string[] = [];
    let n = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        keys.push(String(req.headers["x-api-key"] ?? ""));
        const i = n++;
        const call = USAGE.calls[i];
        if (!call) {
          // An error that quotes part of the key, as a careless proxy might.
          res.writeHead(401, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "authentication_error",
                message: `invalid x-api-key ending in ${KEY.slice(-14)}`,
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          sse([
            {
              type: "message_start",
              message: {
                id: `m${i}`,
                type: "message",
                role: "assistant",
                model: call.model,
                content: [],
                stop_reason: null,
                usage: { ...call.usage, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            // A reply that echoes the key and a piece of it must not get either into the log.
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: `{"plan": "x", "k": "${KEY}", "part": "${KEY.slice(20, 34)}"}`,
              },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: call.usage.output_tokens },
            },
            { type: "message_stop" },
          ]),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      keys,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("prices each line from the app's table, sums to what the live run cost, and writes no part of the key", async () => {
    const api = await stubApi();
    try {
      const h = home();
      const p = await daemonProvider("bench-live", {
        FORERUNNER_HOME: h,
        ANTHROPIC_API_KEY: KEY,
        FORERUNNER_BENCH_LIVE_API: api.url,
      });
      const ask = (i: number) =>
        p?.complete({
          model: "claude-sonnet-5-5",
          system: "You are the project manager.",
          messages: [{ role: "user", content: `plan ${i}` }],
          max_tokens: 8000,
          origin: { label: `intake p${i}`, sessionId: `s${i}`, runId: `r${i}` },
        });
      for (let i = 0; i < USAGE.calls.length; i++) await ask(i);
      // One more call that the API refuses with a message quoting part of the key.
      await Promise.resolve(ask(99)).catch(() => undefined);
      // The provider sent the key the environment holds.
      expect(api.keys).toHaveLength(USAGE.calls.length + 1);
      expect(api.keys.every((k) => k === KEY)).toBe(true);

      const raw = readFileSync(join(h, "bench", "model-calls.jsonl"), "utf8");
      const lines = raw
        .trim()
        .split("\n")
        .map(
          (l) =>
            JSON.parse(l) as {
              role: string;
              usd: number | null;
              price: Record<string, unknown> | null;
              reply: { error?: { message: string } };
            },
        );
      expect(lines).toHaveLength(USAGE.calls.length + 1);
      const priced = lines.slice(0, USAGE.calls.length);
      // The row the app bills Sonnet 5.5 with (packages/billing/src/pricing.ts).
      for (const l of priced) {
        expect(l.role).toBe("intake");
        expect(l.price).toEqual({
          model: "claude-sonnet-5-5",
          input_per_mtok_usd: 2,
          output_per_mtok_usd: 10,
          cache_read_per_mtok_usd: 0.2,
          cache_write_per_mtok_usd: 2.5,
          source: "list",
          as_of: "2026-10-06",
        });
      }
      // The first intake: 137 in, 5,783 out, 2,195 written to the cache.
      expect(priced[0]?.usd).toBeCloseTo(0.063592, 6);
      // The six intakes of the live run cost USD 0.353 by the helper's own pricing.
      const total = priced.reduce((s, l) => s + (l.usd ?? 0), 0);
      expect(total).toBeCloseTo(0.353, 3);
      // No part of the key: neither whole, nor any 8 characters of it in a row.
      for (let i = 0; i + 8 <= KEY.length; i++) expect(raw).not.toContain(KEY.slice(i, i + 8));
      expect(lines.at(-1)?.reply.error?.message ?? "").toContain("[REDACTED]");
    } finally {
      await api.close();
    }
  });

  it("the stand-in's lines say why they have no price (its fake rungs have none)", async () => {
    const h = home();
    const p = await daemonProvider("bench", { FORERUNNER_HOME: h, FORERUNNER_BENCH_DELAY_MS: "0" });
    await p?.complete({
      model: "fake-haiku",
      messages: [{ role: "user", content: "# Now\n- now: x\n\nhello" }],
      system: "# Projects\n- A",
      max_tokens: 100,
      origin: { label: "conversation", sessionId: "s", runId: "r" },
    });
    const line = JSON.parse(readFileSync(join(h, "bench", "model-calls.jsonl"), "utf8").trim()) as {
      usd: number | null;
      priceError?: string;
    };
    expect(line.usd).toBeNull();
    expect(line.priceError).toMatch(/no price known for model "fake-haiku"/);
  });
});
