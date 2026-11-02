import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isWindows, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { fileUnder, listProjectFiles } from "../src/daemon/docs-routes.ts";

/**
 * The Files tab's reader (design §3.10) and the task drawer's file links (phase E, later #65):
 * `fileUnder` turns the path a link carries into a file of the project's folder, or refuses it;
 * `listProjectFiles` lists the folder. Validation rule 5: spaces, non-ASCII letters, links, and
 * the Windows forms (a drive-relative path, an alternate data stream, a reserved device name).
 */
function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "fr files ü-"));
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "Über uns.md"), "# Über uns\n");
  writeFileSync(join(root, "my page.html"), "<p>hi</p>\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  return root;
}

describe("the project's files as the Files tab reads them (later #65)", () => {
  it("opens names with spaces and non-ASCII letters, under folders, as the drawer's links name them", () => {
    const root = folder();
    expect(fileUnder(root, "notes/Über uns.md")).toMatch(/Über uns\.md$/);
    expect(fileUnder(root, "my page.html")).toMatch(/my page\.html$/);
    // A Windows separator in the link is the same file.
    expect(fileUnder(root, "notes\\Über uns.md")).toBe(fileUnder(root, "notes/Über uns.md"));
  });

  it("refuses what leaves the folder or is not the project's: absolute, drive, '..', the git folder, a missing file", () => {
    const root = folder();
    for (const rel of [
      "",
      "/etc/passwd",
      "C:x",
      "C:\\Windows\\win.ini",
      "c:/x",
      "../outside.txt",
      "notes/../../outside.txt",
      "notes//Über uns.md",
      "./a.txt",
      ".git/config",
      "node_modules/x.js",
      "no such file.md",
    ])
      expect(fileUnder(root, rel), rel).toBeNull();
  });

  it("follows a link only while it stays inside the folder", () => {
    const root = folder();
    const outside = mkdtempSync(join(tmpdir(), "fr-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    let linked = true;
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
      symlinkSync(join(root, "a.txt"), join(root, "inside.txt"));
    } catch {
      // Windows without the right to make links (a standard user): nothing to check here.
      linked = false;
    }
    if (!linked) return;
    expect(fileUnder(root, "escape.txt")).toBeNull();
    expect(fileUnder(root, "inside.txt")).toMatch(/a\.txt$/);
    // The list never follows a link out of the folder (nor lists it).
    const listed = listProjectFiles(root).entries.map((e) => e.path);
    expect(listed).not.toContain("escape.txt");
  });

  it("an alternate data stream and a reserved device name are no file of the project on Windows", () => {
    const root = folder();
    if (isWindows()) {
      writeFileSync(join(root, "a.txt:hidden"), "a stream\n");
      expect(fileUnder(root, "a.txt:hidden")).toBeNull();
      for (const rel of ["CON", "nul.txt", "notes/AUX", "COM1.md", "LPT1"])
        expect(fileUnder(root, rel), rel).toBeNull();
    } else {
      // On Linux a colon is a letter like another: a file named so opens.
      writeFileSync(join(root, "a.txt:hidden"), "a file\n");
      expect(fileUnder(root, "a.txt:hidden")).toMatch(/a\.txt:hidden$/);
      expect(fileUnder(root, "CON")).toBeNull();
    }
  });

  it("lists every file and folder with sizes and dates, the git folder left out", () => {
    const root = folder();
    const { entries, truncated } = listProjectFiles(root);
    expect(truncated).toBe(false);
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual(
      expect.arrayContaining([
        "dir:notes",
        "file:notes/Über uns.md",
        "file:my page.html",
        "file:a.txt",
      ]),
    );
    expect(entries.some((e) => e.path.startsWith(".git"))).toBe(false);
    const page = entries.find((e) => e.path === "my page.html");
    expect(page?.sizeBytes).toBe(10);
    expect(Date.parse(page?.updatedAt ?? "")).not.toBeNaN();
  });
});
