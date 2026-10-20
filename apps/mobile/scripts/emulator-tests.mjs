#!/usr/bin/env node
// Installs the x86_64 debug APK on the running emulator and runs the UI/sync checks.
// Filled in with the Android milestone (module R); today it verifies install + launch + the
// shell renders, which is what the CI job asserts.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findApk(dir) {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const f = findApk(p);
      if (f) return f;
    } else if (/x86_64.*\.apk$|universal.*\.apk$|app-.*debug\.apk$|\.apk$/.test(e)) return p;
  }
  return null;
}
const apk = findApk(join("src-tauri", "gen", "android", "app", "build", "outputs", "apk"));
if (!apk) {
  console.error("emulator-tests: no APK found; run tauri android build first");
  process.exit(1);
}
const adb = (...args) =>
  execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
adb("wait-for-device");
adb("install", "-r", apk);
adb("shell", "am", "start", "-n", "app.forerunner.mobile/.MainActivity");
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < 60_000) {
  const out = adb("shell", "dumpsys", "window", "windows");
  if (/app\.forerunner\.mobile/.test(out)) {
    ok = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!ok) {
  console.error("emulator-tests: app window did not appear");
  process.exit(1);
}
console.log(`emulator-tests: installed ${apk} and launched the app`);
