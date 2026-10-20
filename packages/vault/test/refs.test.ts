import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it, vi } from "vitest";
import { MemoryVault } from "../src/memory.ts";
import {
  formatSecretRef,
  isSecretRef,
  MIN_REDACT_LENGTH,
  parseSecretRef,
  redactValues,
  resolveSecretRefs,
  SECRET_PREFIX,
  SecretResolver,
} from "../src/refs.ts";
import { caught, freshValue } from "./helpers.ts";

describe("secret reference syntax", () => {
  it("recognises whole-string references with valid names only", () => {
    expect(SECRET_PREFIX).toBe("secret:");
    expect(isSecretRef("secret:github_pat")).toBe(true);
    expect(isSecretRef("secret:org:deploy.token-1")).toBe(true);
    expect(isSecretRef("use secret:github_pat here")).toBe(false);
    expect(isSecretRef(" secret:github_pat")).toBe(false);
    expect(isSecretRef("secret:github_pat ")).toBe(false);
    expect(isSecretRef("secret:")).toBe(false);
    expect(isSecretRef("secret:GitHub")).toBe(false);
    expect(isSecretRef("secret: never commit tokens")).toBe(false);
    expect(isSecretRef("Secret:github_pat")).toBe(false);
    expect(isSecretRef(42)).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it("parses and formats", () => {
    expect(parseSecretRef("secret:github_pat")).toBe("github_pat");
    expect(formatSecretRef("github_pat")).toBe("secret:github_pat");
    expect(parseSecretRef(formatSecretRef("a.b:c-d"))).toBe("a.b:c-d");
    for (const bad of ["github_pat", "secret:Bad Name", "secret:", "token:x"]) {
      expect(() => parseSecretRef(bad)).toThrow(/secret/);
    }
    expect(() => formatSecretRef("Bad")).toThrow(/invalid secret name/);
  });
});

describe("resolveSecretRefs", () => {
  const value = freshValue();
  const other = freshValue("o-");
  const vault = new MemoryVault({ github_pat: value, other_key: other });

  it("replaces references anywhere in nested objects and arrays, returning a new structure", async () => {
    const input = {
      url: "https://api.example.test",
      headers: { Authorization: "secret:github_pat", Accept: "application/json" },
      list: ["secret:other_key", { deep: ["x", "secret:github_pat"] }, 3, null, true],
      note: "token is secret:github_pat (mid-string, untouched)",
      when: new Date(0),
    };
    const snapshot = structuredClone(input);
    const audited: string[] = [];
    const out = (await resolveSecretRefs(input, vault, new Set(["github_pat", "other_key"]), (n) =>
      audited.push(n),
    )) as typeof input;

    expect(out).not.toBe(input);
    expect(out.headers).not.toBe(input.headers);
    expect(out.headers.Authorization).toBe(value);
    expect(out.headers.Accept).toBe("application/json");
    expect(out.list[0]).toBe(other);
    expect((out.list[1] as { deep: string[] }).deep).toEqual(["x", value]);
    expect(out.list.slice(2)).toEqual([3, null, true]);
    expect(out.note).toBe(input.note);
    expect(out.when).toBe(input.when); // class instances pass through by identity
    expect(input).toEqual(snapshot); // input unchanged
    expect(audited.sort()).toEqual(["github_pat", "other_key"]); // once per name
  });

  it("passes through inputs without references, including scalars", async () => {
    expect(await resolveSecretRefs("plain", vault, new Set())).toBe("plain");
    expect(await resolveSecretRefs(7, vault, new Set())).toBe(7);
    expect(await resolveSecretRefs(undefined, vault, new Set())).toBeUndefined();
    expect(await resolveSecretRefs({ a: [1, { b: "c" }] }, vault, new Set())).toEqual({
      a: [1, { b: "c" }],
    });
  });

  it("throws secret_not_granted before touching the vault", async () => {
    const spy = vi.spyOn(vault, "get");
    const err = await caught(() =>
      resolveSecretRefs({ h: { a: "secret:github_pat" } }, vault, new Set(["other_key"])),
    );
    expect(isForerunnerError(err, "secret_not_granted")).toBe(true);
    expect((err as { details: { name: string } }).details.name).toBe("github_pat");
    expect((err as Error).message).not.toContain(value);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws not_found for a granted name that is not stored", async () => {
    const err = await caught(() =>
      resolveSecretRefs(["secret:absent"], vault, new Set(["absent"])),
    );
    expect(isForerunnerError(err, "not_found")).toBe(true);
  });

  it("refuses absurd nesting instead of overflowing", async () => {
    let deep: unknown = "secret:github_pat";
    for (let i = 0; i < 80; i++) deep = [deep];
    await expect(resolveSecretRefs(deep, vault, new Set(["github_pat"]))).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
  });
});

describe("redactValues", () => {
  it("scrubs values and their escaped, url-encoded and base64 forms, longest first", () => {
    const token = freshValue("tok-");
    const quoted = `pa"ss word/${token}`;
    const text = [
      `plain ${token} end`,
      `json ${JSON.stringify({ k: quoted })}`,
      `url ?q=${encodeURIComponent(quoted)}`,
      `b64 ${Buffer.from(token).toString("base64")}`,
      `inner ${quoted}`,
    ].join("\n");
    const out = redactValues(text, [token, quoted]);
    expect(out).not.toContain(token);
    expect(out).not.toContain(quoted);
    expect(out).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(out).not.toContain(encodeURIComponent(quoted));
    expect(out).not.toContain(Buffer.from(token).toString("base64"));
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(5);
    expect(out).toContain("plain [REDACTED] end");
  });

  it("ignores empty and very short values and supports a custom marker", () => {
    expect(MIN_REDACT_LENGTH).toBe(4);
    const text = "a short e value and a longer one";
    expect(redactValues(text, ["", "a", "e v"])).toBe(text);
    expect(redactValues(text, ["longer"], "***")).toBe("a short e value and a *** one");
  });

  it("leaves text without matches unchanged", () => {
    expect(redactValues("nothing here", [freshValue()])).toBe("nothing here");
  });
});

describe("SecretResolver (runtime SecretsPort shape)", () => {
  it("resolves, remembers the values it handed out and scrubs them from outputs", async () => {
    const value = freshValue();
    const vault = new MemoryVault({ api_key: value });
    const audited: string[] = [];
    const resolver = new SecretResolver(vault, (n) => audited.push(n));
    expect(resolver.redact(`before ${value}`)).toBe(`before ${value}`); // nothing resolved yet
    const out = (await resolver.resolve({ key: "secret:api_key" }, new Set(["api_key"]))) as {
      key: string;
    };
    expect(out.key).toBe(value);
    expect(resolver.resolvedCount).toBe(1);
    expect(audited).toEqual(["api_key"]);
    expect(
      resolver.redact(`tool said: ${value} and base64 ${Buffer.from(value).toString("base64")}`),
    ).toBe("tool said: [REDACTED] and base64 [REDACTED]");
    await expect(resolver.resolve("secret:api_key", new Set())).rejects.toSatisfy((e) =>
      isForerunnerError(e, "secret_not_granted"),
    );
    resolver.forget();
    expect(resolver.resolvedCount).toBe(0);
    expect(resolver.redact(value)).toBe(value);
  });
});
