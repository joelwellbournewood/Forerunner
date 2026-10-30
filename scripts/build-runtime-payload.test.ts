import { describe, expect, it } from "vitest";
import {
  isForeignPlatformPackage,
  isPrunable,
  nodeBinaryName,
  RUNTIME_ENTRY,
  workspaceClosure,
  workspacePaths,
  // @ts-expect-error plain JS module
} from "./build-runtime-payload.mjs";

// The desktop installers carry the runtime (ADR 0092). 1.0.0's MSI did not: the shell looked for a
// checkout through install.json and a new user's app started whatever old checkout that named
// (a 0.1.0 daemon whose /me lacked desktopDeviceId), or nothing at all.

describe("workspacePaths", () => {
  it("maps every export of every shipped package to its source file", () => {
    const paths = workspacePaths([
      {
        name: "@forerunner/runtime",
        dir: "packages/runtime",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
      },
      {
        name: "@forerunner/platform",
        dir: "packages/platform",
        exports: { ".": "./src/index.ts", "./paths": "./src/paths.ts" },
      },
    ]);
    expect(paths).toEqual({
      "@forerunner/platform": ["./packages/platform/src/index.ts"],
      "@forerunner/platform/paths": ["./packages/platform/src/paths.ts"],
      "@forerunner/runtime": ["./packages/runtime/src/index.ts"],
      "@forerunner/runtime/*": ["./packages/runtime/src/*.ts"],
    });
  });

  it("treats a string export and a missing one as the package root", () => {
    expect(
      workspacePaths([
        { name: "@a/one", dir: "packages/one", exports: "./src/main.ts" },
        { name: "@a/two", dir: "packages/two" },
      ]),
    ).toEqual({
      "@a/one": ["./packages/one/src/main.ts"],
      "@a/two": ["./packages/two/src/index.ts"],
    });
  });
});

describe("workspaceClosure", () => {
  const pkgs = new Map([
    [
      "@f/runtime",
      {
        dependencies: { "@f/capabilities": "workspace:*", "@f/platform": "workspace:*", zod: "^4" },
      },
    ],
    [
      "@f/capabilities",
      { dependencies: { "@f/runtime": "workspace:*", "@f/platform": "workspace:*" } },
    ],
    ["@f/platform", { dependencies: {} }],
    ["@f/testenv", { dependencies: { "@f/platform": "workspace:*" } }],
  ]);

  it("follows workspace dependencies through cycles and leaves out what nothing imports", () => {
    expect(workspaceClosure("@f/runtime", pkgs)).toEqual([
      "@f/capabilities",
      "@f/platform",
      "@f/runtime",
    ]);
  });

  it("refuses a workspace dependency it cannot find", () => {
    expect(() => workspaceClosure("@f/missing", pkgs)).toThrow(/no workspace package/);
  });
});

describe("isForeignPlatformPackage", () => {
  it("keeps the target's glibc and plain builds on Linux and drops musl and other systems", () => {
    expect(
      isForeignPlatformPackage("@anthropic-ai/claude-agent-sdk-linux-x64", "linux", "x64"),
    ).toBe(false);
    expect(isForeignPlatformPackage("@napi-rs/keyring-linux-x64-gnu", "linux", "x64")).toBe(false);
    expect(
      isForeignPlatformPackage("@anthropic-ai/claude-agent-sdk-linux-x64-musl", "linux", "x64"),
    ).toBe(true);
    expect(isForeignPlatformPackage("@napi-rs/keyring-linux-x64-musl", "linux", "x64")).toBe(true);
    expect(isForeignPlatformPackage("@napi-rs/keyring-win32-x64-msvc", "linux", "x64")).toBe(true);
    expect(
      isForeignPlatformPackage("@anthropic-ai/claude-agent-sdk-linux-arm64", "linux", "x64"),
    ).toBe(true);
  });

  it("keeps the MSVC builds on Windows", () => {
    expect(isForeignPlatformPackage("@napi-rs/keyring-win32-x64-msvc", "win32", "x64")).toBe(false);
    expect(
      isForeignPlatformPackage("@anthropic-ai/claude-agent-sdk-win32-x64", "win32", "x64"),
    ).toBe(false);
    expect(
      isForeignPlatformPackage("@anthropic-ai/claude-agent-sdk-darwin-arm64", "win32", "x64"),
    ).toBe(true);
  });

  it("leaves ordinary packages alone", () => {
    for (const name of [
      "zod",
      "@anthropic-ai/claude-agent-sdk",
      "@napi-rs/keyring",
      "x-linux-tools",
    ]) {
      expect(isForeignPlatformPackage(name, "linux", "x64")).toBe(false);
    }
  });
});

describe("payload files", () => {
  it("drops declarations and source maps, keeps code", () => {
    for (const f of ["index.d.ts", "index.d.mts", "index.d.cts", "index.js.map", "x.tsbuildinfo"]) {
      expect(isPrunable(f)).toBe(true);
    }
    for (const f of [
      "index.js",
      "index.mjs",
      "cli.cjs",
      "main.ts",
      "catalog.json",
      "keyring.node",
      "LICENSE",
    ]) {
      expect(isPrunable(f)).toBe(false);
    }
  });

  it("names the node binary per OS and runs the CLI the shell runs", () => {
    expect(nodeBinaryName("win32")).toBe("node.exe");
    expect(nodeBinaryName("linux")).toBe("node");
    expect(RUNTIME_ENTRY).toBe("packages/runtime/src/cli/main.ts");
  });
});
