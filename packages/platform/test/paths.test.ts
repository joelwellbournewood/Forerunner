import { describe, expect, it } from "vitest";
import {
  appDirs,
  fromPosix,
  isInside,
  join,
  normalizeNewlines,
  safeSegment,
  toPosix,
} from "../src/paths.ts";

describe("paths", () => {
  it("round-trips posix conversion", () => {
    const native = join("a", "b", "c.txt");
    expect(toPosix(native)).toBe("a/b/c.txt");
    expect(fromPosix("a/b/c.txt")).toBe(native);
  });

  it("detects containment without string prefix bugs", () => {
    expect(isInside(join("/", "work", "proj"), join("/", "work", "proj", "src"))).toBe(true);
    expect(isInside(join("/", "work", "proj"), join("/", "work", "proj2"))).toBe(false);
    expect(isInside(join("/", "work", "proj"), join("/", "work", "proj", "..", "x"))).toBe(false);
  });

  it("uses FORERUNNER_HOME as an override on every platform", () => {
    for (const platform of ["windows", "linux", "macos"] as const) {
      const d = appDirs({ env: { FORERUNNER_HOME: join("/", "tmp", "fr") }, platform });
      expect(d.config.endsWith(join("fr", "config"))).toBe(true);
      expect(d.data.endsWith(join("fr", "data"))).toBe(true);
    }
  });

  it("follows known folders on Windows and XDG on Linux", () => {
    const win = appDirs({
      platform: "windows",
      env: {
        APPDATA: "C:\\Users\\j\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\j\\AppData\\Local",
      },
      home: "C:\\Users\\j",
    });
    expect(toPosix(win.config)).toContain("AppData/Roaming/forerunner/config");
    expect(toPosix(win.data)).toContain("AppData/Local/forerunner/data");
    const lin = appDirs({ platform: "linux", env: { XDG_CONFIG_HOME: "/x/cfg" }, home: "/home/j" });
    expect(toPosix(lin.config)).toBe("/x/cfg/forerunner");
    expect(toPosix(lin.data)).toBe("/home/j/.local/share/forerunner");
  });

  it("produces safe path segments", () => {
    expect(safeSegment("My Project: v2 / final")).toBe("My-Project-v2-final");
    expect(safeSegment("CON")).toBe("item");
    expect(safeSegment("...")).toBe("item");
  });

  it("normalises newlines", () => {
    expect(normalizeNewlines("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});
