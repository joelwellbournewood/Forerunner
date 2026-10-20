import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_REQUESTS } from "../src/setup/validators.ts";
import { runSetup, SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * Requirements close-out for the guided setup wizard (spec A.5): every credential request
 * says what, why, the exact scopes, where to click and how it will be verified; a pasted value
 * is validated at once, stored in the vault by name only when it passes, and never echoed.
 */

// Credential-shaped values built by concatenation so no scanner sees a token. // not-a-secret
const REJECTED_TOKEN = ["github_pat_", "closeout_rejected_", "0".repeat(40)].join(""); // not-a-secret
const ACCEPTED_TOKEN = ["github_pat_", "closeout_accepted_", "1".repeat(40)].join(""); // not-a-secret

type Route = (init?: RequestInit) => Response;

function router(routes: Record<string, Route>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const handler = routes[url.pathname];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function home() {
  const dir = mkdtempSync(join(tmpdir(), "fr-closeout-setup-"));
  const env = { FORERUNNER_HOME: dir };
  return { env, dirs: appDirs({ env }) };
}

describe("closeout: guided setup wizard (A.5)", () => {
  it("every credential request says what, why, the exact scopes, where to click and how it is verified", () => {
    const kinds = Object.keys(CREDENTIAL_REQUESTS).sort();
    expect(kinds).toEqual(["anthropic", "github", "subscription"]);
    for (const req of Object.values(CREDENTIAL_REQUESTS)) {
      expect(req.name.trim().length).toBeGreaterThan(0);
      expect(req.what.trim().length).toBeGreaterThan(20);
      expect(req.why.trim().length).toBeGreaterThan(20);
      expect(req.scopes.length).toBeGreaterThan(0);
      expect(req.scopes.every((s) => s.trim().length > 0)).toBe(true);
      expect(req.whereToClick.trim().length).toBeGreaterThan(10);
      expect(req.howVerified.trim().length).toBeGreaterThan(20);
    }
    // The GitHub request names the fine-grained permissions one by one.
    expect(CREDENTIAL_REQUESTS.github.scopes.join("\n")).toMatch(/Contents: read and write/);
    expect(CREDENTIAL_REQUESTS.github.scopes.join("\n")).toMatch(/Pull requests: read and write/);
    expect(CREDENTIAL_REQUESTS.github.whereToClick).toContain("Fine-grained tokens");
    expect(CREDENTIAL_REQUESTS.github.howVerified).toContain("GET /user");
  });

  it("the interactive wizard shows the five parts, validates on paste, and a rejected token is neither stored nor echoed", async () => {
    const { env, dirs } = home();
    const vault = new MemoryVault();
    const prompts: { question: string; secret: boolean }[] = [];
    const report = await runSetup(vault, {
      nonInteractive: false,
      dirs,
      env,
      repos: ["o/a"],
      githubApiBase: "http://gh.test",
      anthropicApiBase: "http://an.test",
      fetchImpl: router({ "/user": () => new Response("", { status: 401 }) }),
      prompt: async (question, secret) => {
        prompts.push({ question, secret });
        return prompts.length === 1 ? REJECTED_TOKEN : "";
      },
    });
    const first = prompts[0];
    expect(first?.secret).toBe(true);
    for (const part of ["What:", "Why:", "Scopes:", "Where:", "Verified:"]) {
      expect(first?.question).toContain(part);
    }
    expect(first?.question).toContain(CREDENTIAL_REQUESTS.github.what);
    expect(first?.question).toContain(CREDENTIAL_REQUESTS.github.why);
    expect(first?.question).toContain(CREDENTIAL_REQUESTS.github.scopes.join("; "));
    expect(first?.question).toContain(CREDENTIAL_REQUESTS.github.whereToClick);
    expect(first?.question).toContain(CREDENTIAL_REQUESTS.github.howVerified);
    // Validated on paste: the 401 is explained, nothing is stored, setup is not complete.
    expect(report.results.github?.ok).toBe(false);
    expect(report.results.github?.problems.length).toBeGreaterThan(0);
    expect(await vault.has(SECRET_NAMES.github)).toBe(false);
    expect(report.stored).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.config.credentials.github).toBe(false);
    // The value never comes back: not in the report, not in later prompts, not in the config file.
    const everything = [JSON.stringify(report), ...prompts.map((p) => p.question)].join("\n");
    expect(everything).not.toContain(REJECTED_TOKEN);
    expect(readFileSync(report.configPath, "utf8")).not.toContain(REJECTED_TOKEN);
    // The other requests were shown with the same five parts.
    expect(prompts.map((p) => p.question.split("\n")[1])).toEqual([
      CREDENTIAL_REQUESTS.github.name,
      CREDENTIAL_REQUESTS.anthropic.name,
      CREDENTIAL_REQUESTS.subscription.name,
    ]);
    for (const p of prompts) {
      for (const part of ["What:", "Why:", "Scopes:", "Where:", "Verified:"]) {
        expect(p.question).toContain(part);
      }
    }
  });

  it("a pasted token that validates is stored in the vault under its name and nowhere else", async () => {
    const { env, dirs } = home();
    const vault = new MemoryVault();
    const seen: { auth: string | null }[] = [];
    const report = await runSetup(vault, {
      nonInteractive: false,
      dirs,
      env,
      repos: ["o/a"],
      githubApiBase: "http://gh.test",
      anthropicApiBase: "http://an.test",
      fetchImpl: router({
        "/user": (init) => {
          seen.push({ auth: new Headers(init?.headers).get("authorization") });
          return json({ login: "j" });
        },
        "/repos/o/a": () => json({ permissions: { pull: true, push: true, admin: false } }),
      }),
      prompt: async (question) =>
        question.includes(CREDENTIAL_REQUESTS.github.name) ? ACCEPTED_TOKEN : "",
    });
    expect(report.results.github?.ok).toBe(true);
    expect(seen).toEqual([{ auth: `Bearer ${ACCEPTED_TOKEN}` }]);
    expect(report.stored).toEqual([SECRET_NAMES.github]);
    expect(await vault.get(SECRET_NAMES.github)).toBe(ACCEPTED_TOKEN);
    expect(report.config.credentials.github).toBe(true);
    expect(report.skipped).toContain("anthropic");
    expect(JSON.stringify(report)).not.toContain(ACCEPTED_TOKEN);
    expect(readFileSync(report.configPath, "utf8")).not.toContain(ACCEPTED_TOKEN);
  });
});
