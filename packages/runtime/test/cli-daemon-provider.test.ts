import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
