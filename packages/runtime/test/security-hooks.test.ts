import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ForerunnerError, isInside, join, resolve } from "@forerunner/platform";
import { MemoryVault, SecretResolver, type Vault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolSpec } from "../src/agent/tools.ts";
import { fileTools } from "../src/daemon/tools.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import type { RunContext } from "../src/enforcement/hooks.ts";
import { KillFileWatcher, writeKillRequest } from "../src/enforcement/killfile.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import {
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  AutoApprove,
} from "../src/enforcement/ports.ts";
import { approvalKey } from "../src/wiring/state-ports.ts";
import { budget, deleteRepoTool, echoTool, harness, issue, registry } from "./helpers.ts";

/**
 * Security review of the enforcement hooks (spec S.1, S.3, S.4, S.6, S.9): path containment
 * with traversal, look-alike prefixes, symlinks and drive letters; the domain allowlist against
 * IP literals, user-info tricks, look-alikes and schemes; approvals (collision and replay);
 * secrets by reference end to end through a real resolver; an audit row for every refusal;
 * the budget against non-finite numbers; the kill file against a malformed request. A test
 * marked `it.fails` is a finding on the current code (comment above it).
 */

const isWindows = process.platform === "win32";

function ctxFor(
  h: ReturnType<typeof harness>,
  token: ReturnType<typeof issue>,
  over: Partial<RunContext> = {},
): RunContext {
  return {
    token,
    budget: budget("sess-1", 5_000_000, h.clock),
    signal: new AbortController().signal,
    runDeadlineMs: h.clock.now() + 600_000,
    phase: "work",
    model: "fake-haiku",
    provider: "fake",
    billingSourceId: "bs",
    approvals: new Set(),
    ...over,
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<ForerunnerError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ForerunnerError) return e;
    throw e;
  }
  throw new Error("expected the hook to refuse");
}

describe("hooks: path containment", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fr-sec-paths-"));
    mkdirSync(join(root, "sub"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses every traversal form and look-alike prefix, allows what is inside, audits each refusal", async () => {
    const h = harness();
    const t = issue(h, { allowedPaths: [root] });
    const ctx = ctxFor(h, t, { cwd: root });
    const tools = registry();
    const read = tools.get("read_file") as ToolSpec;
    const outside = [
      "../x",
      join("..", "..", "etc", "passwd"),
      join(root, "..", "etc", "passwd"),
      join(root, "sub", "..", "..", "x"),
      resolve(tmpdir(), "elsewhere.txt"),
      `${root}2`,
      join(`${root}2`, "x"),
      join(root, "sub", "..", "..", `${root.split(/[\\/]/).pop() ?? ""}2`, "x"),
    ];
    for (const p of outside) {
      const e = await refusal(() => h.hooks.beforeToolCall(ctx, read, { path: p }));
      expect(e.code).toBe("path_not_allowed");
    }
    const denied = h.audit.entries.filter((a) => !a.allowed);
    expect(denied).toHaveLength(outside.length);
    for (const a of denied) {
      expect(a.deniedReason?.startsWith("path_not_allowed")).toBe(true);
      expect(a.tokenId).toBe(t.claims.id);
      expect(a.tool).toBe("read_file");
    }
    for (const p of [
      "a.txt",
      join("sub", "a.txt"),
      join(".", "a.txt"),
      join("sub", "..", "a.txt"),
      root,
      join(root, "sub"),
    ]) {
      const d = await h.hooks.beforeToolCall(ctx, read, { path: p });
      expect(d.allowed).toBe(true);
    }
  });

  it("an array path field is checked element by element", async () => {
    const h = harness();
    const t = issue(h, { allowedPaths: [root], allowedTools: ["read_many"] });
    const readMany: ToolSpec<{ paths: string[] }> = {
      name: "read_many",
      description: "read several files",
      schema: z.object({ paths: z.array(z.string()) }),
      actionClass: "read",
      risk: "low",
      pathFields: ["paths"],
      async execute() {
        return { content: "" };
      },
    };
    const e = await refusal(() =>
      h.hooks.beforeToolCall(ctxFor(h, t, { cwd: root }), readMany, {
        paths: ["a.txt", join("..", "secret.txt")],
      }),
    );
    expect(e.code).toBe("path_not_allowed");
  });

  it("a token without any path root admits no file at all, relative or absolute", async () => {
    const h = harness();
    const t = issue(h, { allowedPaths: [] });
    const read = registry().get("read_file") as ToolSpec;
    for (const p of ["a.txt", join(root, "a.txt"), root]) {
      const e = await refusal(() =>
        h.hooks.beforeToolCall(ctxFor(h, t, { cwd: root }), read, { path: p }),
      );
      expect(e.code).toBe("path_not_allowed");
    }
  });

  it.skipIf(!isWindows)(
    "Windows: another drive letter and a UNC path are outside; case is not",
    async () => {
      const h = harness();
      const t = issue(h, { allowedPaths: ["C:\\fr\\work"] });
      const read = registry().get("read_file") as ToolSpec;
      const ctx = ctxFor(h, t, { cwd: "C:\\fr\\work" });
      for (const p of [
        "D:\\fr\\work\\x",
        "\\\\server\\share\\x",
        "C:\\fr\\work2\\x",
        "C:\\fr\\x",
      ]) {
        const e = await refusal(() => h.hooks.beforeToolCall(ctx, read, { path: p }));
        expect(e.code).toBe("path_not_allowed");
      }
      expect((await h.hooks.beforeToolCall(ctx, read, { path: "c:\\FR\\Work\\x" })).allowed).toBe(
        true,
      );
    },
  );

  it("isInside: prefix look-alikes and dot segments never count as inside", () => {
    expect(isInside(root, `${root}2`)).toBe(false);
    expect(isInside(root, join(`${root}2`, "x"))).toBe(false);
    expect(isInside(root, join(root, "..", "x"))).toBe(false);
    expect(isInside(root, join(root, "sub", "..", "x"))).toBe(true);
    expect(isInside(root, root)).toBe(true);
  });
});

