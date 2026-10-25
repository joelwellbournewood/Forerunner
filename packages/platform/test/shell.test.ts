import { describe, expect, it } from "vitest";
import { run, ShellError, which } from "../src/shell.ts";

describe("shell runner", () => {
  it("runs node with argv arrays and captures output", async () => {
    const r = await run([
      process.execPath,
      "-e",
      "process.stdout.write('hi ' + process.argv[1])",
      "there",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi there");
  });

  it("passes arguments verbatim (no shell interpretation)", async () => {
    const arg = 'a b "c" $HOME %PATH% ; echo x | cat';
    const r = await run([process.execPath, "-e", "process.stdout.write(process.argv[1])", arg]);
    expect(r.stdout).toBe(arg);
  });

  it("throws ShellError on non-zero exit unless allowed", async () => {
    await expect(run([process.execPath, "-e", "process.exit(3)"])).rejects.toBeInstanceOf(
      ShellError,
    );
    const r = await run([process.execPath, "-e", "process.exit(3)"], { allowFailure: true });
    expect(r.code).toBe(3);
  });

  it("enforces a wall-clock timeout and kills the process", async () => {
    const r = await run([process.execPath, "-e", "setTimeout(()=>{}, 60000)"], {
      timeoutMs: 300,
      allowFailure: true,
    });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it("resolves at the time limit although a grandchild still holds the inherited pipes", async () => {
    // git's remote helper, a sandbox runtime, a compiler's worker: a killed command's child
    // inherits stdout and stderr and lives on, so the stdio streams stay open. The runner must
    // still return at the limit, or nothing that runs a process is bounded in time.
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 15000)'], { stdio: 'inherit' });",
      "setTimeout(()=>{}, 60000)",
    ].join("\n");
    const r = await run([process.execPath, "-e", script], { timeoutMs: 300, allowFailure: true });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it("caps captured output", async () => {
    const r = await run([process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"], {
      maxOutputBytes: 1000,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("finds executables on PATH", async () => {
    const node = await which(process.platform === "win32" ? "node.exe" : "node");
    expect(node).toBeTruthy();
    expect(await which("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});
