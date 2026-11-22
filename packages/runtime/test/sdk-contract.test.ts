import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SdkAgentDriver } from "../src/agent/sdk.ts";
import { ClaudeCodeProvider } from "../src/provider/claude-code.ts";
import { budget, flatPricing, harness, issue, registry } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-2: the contract with the real Agent SDK, so the next SDK bump cannot
 * bring back what live check 4 found (LC-C22): Claude Code against a local server that answers
 * every model call with Anthropic's 401. Agent SDK 0.3.304 streams a synthetic error message
 * and an error result, then throws; both consumers must read that as a refused sign-in
 * (`provider_auth`), never as a passing error. The real binary runs here (the SDK's own
 * platform package); the test skips with the reason when it is not installed.
 */
const sdkRequire = (() => {
  try {
    return createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  } catch {
    return null;
  }
})();
/** The SDK's own lookup (sdk.mjs `i9`): `<sdk>-<platform>-<arch>[-musl]/claude[.exe]`. */
function claudeBinary(): string | null {
  if (!sdkRequire) return null;
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const name of [base, `${base}-musl`])
    try {
      const p = sdkRequire.resolve(`${name}/claude${ext}`);
      if (existsSync(p)) return p;
    } catch {
      // not this variant
    }
  return null;
}
const binary = claudeBinary();
const reason = binary
  ? null
  : `the Claude Code binary of @anthropic-ai/claude-agent-sdk for ${process.platform}-${process.arch} is not installed`;
if (reason) console.warn(`sdk-contract skipped: ${reason}`);

// Credential-shaped, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "contract", "1".repeat(40)].join(""); // not-a-secret

let server: Server;
let base = "";
let posts = 0;
const dirs: string[] = [];
/**
 * The settings of a Claude Code that runs this test (`CLAUDECODE`, `CLAUDE_CODE_REMOTE`, ...,
 * a cloud container's `CCR_*` proxy settings) make the Claude Code under test behave as a
 * remote session and wait about two minutes before its first call; a person's computer has
 * none of them. Kept away for this file, then restored.
 */
const HOST_ONLY = /^(CCR_|CLAUDE|https?_proxy$|NODE_EXTRA_CA_CERTS$)/i;
const hidden: Record<string, string> = {};

beforeAll(async () => {
  if (reason) return;
  for (const [k, v] of Object.entries(process.env))
    if (HOST_ONLY.test(k) && v !== undefined) {
      hidden[k] = v;
      delete process.env[k];
    }
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200);
        res.end();
        return;
      }
      posts++;
      res.writeHead(401, { "content-type": "application/json", "request-id": `req_${posts}` });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "OAuth access token is invalid." },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  Object.assign(process.env, hidden);
  if (server) await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "fr-sdk-contract-"));
  dirs.push(d);
  return d;
};
/** Claude Code stays on this machine: no telemetry, no update check, its own home. */
const quiet = (home: string) => ({
  HOME: home,
  USERPROFILE: home,
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // A 401 is retried with backoff by Claude Code itself (about two minutes): once is enough.
  CLAUDE_CODE_MAX_RETRIES: "0",
});

describe.skipIf(reason !== null)(
  "l4-cred-engine, run L4: the real Agent SDK against a local 401",
  () => {
    it("SdkAgentDriver.run reads Claude Code's refusal as provider_auth and books no '<synthetic>' model", async () => {
      const h = harness();
      const cwd = scratch();
      const res = await new SdkAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }).run({
        token: issue(h, { allowedTools: ["cc:Read"], budgetUsdMicro: 2_500_000 }),
        budget: budget("sess-1", 5_000_000, h.clock),
        billingSourceId: "bs",
        credential: { kind: "oauth_token", value: OAUTH },
        model: "claude-haiku-5-5",
        systemPrompt: "Answer briefly.",
        prompt: "Say hi.",
        cwd,
        tools: registry(),
        pricing: flatPricing,
        timeoutMs: 120_000,
        maxTurns: 1,
        baseURL: base,
        env: quiet(cwd),
      });
      expect(res.outcome, JSON.stringify(res.error)).toBe("error");
      expect(res.error?.code, JSON.stringify(res.error)).toBe("provider_auth");
      expect(JSON.stringify(res)).not.toContain(OAUTH);
      expect(h.ledger.entries.map((e) => e.model)).not.toContain("<synthetic>");
      expect(posts).toBeGreaterThan(0);
    }, 150_000);

    it("ClaudeCodeProvider.stream reads it as provider_auth too", async () => {
      const cwd = scratch();
      const p = new ClaudeCodeProvider({ token: async () => OAUTH, cwd, baseURL: base });
      const before: Record<string, string | undefined> = { ...process.env };
      // The provider passes the daemon's own environment (scrubbed): Claude Code's home is a
      // scratch folder here, so it writes nothing of this machine's.
      Object.assign(process.env, quiet(cwd));
      try {
        const out = [];
        for await (const ev of p.stream({
          model: "claude-haiku-5-5",
          max_tokens: 256,
          system: "Answer briefly.",
          messages: [{ role: "user", content: "Say hi." }],
        }))
          out.push(ev);
        const errors = out.filter((e) => e.type === "error") as { code: string }[];
        expect(
          errors.map((e) => e.code),
          JSON.stringify(out),
        ).toEqual(["provider_auth"]);
        expect(JSON.stringify(out)).not.toContain(OAUTH);
      } finally {
        for (const k of Object.keys(quiet(cwd))) {
          const was = before[k];
          if (was === undefined) delete process.env[k];
          else process.env[k] = was;
        }
      }
    }, 150_000);
  },
);
