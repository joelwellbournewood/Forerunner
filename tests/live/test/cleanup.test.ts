import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it, vi } from "vitest";
import { RM_TREE, removeTreeOrWarn } from "../src/harness.ts";

describe("temporary tree cleanup", () => {
  it("removes the tree and says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-live-cleanup-"));
    writeFileSync(join(dir, "f.txt"), "x", "utf8");
    expect(removeTreeOrWarn(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("warns instead of throwing when the removal fails (a Windows EPERM), so the caller carries on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rm = vi.fn(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    try {
      expect(removeTreeOrWarn("/tmp/held-open", rm as never)).toBe(false);
      expect(rm).toHaveBeenCalledWith("/tmp/held-open", RM_TREE);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("/tmp/held-open (EPERM");
    } finally {
      warn.mockRestore();
    }
  });
});
