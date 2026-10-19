import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { scanText } from "./secret-scan.mjs";

describe("secret-scan", () => {
  it("flags credential shapes", () => {
    const fake = ["sk-ant-api03-", "A".repeat(40)].join(""); // not-a-secret
    const hits = scanText(`key=${fake}\nnothing here\n`, "x.ts");
    expect(hits.map((h: { kind: string }) => h.kind)).toContain("anthropic");
  });
  it("honours the not-a-secret marker", () => {
    const fake = ["ghp_", "b".repeat(40)].join("");
    expect(scanText(`const t = "${fake}"; // not-a-secret`, "x.ts")).toHaveLength(0);
  });
});
