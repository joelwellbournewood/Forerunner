// check-paths-ignore-file: the fixtures below are the very patterns the lint looks for
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { lintSource, stripComments } from "./check-paths.mjs";

type Finding = { file: string; line: number; rule: string; text: string };
const lint = (src: string, file = "packages/runtime/src/x.ts"): Finding[] => lintSource(src, file);
const rules = (src: string, file?: string) => lint(src, file).map((f) => f.rule);
// Test sources are plain strings; "@{" stands for the template placeholder opener.
const tpl = (s: string) => s.replace(/@\{/g, ["$", "{"].join(""));

describe("check-paths stripComments", () => {
  it("removes line and block comments but keeps strings and line numbers", () => {
    const src = tpl(
      'const a = "x/y"; // dir + "/" + name\n/* dir + "/" */ const b = 1;\nconst c = `t/@{a}`;\n',
    );
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"x/y"');
    expect(out).not.toContain("dir + ");
    expect(out).toContain(tpl("`t/@{a}`"));
  });

  it("does not treat // inside a string as a comment and blanks regex literals", () => {
    const out = stripComments(
      'const u = "http://h/p" + dir;\nconst r = /a\\/b/g.test(s) + dir + "/";\n',
    );
    expect(out.split("\n")[0]).toContain('"http://h/p" + dir');
    expect(out.split("\n")[1]).not.toContain("a\\/b");
    expect(out.split("\n")[1]).toContain('+ dir + "/"');
  });

  it("keeps code inside template placeholders", () => {
    const out = stripComments(tpl('const s = `@{dir + "/" + name} // not a comment`;\n'));
    expect(out).toContain('dir + "/" + name');
    expect(out).toContain("// not a comment");
  });
});

describe("check-paths concat-slash", () => {
  it("flags string concatenation with / or \\\\ next to a path-like identifier", () => {
    expect(rules('const p = dir + "/" + name;')).toEqual(["concat-slash"]);
    expect(rules('const p = "logs/" + file;')).toEqual(["concat-slash"]);
    expect(rules("const p = root + '\\\\' + name;")).toEqual(["concat-slash"]);
    expect(rules("writeFileSync(cwd + `/out.txt`, x);")).toEqual(["concat-slash"]);
    const f = lint('const a = 1;\nconst p = worktree + "/src";\n');
    expect(f[0]).toMatchObject({
      line: 2,
      rule: "concat-slash",
      text: 'const p = worktree + "/src";',
    });
  });

  it("ignores URLs, import specifiers, regexes, comments and escapes", () => {
    expect(rules('const u = "https://example.invalid/" + dir;')).toEqual([]);
    expect(rules('const u = apiBase + "/repos/" + repo;')).toEqual([]);
    expect(rules(tpl("res = await f(`@{base}/user`, { headers });"))).toEqual([]);
    expect(rules(tpl("const u = `@{base}/user` + path;"))).toEqual(["concat-slash"]); // a real concat
    expect(rules('import { x } from "../a/" + "b";')).toEqual([]);
    expect(rules('export { y } from "./dir/" + "z";')).toEqual([]);
    expect(rules('const m = /dir\\/x/.test(s) + "/";')).toEqual([]);
    expect(rules('// const p = dir + "/" + name;')).toEqual([]);
    expect(rules('/* dir + "/" */ const q = 1;')).toEqual([]);
    expect(rules('const t = "line\\n" + file;')).toEqual([]); // \n is an escape, not a separator
    expect(rules('const s = parts.join("/") + file.length;')).toEqual([]);
    expect(rules('const h = "v=1; c=relaxed/relaxed; d=" + addressDomain(address);')).toEqual([]);
  });

  it("does not flag template literals with placeholders alone (container and registry paths are posix)", () => {
    expect(rules(tpl("const p = `@{CONTAINER_WORKDIR}/@{rel}`;"))).toEqual([]);
    expect(rules(tpl("const p = `@{dir}/@{name}`;"))).toEqual([]);
  });

  it("honours the path-ok marker and skips packages/platform", () => {
    expect(rules('const p = dir + "/" + name; // path-ok: a git tree path, always posix')).toEqual(
      [],
    );
    expect(rules('const p = dir + "/" + name;', "packages/platform/src/paths.ts")).toEqual([]);
    expect(
      rules('const p = dir + "/" + name;', "/abs/repo/packages/platform/test/paths.test.ts"),
    ).toEqual([]);
    expect(rules('const p = dir + "/" + name;', "packages/platform-ish/src/x.ts")).toEqual([
      "concat-slash",
    ]);
  });
});

describe("check-paths node-path", () => {
  it("flags node:path imports outside platform", () => {
    expect(rules('import path from "node:path";')).toEqual(["node-path"]);
    expect(rules('import { join } from "path";')).toEqual(["node-path"]);
    expect(rules('const p = require("node:path");')).toEqual(["node-path"]);
    expect(rules('import posix from "node:path/posix";')).toEqual(["node-path"]);
    expect(rules('import path from "node:path";', "packages/platform/src/paths.ts")).toEqual([]);
  });

  it("does not flag platform imports or other modules", () => {
    expect(rules('import { join } from "@forerunner/platform/paths";')).toEqual([]);
    expect(rules('import { join } from "../packages/platform/src/paths.ts";')).toEqual([]);
    expect(rules('import { readFileSync } from "node:fs";')).toEqual([]);
    expect(rules('const x = "node:path";')).toEqual([]);
  });
});
