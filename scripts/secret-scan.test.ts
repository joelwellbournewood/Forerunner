import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { scanText } from "./secret-scan.mjs";

describe("secret-scan", () => {
  it("flags credential shapes", () => {
    const fake = ["sk-ant-api03-", "A".repeat(40)].join(""); // not-a-secret
    const hits = scanText(`key=${fake}\nnothing here\n`, "x.ts");
    expect(hits.map((h: { kind: string }) => h.kind)).toContain("anthropic");
  });
  it("flags a Google API key, the shape a committed google-services.json would carry", () => {
    const fake = ["AI", "za", "Sy", "X".repeat(33)].join(""); // not-a-secret
    const hits = scanText(`"current_key": "${fake}"\n`, "google-services.json");
    expect(hits.map((h: { kind: string }) => h.kind)).toContain("google-api-key");
  });
  it("honours the not-a-secret marker", () => {
    const fake = ["ghp_", "b".repeat(40)].join("");
    expect(scanText(`const t = "${fake}"; // not-a-secret`, "x.ts")).toHaveLength(0);
  });
});
