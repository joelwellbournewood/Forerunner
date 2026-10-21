import { afterEach, describe, expect, it, vi } from "vitest";
import { saveTextFile } from "../src/lib/download.ts";

/** The browser side of the audit export: an object URL on a hidden anchor, clicked once. */
describe("saveTextFile", () => {
  const original = {
    create: URL.createObjectURL as unknown,
    revoke: URL.revokeObjectURL as unknown,
  };
  afterEach(() => {
    (URL as { createObjectURL?: unknown }).createObjectURL = original.create;
    (URL as { revokeObjectURL?: unknown }).revokeObjectURL = original.revoke;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hands the text to the browser as a named download and revokes the URL afterwards", () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:fr/1";
    });
    const revoke = vi.fn();
    (URL as { createObjectURL?: unknown }).createObjectURL = create;
    (URL as { revokeObjectURL?: unknown }).revokeObjectURL = revoke;
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const ok = saveTextFile({
      filename: "forerunner-audit-x.jsonl",
      contentType: "application/x-ndjson; charset=utf-8",
      text: '{"a":1}\n',
    });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(blobs[0]?.type).toBe("application/x-ndjson; charset=utf-8");
    expect(blobs[0]?.size).toBe(8);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.getAttribute("download")).toBe("forerunner-audit-x.jsonl");
    expect(clicked[0]?.getAttribute("href")).toBe("blob:fr/1");
    // The anchor never stays in the document.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:fr/1");
  });

  it("returns false where object URLs are unavailable and touches nothing", () => {
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    expect(saveTextFile({ filename: "x.csv", contentType: "text/csv", text: "a" })).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
});
