import { describe, expect, it } from "vitest";
import { COLOUR_FORCING_ENV, stripAnsi, withoutForcedColour } from "../src/plain-output.ts";
import { run } from "../src/shell.ts";

/**
 * Command output a person or a model reads is plain text (CI on c8c16fb: a tried command's
 * `console.log(9)` reached the evidence as "\x1b[33m9\x1b[39m", because ci.yml sets
 * FORCE_COLOR=1 and the command inherited it).
 */
describe("plain output: stripAnsi", () => {
  it("removes colours, cursor moves, titles, links and the 8-bit CSI, and keeps the text, its line breaks and tabs", () => {
    const text = [
      "\u001b[33m9\u001b[39m",
      "\u001b[1m\u001b[31mFAIL\u001b[39m\u001b[22m\tsrc/clamp.test.js",
      "50%\u001b[2K\u001b[1G100%",
      "\u001b]0;npm test\u0007title gone",
      "\u001b]8;;https://example.test/\u001b\\a link\u001b]8;;\u001b\\",
      "\u009b32mgreen\u009b0m",
      "\u001b(Bcharset reset",
      "\u001bPdevice string\u001b\\after",
    ].join("\n");
    expect(stripAnsi(text)).toBe(
      [
        "9",
        "FAIL\tsrc/clamp.test.js",
        "50%100%",
        "title gone",
        "a link",
        "green",
        "charset reset",
        "after",
      ].join("\n"),
    );
  });

  it("leaves text without escapes as it was, and is idempotent", () => {
    const plain = "exit 0 in 12 ms\noutput:\n9\r\n[stderr]\nwarning: [x] 50% done";
    expect(stripAnsi(plain)).toBe(plain);
    const once = stripAnsi("\u001b[32mok\u001b[0m 1 - clamp");
    expect(stripAnsi(once)).toBe("ok 1 - clamp");
  });
});

describe("plain output: withoutForcedColour", () => {
  it("drops every variable that forces colour, in any letter case, and sets NO_COLOR=1; the rest stays and the input is not changed", () => {
    const env = {
      PATH: "/usr/bin",
      FORCE_COLOR: "1",
      Force_Color: "3",
      CLICOLOR_FORCE: "1",
      PY_COLORS: "1",
      no_color: "",
      HOME: "/home/a b",
    };
    const out = withoutForcedColour(env);
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/a b", NO_COLOR: "1" });
    expect(env.FORCE_COLOR).toBe("1");
    expect(COLOUR_FORCING_ENV).toEqual(["FORCE_COLOR", "CLICOLOR_FORCE", "PY_COLORS"]);
  });

  it("a Node program run with it prints no colour into a pipe, where FORCE_COLOR=1 made it print some", async () => {
    const argv = [process.execPath, "-e", "console.log(9)"];
    const forced = await run(argv, { env: { ...process.env, FORCE_COLOR: "1" } });
    expect(forced.stdout).toBe("\u001b[33m9\u001b[39m\n");
    const plain = await run(argv, {
      env: withoutForcedColour({ ...process.env, FORCE_COLOR: "1" }),
    });
    expect(plain.stdout).toBe("9\n");
  });
});
