import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { MemoryVault } from "../src/memory.ts";
import { freshValue } from "./helpers.ts";

describe("MemoryVault", () => {
  it("round-trips, lists sorted, deletes and reports presence", async () => {
    const vault = new MemoryVault();
    expect(vault.backend).toBe("memory");
    const a = freshValue();
    const b = freshValue();
    await vault.set("zeta", a);
    await vault.set("alpha", b);
    expect(await vault.get("zeta")).toBe(a);
    expect(await vault.get("alpha")).toBe(b);
    expect(await vault.get("missing")).toBeNull();
    expect(await vault.list()).toEqual(["alpha", "zeta"]);
    expect(await vault.has("zeta")).toBe(true);
    expect(await vault.has("nope")).toBe(false);
    expect(await vault.delete("zeta")).toBe(true);
    expect(await vault.delete("zeta")).toBe(false);
    expect(await vault.list()).toEqual(["alpha"]);
    vault.clear();
    expect(await vault.list()).toEqual([]);
  });

  it("validates names and values like every other backend", async () => {
    const vault = new MemoryVault({ seeded: "ok-value" });
    expect(await vault.get("seeded")).toBe("ok-value");
    await expect(vault.set("Bad Name", "x")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    await expect(vault.set("fine", "")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    await expect(vault.get("__index__")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    expect(() => new MemoryVault({ "Bad Name": "x" })).toThrow(/invalid secret name/);
  });
});
