import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.ts";
import { ReleaseManifest } from "../src/update/manifest.ts";

/**
 * `fr update manifest --version <v>` through the real program (release.yml runs exactly this).
 * The program's own `--version` (commander's `.version()`) used to take the flag: rc.2's
 * publish job printed "1.0.0-rc.2" and wrote no manifest (run 40243511397).
 */
describe("fr update manifest through the whole program", () => {
  it("--version after the subcommand is the release version, not the program's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-manifest-program-"));
    writeFileSync(join(dir, "app.apk"), "apk bytes");
    writeFileSync(join(dir, "notes.md"), "## 1.0.0-rc.2\n- two\n");
    const lines: string[] = [];
    const program = buildProgram({
      env: { FORERUNNER_HOME: join(dir, "home"), FORERUNNER_VERSION: "9.9.9" },
      out: (l) => lines.push(l),
    });
    program.exitOverride();
    await program.parseAsync([
      "node",
      "fr",
      "update",
      "manifest",
      "--version",
      "1.0.0-rc.2",
      "--channel",
      "beta",
      "--notes-file",
      join(dir, "notes.md"),
      "--min-schema",
      "1",
      "--base-url",
      "https://example.invalid/releases/download/v1.0.0-rc.2",
      "--artifact",
      `android:${join(dir, "app.apk")}`,
      "--out",
      join(dir, "manifest.json"),
    ]);
    const manifest = ReleaseManifest.parse(
      JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    );
    expect(manifest.version).toBe("1.0.0-rc.2");
    expect(manifest.channel).toBe("beta");
    expect(lines.join("\n")).not.toBe("9.9.9");
  });

  it("the program's own version still answers before any subcommand", async () => {
    const lines: string[] = [];
    const program = buildProgram({
      env: { FORERUNNER_VERSION: "9.9.9" },
      out: (l) => lines.push(l),
    });
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => lines.push(s.trim()) });
    await expect(program.parseAsync(["node", "fr", "--version"])).rejects.toMatchObject({
      code: "commander.version",
    });
    expect(lines).toContain("9.9.9");
  });
});