/** Symlink fixtures, made at load time so `skipIf` can see whether this OS allows them. */
const symlinkWorld = (() => {
  const work = mkdtempSync(join(tmpdir(), "fr-sec-worktree-"));
  const outside = mkdtempSync(join(tmpdir(), "fr-sec-outside-"));
  writeFileSync(join(outside, "id_ed25519"), "PRIVATE-KEY-FIXTURE-NOT-A-SECRET\n"); // not-a-secret
  mkdirSync(join(outside, "config"));
  let canSymlink = true;
  try {
    symlinkSync(join(outside, "id_ed25519"), join(work, "link"), "file");
    symlinkSync(join(outside, "config"), join(work, "linkdir"), "dir");
  } catch {
    // Windows without the symlink privilege: the finding cannot be exercised here.
    canSymlink = false;
  }
  return { work, outside, canSymlink };
})();

describe("hooks and the built-in file tools: symlinks", () => {
  const { work, outside, canSymlink } = symlinkWorld;
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  // security finding (high): the path check is lexical (`path.resolve` + `isInside`) and
  // the built-in `read_file` / `write_file` follow symlinks. A repository cloned into the
  // worktree can carry a committed symlink (`link -> ~/.ssh/id_ed25519`,
  // `cfg -> ~/.config/forerunner`): a "read" class tool then reads it at autonomy 0 and a
  // "routine_reversible" write lands outside the worktree. Fix: `realpath` the resolved path
  // (and, for writes, its parent) before the containment check in `inside()` and in the hook.
  it.skipIf(!canSymlink)(
    "security finding: a symlink inside the worktree pointing outside is refused by read_file",
    async () => {
      const h = harness();
      const t = issue(h, { allowedPaths: [work], allowedTools: ["read_file"] });
      const read = fileTools().get("read_file") as ToolSpec;
      let refused = false;
      try {
        const d = await h.hooks.beforeToolCall(ctxFor(h, t, { cwd: work }), read, { path: "link" });
        if (!d.allowed) throw new Error("pending");
        const r = await read.execute(d.input, {
          runId: "r",
          sessionId: "s",
          agentId: "a",
          humanId: "j",
          allowedPaths: [work],
          signal: new AbortController().signal,
          cwd: work,
        });
        refused = r.isError === true || !r.content.includes("PRIVATE-KEY-FIXTURE");
      } catch (e) {
        refused = e instanceof ForerunnerError && e.code === "path_not_allowed";
      }
      expect(refused).toBe(true);
    },
  );

  it.skipIf(!canSymlink)(
    "security finding: write_file through a symlinked directory cannot write outside the worktree",
    async () => {
      const h = harness();
      const t = issue(h, { allowedPaths: [work], allowedTools: ["write_file"], autonomy: 3 });
      const write = fileTools().get("write_file") as ToolSpec;
      let refused = false;
      try {
        const d = await h.hooks.beforeToolCall(ctxFor(h, t, { cwd: work }), write, {
          path: join("linkdir", "planted.json"),
          content: "{}",
        });
        if (!d.allowed) throw new Error("pending");
        const r = await write.execute(d.input, {
          runId: "r",
          sessionId: "s",
          agentId: "a",
          humanId: "j",
          allowedPaths: [work],
          signal: new AbortController().signal,
          cwd: work,
        });
        refused = r.isError === true;
      } catch (e) {
        refused = e instanceof ForerunnerError && e.code === "path_not_allowed";
      }
      let landedOutside = false;
      try {
        readFileSync(join(outside, "config", "planted.json"));
        landedOutside = true;
      } catch {
        landedOutside = false;
      }
      expect(refused && !landedOutside).toBe(true);
    },
  );
});

