import { readFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

/**
 * W15-10 (w15-merge, wave 15): `GitOps.must()` tells a credential prompt from git's English words
 * ("could not read Username for", "Authentication failed for"), and the merge step and the copy
 * read git's words elsewhere too. A GitOps that runs git in the person's own language (a German
 * Windows) said those failures in other words, so every GitOps of the merge step and the docs
 * copy asks for git's untranslated messages (`untranslated: true`, TM-6's option).
 */
const SOURCES = ["packages/runtime/src/loop/merge.ts", "packages/runtime/src/loop/docs.ts"];

/** Each `new GitOps({ ... })` in a source, with its options as written. */
function constructions(text: string): string[] {
  const out: string[] = [];
  let at = text.indexOf("new GitOps(");
  while (at >= 0) {
    let depth = 0;
    let end = at + "new GitOps(".length - 1;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(at, end + 1));
    at = text.indexOf("new GitOps(", end);
  }
  return out;
}

describe("w15-merge, wave 15", () => {
  it("every GitOps of the merge step and of this computer's copy reads git's messages untranslated (W15-10)", () => {
    for (const file of SOURCES) {
      const found = constructions(readFileSync(join(process.cwd(), file), "utf8"));
      expect(found.length, file).toBeGreaterThan(0);
      for (const c of found) {
        // The copy's own `gitOf` helper is the one construction that takes it from a variable.
        expect(c, `${file}: ${c}`).toMatch(/untranslated: true/);
      }
    }
  });
});
