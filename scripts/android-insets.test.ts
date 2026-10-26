import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

// R.1, found on a Samsung SM-S911B with the signed rc.3 APK (targetSdk 37): Android 15+ draws
// every app targeting SDK 35+ edge to edge, and the WebView was laid out from y = 0, so the
// header sat under the clock and the sync badge under the battery icon. The Kotlin only
// compiles in CI (android.yml); this checks the wiring here, SafeAreaTest.kt checks the rule.

const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const kotlinDir = [
  "apps",
  "mobile",
  "src-tauri",
  "gen",
  "android",
  "app",
  "src",
  "main",
  "java",
  "app",
  "forerunner",
  "mobile",
];
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

describe("android edge-to-edge insets", () => {
  const activity = read(...kotlinDir, "MainActivity.kt");

  it("pads the activity's content view from the window insets", () => {
    expect(activity).toMatch(/ViewCompat\.setOnApplyWindowInsetsListener\(/);
    expect(activity).toMatch(/android\.R\.id\.content/);
    expect(activity).toMatch(/SafeArea\.padding\(/);
    expect(activity).toMatch(/setPadding\(/);
  });

  it("covers the system bars, the display cutout and the keyboard", () => {
    expect(activity).toMatch(/WindowInsetsCompat\.Type\.systemBars\(\)/);
    expect(activity).toMatch(/WindowInsetsCompat\.Type\.displayCutout\(\)/);
    expect(activity).toMatch(/WindowInsetsCompat\.Type\.ime\(\)/);
  });

  it("consumes the insets so the WebView never pads them a second time", () => {
    // A WebView that reports env(safe-area-inset-*) would otherwise add the same inset again.
    expect(activity).toMatch(/WindowInsetsCompat\.CONSUMED/);
  });

  it("keeps the padding rule pure and unit-tested on the JVM", () => {
    const rule = read(...kotlinDir, "SafeArea.kt");
    expect(rule).toMatch(/object SafeArea/);
    expect(rule).not.toMatch(/^import android\./m);
    const test = read(
      "apps",
      "mobile",
      "src-tauri",
      "gen",
      "android",
      "app",
      "src",
      "test",
      "java",
      "app",
      "forerunner",
      "mobile",
      "SafeAreaTest.kt",
    );
    expect(test).toMatch(/SafeArea\.padding\(/);
  });
});