describe("hooks: domain allowlist", () => {
  const fetchSpec = () => registry().get("fetch") as ToolSpec;

  it("refuses IP literals in every spelling, loopback and link-local included, and audits each", async () => {
    const h = harness();
    const t = issue(h, { allowedDomains: ["*.example.com", "example.com"] });
    const ctx = ctxFor(h, t);
    const urls = [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://0.0.0.0/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/",
      "http://10.0.0.1:8080/",
    ];
    for (const url of urls) {
      const e = await refusal(() => h.hooks.beforeToolCall(ctx, fetchSpec(), { url }));
      expect(e.code).toBe("domain_not_allowed");
    }
    expect(h.audit.entries.filter((a) => !a.allowed)).toHaveLength(urls.length);
  });

  it("refuses look-alikes, user-info and fragment tricks, non-network schemes; allows the real host in any case", async () => {
    const h = harness();
    const t = issue(h, { allowedDomains: ["*.example.com", "example.com"] });
    const ctx = ctxFor(h, t);
    const bad = [
      "https://evil-example.com/",
      "https://example.com.evil.net/",
      "https://EXAMPLE.COM.evil.net/",
      "https://example.com@evil.net/",
      "https://user:pw@evil.net/example.com",
      "https://evil.net/#example.com",
      "https://evil.net/?next=https://example.com",
      "https://evil.net\\@example.com/",
      "https://xn--exmple-cua.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "example.com/../../evil.net",
      "evil.net example.com",
      "",
    ];
    for (const url of bad) {
      const e = await refusal(() => h.hooks.beforeToolCall(ctx, fetchSpec(), { url }));
      expect(e.code).toBe("domain_not_allowed");
    }
    for (const url of [
      "https://API.EXAMPLE.COM/x",
      "https://example.com:8443/x?y=1",
      "https://a.b.example.com/",
      "example.com",
      "api.example.com:443",
    ]) {
      expect((await h.hooks.beforeToolCall(ctx, fetchSpec(), { url })).allowed).toBe(true);
    }
  });

  it("a token without domains reaches nothing, not even an allowed-looking host", async () => {
    const h = harness();
    const t = issue(h, { allowedDomains: [] });
    for (const url of ["https://example.com/", "example.com", "https://127.0.0.1/"]) {
      const e = await refusal(() => h.hooks.beforeToolCall(ctxFor(h, t), fetchSpec(), { url }));
      expect(e.code).toBe("domain_not_allowed");
    }
  });
});

