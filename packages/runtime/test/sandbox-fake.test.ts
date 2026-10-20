import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../src/sandbox/fake.ts";

describe("FakeSandbox", () => {
  it("keeps files in memory with path containment and LF normalisation", async () => {
    const sb = new FakeSandbox({ files: { "README.md": "# hi\n" } });
    expect(sb.kind).toBe("fake");
    expect(await sb.readFile("README.md")).toBe("# hi\n");
    await sb.writeFile("src/./a.ts", "a\r\nb");
    expect(await sb.readFile("src/a.ts")).toBe("a\nb");
    expect(await sb.exists("src")).toBe(true);
    expect(await sb.exists("src/a.ts")).toBe(true);
    expect(await sb.exists("nope")).toBe(false);
    await expect(sb.readFile("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(sb.writeFile("../x", "")).rejects.toMatchObject({ code: "path_not_allowed" });
    expect([...sb.files.keys()].sort()).toEqual(["README.md", "src/a.ts"]);
  });

  it("returns scripted results, later scripts first, and records every call", async () => {
    const sb = new FakeSandbox({
      rules: [{ match: "pnpm", result: { stdout: "pnpm ok" } }],
      defaultResult: { code: 1, stderr: "unknown command" },
    });
    sb.script(/^pnpm test/, { code: 2, stdout: "1 failed" });
    sb.script(
      (argv) => argv.includes("--version"),
      (argv) => ({ stdout: `${argv[0]} 1.0` }),
    );
    expect(await sb.run(["pnpm", "test"])).toMatchObject({ code: 2, stdout: "1 failed" });
    expect(await sb.run(["pnpm", "install"])).toMatchObject({ code: 0, stdout: "pnpm ok" });
    expect(await sb.run(["git", "--version"])).toMatchObject({ stdout: "git 1.0" });
    expect(await sb.run(["rm", "-rf", "x"], { cwd: "sub" })).toMatchObject({
      code: 1,
      stderr: "unknown command",
    });
    expect(sb.calls.map((c) => c.argv[0])).toEqual(["pnpm", "pnpm", "git", "rm"]);
    expect(sb.calls[3]?.opts.cwd).toBe("sub");
    await expect(sb.run(["x"], { cwd: "../out" })).rejects.toMatchObject({
      code: "path_not_allowed",
    });
    await sb.destroy();
    expect(sb.destroyed).toBe(true);
    await expect(sb.run(["x"])).rejects.toMatchObject({ code: "unavailable" });
  });
});