describe("hooks: approvals", () => {
  class ScriptedApprovals implements ApprovalPort {
    readonly requests: ApprovalRequest[] = [];
    constructor(private readonly outcomes: ApprovalOutcome[]) {}
    async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
      this.requests.push(req);
      return this.outcomes.shift() ?? "denied";
    }
  }

  // security finding (medium): the per-run approval key is `tool:<32-bit polynomial hash of
  // the input>` (hooks.ts `stableHash`, the same function as `approvalKey` in
  // wiring/state-ports.ts). It is Java's String.hashCode: substrings of equal length and
  // equal hash ("Aa" and "BB") give the same key, so an approval of `delete_repo {repo:
  // "Aa"}` also admits `delete_repo {repo: "BB"}` without asking. The state-store variant
  // persists the collision for the whole session. Fix: a SHA-256 of the canonical JSON.
  it("security finding: an approval granted for one input does not admit a different input with a colliding key", async () => {
    const approvals = new ScriptedApprovals(["approved", "denied"]);
    const h = harness({ approvals });
    const t = issue(h, { allowedTools: ["delete_repo"], autonomy: 4 });
    const ctx = ctxFor(h, t);
    const first = await h.hooks.beforeToolCall(ctx, deleteRepoTool, { repo: "Aa-org/repo" });
    expect(first.allowed).toBe(true);
    let asked = false;
    try {
      await h.hooks.beforeToolCall(ctx, deleteRepoTool, { repo: "BB-org/repo" });
    } catch (e) {
      asked = e instanceof ForerunnerError && e.code === "approval_required";
    }
    expect(approvals.requests).toHaveLength(2);
    expect(asked).toBe(true);
  });

  it("security finding: the durable approval key (StateApprovals) is collision resistant", () => {
    expect(approvalKey({ tool: "delete_repo", input: { repo: "Aa" } })).not.toBe(
      approvalKey({ tool: "delete_repo", input: { repo: "BB" } }),
    );
  });

  // security finding (low): an approval of an always-human action is reusable for the rest
  // of the run: the same `delete_repo` / purchase / send call runs again and again without a
  // new answer (the key stays in `ctx.approvals`). The resume path needs one reuse (the
  // paused call is re-made after the answer); every further identical call should ask again.
  it("security finding: an approval of an always-human action is consumed by the first execution", async () => {
    const approvals = new ScriptedApprovals(["approved", "approved"]);
    const h = harness({ approvals });
    const t = issue(h, { allowedTools: ["delete_repo"], autonomy: 4 });
    const ctx = ctxFor(h, t);
    const input = { repo: "org/repo" };
    const a = await h.hooks.beforeToolCall(ctx, deleteRepoTool, input);
    expect(a.allowed).toBe(true);
    await h.hooks.afterToolCall(ctx, deleteRepoTool, input, { content: "deleted" });
    await h.hooks.beforeToolCall(ctx, deleteRepoTool, input);
    expect(approvals.requests).toHaveLength(2);
  });

  it("level 0 proposes only: a routine write pauses for the human with an audit row; a read runs", async () => {
    const h = harness({ approvals: new AutoApprove("pending") });
    const t = issue(h, {
      allowedTools: ["write_file", "read_file"],
      allowedPaths: [tmpdir()],
      autonomy: 0,
    });
    const ctx = ctxFor(h, t, { cwd: tmpdir() });
    const d = await h.hooks.beforeToolCall(ctx, registry().get("write_file") as ToolSpec, {
      path: "x",
      text: "y",
    });
    expect(d.allowed).toBe(false);
    const row = h.audit.entries.find((a) => a.tool === "write_file");
    expect(row?.allowed).toBe(false);
    expect(row?.deniedReason).toBe("approval_required: pending");
    const r = await h.hooks.beforeToolCall(ctx, registry().get("read_file") as ToolSpec, {
      path: "x",
    });
    expect(r.allowed).toBe(true);
  });

  it("a denied always-human action is refused and audited; autonomy 4 does not change that", async () => {
    const h = harness({ approvals: new AutoApprove("denied") });
    const t = issue(h, { allowedTools: ["delete_repo"], autonomy: 4, planApproved: true });
    const e = await refusal(() =>
      h.hooks.beforeToolCall(ctxFor(h, t), deleteRepoTool, { repo: "x" }),
    );
    expect(e.code).toBe("approval_required");
    expect(h.audit.entries.at(-1)?.deniedReason).toMatch(/^approval_required/);
  });
});

describe("hooks: secrets by reference, end to end through a real resolver", () => {
  // Random, never credential-shaped; the point is that the *value* never shows anywhere.
  const value = `v-${"7f3a9c".repeat(4)}-${Date.now().toString(36)}`; // not-a-secret

  function countingVault(): { vault: Vault; reads: number } {
    const inner = new MemoryVault({ gh: value });
    const counter = { reads: 0 };
    const vault: Vault = {
      backend: "memory",
      get: async (n) => {
        counter.reads++;
        return inner.get(n);
      },
      set: (n, v) => inner.set(n, v),
      delete: (n) => inner.delete(n),
      list: () => inner.list(),
      has: (n) => inner.has(n),
    };
    return {
      vault,
      get reads() {
        return counter.reads;
      },
    };
  }

  const secretUse: ToolSpec<{ token: string; note?: string; extra?: unknown }> = {
    name: "use_secret",
    description: "uses a secret and echoes it back in several encodings",
    schema: z.object({
      token: z.string(),
      note: z.string().optional(),
      extra: z.unknown().optional(),
    }),
    actionClass: "read",
    risk: "low",
    async execute(input) {
      const t = input.token;
      return {
        content: [
          `raw:${t}`,
          `json:${JSON.stringify({ t })}`,
          `url:${encodeURIComponent(t)}`,
          `b64:${Buffer.from(t).toString("base64")}`,
        ].join("\n"),
      };
    },
  };

  it("a granted reference is injected; the audit rows carry the name and the output is scrubbed in every encoding", async () => {
    const cv = countingVault();
    const h = harness({ secrets: new SecretResolver(cv.vault) });
    const t = issue(h, { allowedTools: ["use_secret"], grantedSecrets: ["gh"] });
    const ctx = ctxFor(h, t);
    const input = { token: "secret:gh", note: "the token is secret:gh (not a ref mid-text)" };
    const d = await h.hooks.beforeToolCall(ctx, secretUse, input);
    expect(d.allowed).toBe(true);
    const resolved = (d as { input: { token: string; note: string } }).input;
    expect(resolved.token).toBe(value);
    expect(resolved.note).toBe(input.note);
    const r = await secretUse.execute(resolved, {
      runId: "r",
      sessionId: "s",
      agentId: "a",
      humanId: "j",
      allowedPaths: [],
      signal: new AbortController().signal,
    });
    expect(r.content).toContain(value);
    const post = await h.hooks.afterToolCall(ctx, secretUse, input, r);
    expect(post.content).not.toContain(value);
    expect(post.content).not.toContain(Buffer.from(value).toString("base64"));
    expect(post.content).not.toContain(encodeURIComponent(value));
    expect(post.content.split("[REDACTED]").length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(h.audit.entries);
    expect(text).not.toContain(value);
    expect(text).toContain("secret:gh");
    expect(cv.reads).toBe(1);
  });

  it("an ungranted reference is refused before the vault is read, with an audit row that names the reference only", async () => {
    const cv = countingVault();
    const h = harness({ secrets: new SecretResolver(cv.vault) });
    const t = issue(h, { allowedTools: ["use_secret"], grantedSecrets: [] });
    const e = await refusal(() =>
      h.hooks.beforeToolCall(ctxFor(h, t), secretUse, { token: "secret:gh" }),
    );
    expect(e.code).toBe("secret_not_granted");
    expect(cv.reads).toBe(0);
    const row = h.audit.entries.at(-1);
    expect(row?.allowed).toBe(false);
    expect(row?.deniedReason).toMatch(/^secret_not_granted/);
    expect(JSON.stringify(h.audit.entries)).not.toContain(value);
  });

  it("references are resolved only as whole strings in arrays and plain objects, never in keys or class instances", async () => {
    const cv = countingVault();
    const h = harness({ secrets: new SecretResolver(cv.vault) });
    const t = issue(h, { allowedTools: ["use_secret"], grantedSecrets: ["gh"] });
    const d = await h.hooks.beforeToolCall(ctxFor(h, t), secretUse, {
      token: "x",
      extra: {
        list: ["secret:gh", { deep: "secret:gh" }],
        "secret:gh": "a key is never a reference",
        when: new Date(0),
        mid: "prefix secret:gh suffix",
        upper: "secret:GH",
      },
    });
    expect(d.allowed).toBe(true);
    const extra = (d as { input: { extra: Record<string, unknown> } }).input.extra;
    expect(extra.list).toEqual([value, { deep: value }]);
    expect(Object.keys(extra)).toContain("secret:gh");
    expect(extra.mid).toBe("prefix secret:gh suffix");
    expect(extra.upper).toBe("secret:GH");
    expect(extra.when).toBeInstanceOf(Date);
    expect(cv.reads).toBe(1);
  });

  // security finding (low): `afterToolCall` scrubs the *output* with the resolver but writes
  // `inputSummary` from the raw input without it; the deny path does the same with
  // `rawInput`. A value the model obtained elsewhere (the SDK path, see security-sdk) and
  // pasted into a later call is then written to the audit log verbatim. Fix: pass both
  // summaries through `secrets.redact` (and the platform `redact`) as a last line.
  it("security finding: a resolved value pasted into a later tool input never reaches the audit log", async () => {
    const cv = countingVault();
    const h = harness({ secrets: new SecretResolver(cv.vault) });
    const t = issue(h, { allowedTools: ["use_secret", "echo"], grantedSecrets: ["gh"] });
    const ctx = ctxFor(h, t);
    await h.hooks.beforeToolCall(ctx, secretUse, { token: "secret:gh" });
    const d = await h.hooks.beforeToolCall(ctx, echoTool, { text: `leaked ${value}` });
    expect(d.allowed).toBe(true);
    await h.hooks.afterToolCall(ctx, echoTool, { text: `leaked ${value}` }, { content: "ok" });
    expect(JSON.stringify(h.audit.entries)).not.toContain(value);
  });
});

describe("hooks: an audit row for every refusal", () => {
  it("allowlist, schema, path, domain, approval and secret refusals each leave exactly one row with the reason and the token id", async () => {
    const h = harness({
      approvals: new AutoApprove("denied"),
      secrets: new SecretResolver(new MemoryVault({ gh: "v-not-granted-anyway" })),
    });
    const t = issue(h, {
      allowedTools: ["read_file", "fetch", "delete_repo", "use_secret"],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
    });
    const ctx = ctxFor(h, t);
    const tools = registry();
    const cases: [string, () => Promise<unknown>][] = [
      [
        "tool_not_allowed",
        () => h.hooks.beforeToolCall(ctx, tools.get("echo") as ToolSpec, { text: "x" }),
      ],
      [
        "validation",
        () => h.hooks.beforeToolCall(ctx, tools.get("read_file") as ToolSpec, { nope: 1 }),
      ],
      [
        "path_not_allowed",
        () => h.hooks.beforeToolCall(ctx, tools.get("read_file") as ToolSpec, { path: "/x" }),
      ],
      [
        "domain_not_allowed",
        () => h.hooks.beforeToolCall(ctx, tools.get("fetch") as ToolSpec, { url: "https://a.b/" }),
      ],
      ["approval_required", () => h.hooks.beforeToolCall(ctx, deleteRepoTool, { repo: "r" })],
      [
        "secret_not_granted",
        () =>
          h.hooks.beforeToolCall(ctx, tools.get("use_secret") as ToolSpec, { token: "secret:gh" }),
      ],
    ];
    for (const [code, fn] of cases) {
      const e = await refusal(fn);
      expect(e.code).toBe(code);
    }
    expect(h.audit.entries).toHaveLength(cases.length);
    for (const [i, row] of h.audit.entries.entries()) {
      expect(row.allowed).toBe(false);
      expect(row.deniedReason?.startsWith(`${cases[i]?.[0]}:`)).toBe(true);
      expect(row.tokenId).toBe(t.claims.id);
      expect(row.costUsdMicro).toBe(0);
    }
  });

  // security finding (low): `beforeToolCall` verifies the token and the kill state before the
  // `deny` helper exists, so a call attempted on a revoked, expired or forged token, or after
  // a stop, is refused without an audit row (spec S.9: "every tool call"). Fix: build the
  // audit row from the unverified claims (token id, run id) for these refusals too.
  it("security finding: a tool call refused because the token was revoked or expired is audited", async () => {
    const h = harness();
    const t = issue(h, { allowedTools: ["echo"] });
    await h.kill.stop("all", "test");
    try {
      await h.hooks.beforeToolCall(ctxFor(h, t), echoTool, { text: "x" });
    } catch {
      // refused as expected
    }
    expect(h.audit.entries.filter((a) => !a.allowed && a.tokenId === t.claims.id)).toHaveLength(1);
  });
});

describe("budget: non-finite numbers", () => {
  // security finding (medium): `SessionBudget` accepts NaN. `precheck(…, NaN)` passes every
  // comparison and `record(…, NaN)` poisons `spentBySession` (NaN >= cap is always false),
  // so one NaN cost estimate (a pricing table without a price for the model id, a provider
  // that reports no usage) silently disables the session's hard cap for good. The outer
  // `CapChecker` refuses non-integers but the daemon runs `AllowAllCaps` in solo mode. Fix:
  // `Number.isSafeInteger` checks in `precheck` and `record`, refusing with `validation`.
  it("security finding: a NaN cost cannot pass or poison the session budget", () => {
    const b = new SessionBudget({
      sessionId: "s",
      budgetUsdMicro: 1_000,
      stepCap: 100,
      deadlineMs: Date.now() + 60_000,
      reserveShare: 0.2,
    });
    let refused = 0;
    try {
      b.precheck("r", 1_000, Number.NaN, "work");
    } catch {
      refused++;
    }
    try {
      b.record("r", Number.NaN);
    } catch {
      refused++;
    }
    expect(refused).toBe(2);
  });

  it("a refused NaN leaves the cap in force: the attack this finding was about", () => {
    const b = new SessionBudget({
      sessionId: "s",
      budgetUsdMicro: 1_000,
      stepCap: 100,
      deadlineMs: Date.now() + 60_000,
      reserveShare: 0.2,
    });
    b.record("r", 900);
    expect(() => b.precheck("r", 1_000, 200, "work")).toThrow(/budget/);
    // Before the fix this record poisoned the session's spend and the next precheck allowed.
    expect(() => b.record("r", Number.NaN)).toThrow(/budget spend/);
    expect(() => b.precheck("r", 1_000, 1_000_000, "work")).toThrow(/budget/);
    expect(b.snapshot().sessionSpentUsdMicro).toBe(900);
  });

  it("an infinite estimate is refused and a negative spend cannot be recorded", () => {
    const b = new SessionBudget({
      sessionId: "s",
      budgetUsdMicro: 1_000,
      stepCap: 100,
      deadlineMs: Date.now() + 60_000,
      reserveShare: 0.2,
    });
    expect(() => b.precheck("r", 1_000, Number.POSITIVE_INFINITY, "work")).toThrow(/budget/);
    expect(() => b.record("r", -1)).toThrow(/negative/);
    expect(
      () =>
        new SessionBudget({
          sessionId: "s",
          budgetUsdMicro: -1,
          stepCap: 1,
          deadlineMs: 1,
          reserveShare: 0.2,
        }),
    ).toThrow();
  });

  it("a zero-budget token cannot make a single model call and the refusal is a budget stop", async () => {
    const h = harness();
    const t = issue(h, { budgetUsdMicro: 0 });
    const e = await refusal(() => h.hooks.beforeModelCall(ctxFor(h, t), 1));
    expect(e.code).toBe("budget_exceeded");
  });
});

describe("kill file", () => {
  // security finding (low): `readKillRequest` returns whatever JSON the file holds. A scope
  // that is not `"all"` or an object (`"garbage"`) matches every registration in `stop()`
  // (no `sessionId`, no `agentId`) and revokes every token, but `isFrozen` then answers false
  // for every scope: everything is stopped and nothing is frozen, so new work starts at once.
  // Fix: validate the request shape and treat an unknown scope as `"all"` (fail closed).
  it("security finding: a malformed kill request either freezes everything or is ignored, never 'stop all, freeze nothing'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-sec-kill-"));
    try {
      const h = harness();
      const ks = new KillSwitch(h.tokens);
      const c = new AbortController();
      ks.register({ agentId: "alice", sessionId: "s1", controller: c, label: "run" });
      writeKillRequest(
        {
          scope: "garbage" as unknown as "all",
          reason: "r",
          requestedAt: "t1",
          requestedBy: "test",
        },
        dir,
      );
      const w = new KillFileWatcher(ks, h.clock, dir);
      await w.check();
      const stopped = c.signal.aborted;
      const frozen = ks.isFrozen({ agentId: "alice", sessionId: "s1" });
      expect(stopped === frozen).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a valid request stops and freezes the scope once; the same request is not replayed on the next poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-sec-kill-"));
    try {
      const h = harness();
      let stops = 0;
      const ks = new KillSwitch(h.tokens);
      ks.onStop(() => stops++);
      ks.register({
        agentId: "alice",
        sessionId: "s1",
        controller: new AbortController(),
        label: "run",
      });
      writeKillRequest(
        { scope: { agentId: "alice" }, reason: "r", requestedAt: "t1", requestedBy: "ui" },
        dir,
      );
      const w = new KillFileWatcher(ks, h.clock, dir);
      expect(await w.check()).toBe(true);
      expect(await w.check()).toBe(false);
      expect(stops).toBe(1);
      expect(ks.isFrozen({ agentId: "alice", sessionId: "x" })).toBe(true);
      expect(ks.isFrozen({ agentId: "bob", sessionId: "y" })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
