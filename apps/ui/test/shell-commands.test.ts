import { describe, expect, it } from "vitest";

/**
 * What the UI calls in the shell it runs in, held against what that shell grants its window.
 * A call the window is not granted is refused by Tauri's ACL ("Command ... not allowed by
 * ACL") and the control that made it does nothing: tauri-plugin-opener's page script made
 * Ctrl- and Shift-clicked links do nothing that way in the desktop app (Desktop app run
 * 41442343517). The plugins' own page scripts are audited by the desktop shell's
 * `webview_acl.rs` (cargo test); this file covers the calls the UI makes itself.
 */

/** Every source file of the UI, as text (Vite's glob, so no file system path is assumed). */
const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const DESKTOP_CAPABILITIES = import.meta.glob("../../desktop/src-tauri/capabilities/*.json", {
  import: "default",
  eager: true,
}) as Record<string, Capability>;
const MOBILE_CAPABILITIES = import.meta.glob("../../mobile/src-tauri/capabilities/*.json", {
  import: "default",
  eager: true,
}) as Record<string, Capability>;
const SHELL_SOURCES = import.meta.glob(
  [
    "../../desktop/src-tauri/build.rs",
    "../../desktop/src-tauri/src/lib.rs",
    "../../mobile/src-tauri/build.rs",
    "../../mobile/src-tauri/src/lib.rs",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

interface Capability {
  identifier: string;
  windows?: string[];
  platforms?: string[];
  permissions: Array<string | { identifier: string }>;
}

const shellFile = (suffix: string) => {
  const key = Object.keys(SHELL_SOURCES).find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no ${suffix}`);
  return SHELL_SOURCES[key] ?? "";
};

const isMobile = (file: string) => file.includes("/src/mobile/");
const desktopFiles = () => Object.keys(SOURCES).filter((f) => !isMobile(f));
const mobileFiles = () => Object.keys(SOURCES).filter(isMobile);

/** The permissions the capabilities grant to `window`. */
function grantedTo(caps: Record<string, Capability>, window: string): Set<string> {
  const out = new Set<string>();
  for (const cap of Object.values(caps)) {
    if (!(cap.windows ?? []).some((w) => w === window || w === "*")) continue;
    for (const p of cap.permissions) out.add(typeof p === "string" ? p : p.identifier);
  }
  return out;
}

/**
 * The commands a file sends with `invoke` (the first argument, which must be a string
 * literal: a computed name cannot be audited), and the calls whose name is not a literal.
 */
function invokedCommands(text: string): { names: string[]; computed: string[] } {
  const names: string[] = [];
  const computed: string[] = [];
  const call = /\binvoke\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    const rest = text.slice(m.index + m[0].length);
    const literal = /^(["'`])([^"'`$]+)\1/.exec(rest);
    if (literal?.[2]) names.push(literal[2]);
    else computed.push(rest.slice(0, 40));
  }
  return { names, computed };
}

/** The code of a file without its comments (a word in a comment is no call). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `snake_case` command → its `allow-` permission, as tauri-build names it. */
const allowFor = (command: string) => `allow-${command.replace(/_/g, "-")}`;

/**
 * Whether a plugin command (`plugin:<name>|<command>`) is granted by `permissions`: its own
 * `allow-` permission or the plugin's default set (which this test cannot open: the plugin
 * crate's own list says what it holds).
 */
function grantsPluginCommand(permissions: Set<string>, call: string): boolean {
  const m = /^plugin:([a-z0-9-]+)\|([a-z0-9_]+)$/.exec(call);
  if (!m) return false;
  const [, plugin, command] = m;
  return (
    permissions.has(`${plugin}:${allowFor(command ?? "")}`) || permissions.has(`${plugin}:default`)
  );
}

/** `listen`/`unlisten` from `@tauri-apps/api/event`: in `core:default` (core:event:default, Tauri 2.12). */
const CORE_DEFAULT = "core:default";

describe("what the UI calls in the shell its window runs in", () => {
  it("reads every invoke with its command, and flags a computed one", () => {
    expect(
      invokedCommands(
        'await invoke("open_folder", { path }); invoke<HotkeyStatus>("hotkey_status"); invoke<{ value: string | null }>(\n  "secure_store_get", { key }); invoke(name);',
      ),
    ).toEqual({
      names: ["open_folder", "hotkey_status", "secure_store_get"],
      computed: ["name);"],
    });
    const caps: Record<string, Capability> = {
      a: { identifier: "a", windows: ["main"], permissions: ["core:default", "allow-x"] },
      b: { identifier: "b", windows: ["splash"], permissions: ["allow-y"] },
      c: { identifier: "c", windows: ["*"], permissions: [{ identifier: "deep-link:default" }] },
    };
    expect([...grantedTo(caps, "main")].sort()).toEqual([
      "allow-x",
      "core:default",
      "deep-link:default",
    ]);
    expect(grantsPluginCommand(grantedTo(caps, "main"), "plugin:deep-link|get_current")).toBe(true);
    expect(grantsPluginCommand(grantedTo(caps, "main"), "plugin:opener|open_url")).toBe(false);
    expect(withoutComments("/** the prompt (a dialog) */\n  // confirm (later)\nconfirm();")).toBe(
      "\n\nconfirm();",
    );
  });

  it("every command a desktop screen invokes is the shell's own and granted to the main window", () => {
    const main = grantedTo(DESKTOP_CAPABILITIES, "main");
    expect(main.size).toBeGreaterThan(0);
    const build = shellFile("desktop/src-tauri/build.rs");
    const lib = shellFile("desktop/src-tauri/src/lib.rs");
    const handler = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? "";
    const manifest = /\.commands\(&\[([^\]]*)\]\)/.exec(build)?.[1] ?? "";
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const file of desktopFiles()) {
      const { names, computed } = invokedCommands(SOURCES[file] ?? "");
      for (const c of computed) problems.push(`${file}: invoke with a computed name: ${c}`);
      for (const name of names) {
        seen.add(name);
        if (name.startsWith("plugin:")) {
          // No window is granted a plugin command (capabilities/default.json, webview_acl.rs).
          problems.push(`${file}: invokes ${name}; the desktop shell drives its plugins from Rust`);
          continue;
        }
        if (!new RegExp(`::${name}\\b`).test(handler))
          problems.push(`${file}: ${name} is not in lib.rs's generate_handler!`);
        if (!manifest.includes(`"${name}"`))
          problems.push(`${file}: ${name} is not in build.rs's app manifest (it would be ungated)`);
        if (!main.has(allowFor(name)))
          problems.push(`${file}: ${name} is not granted to the main window (${allowFor(name)})`);
      }
    }
    expect(problems).toEqual([]);
    // The reader still finds the calls the screens make (Open folder, the hotkey in Settings).
    expect([...seen].sort()).toEqual(["hotkey_set", "hotkey_status", "open_folder"]);
  });

  it("the desktop screens reach the shell only through invoke and listen of @tauri-apps/api", () => {
    const problems: string[] = [];
    let listens = false;
    for (const file of desktopFiles()) {
      const text = SOURCES[file] ?? "";
      for (const m of text.matchAll(/from\s+["'](@tauri-apps\/[^"']+)["']/g)) {
        if (m[1] !== "@tauri-apps/api/core" && m[1] !== "@tauri-apps/api/event")
          problems.push(`${file}: imports ${m[1]} (audit what it invokes, then allow it here)`);
      }
      if (/from\s+["']@tauri-apps\/api\/event["']/.test(text)) listens = true;
      // `"__TAURI_INTERNALS__" in window` tells the shell apart; anything else calls past
      // the audited wrappers.
      const internals = text.match(/__TAURI_INTERNALS__/g)?.length ?? 0;
      const probes = text.match(/["']__TAURI_INTERNALS__["']\s+in\s+window/g)?.length ?? 0;
      if (internals !== probes) problems.push(`${file}: uses __TAURI_INTERNALS__ directly`);
      if (/\b__TAURI__\b/.test(text)) problems.push(`${file}: uses window.__TAURI__`);
    }
    expect(problems).toEqual([]);
    expect(listens).toBe(true);
    expect(grantedTo(DESKTOP_CAPABILITIES, "main").has(CORE_DEFAULT)).toBe(true);
  });

  it("no screen calls what a plugin's page script turns into a command its window is refused", () => {
    // tauri-plugin-dialog's script replaces window.alert and window.confirm (confirm then
    // returns a Promise, which is always truthy), tauri-plugin-notification's replaces the web
    // Notification API, and Tauri's drag script acts on data-tauri-drag-region: each calls a
    // command no window is granted (webview_acl.rs, REFUSED_SCRIPT_CALLS).
    const problems: string[] = [];
    for (const file of Object.keys(SOURCES)) {
      const text = withoutComments(SOURCES[file] ?? "");
      for (const name of ["alert", "confirm"]) {
        const own = new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(text);
        const global = new RegExp(`\\b(?:window|globalThis|self)\\.${name}\\s*\\(`).test(text);
        const bare = new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(text);
        if (global || (bare && !own)) problems.push(`${file}: calls ${name}()`);
      }
      if (/\bnew\s+Notification\s*\(|\bNotification\.(?:requestPermission|permission)\b/.test(text))
        problems.push(`${file}: uses the web Notification API`);
      if (/data-tauri-drag-region/.test(text))
        problems.push(`${file}: uses data-tauri-drag-region`);
    }
    expect(problems).toEqual([]);
  });

  it("every command a phone screen invokes is one the Android shell registers or grants", () => {
    const main = new Set<string>();
    for (const cap of Object.values(MOBILE_CAPABILITIES)) {
      if (!(cap.windows ?? []).includes("main")) continue;
      for (const p of cap.permissions) main.add(typeof p === "string" ? p : p.identifier);
    }
    const build = shellFile("mobile/src-tauri/build.rs");
    const lib = shellFile("mobile/src-tauri/src/lib.rs");
    const handler = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? "";
    // Without an app manifest every registered app command is allowed in every window
    // (Tauri 2); with one, each would need its permission like the desktop's.
    expect(build).not.toMatch(/AppManifest/);
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const file of mobileFiles()) {
      const { names, computed } = invokedCommands(SOURCES[file] ?? "");
      for (const c of computed) problems.push(`${file}: invoke with a computed name: ${c}`);
      for (const name of names) {
        seen.add(name);
        if (name.startsWith("plugin:")) {
          if (!grantsPluginCommand(main, name))
            problems.push(`${file}: ${name} is not granted to the phone's main window`);
        } else if (!new RegExp(`::${name}\\b`).test(handler)) {
          problems.push(`${file}: ${name} is not in the Android shell's generate_handler!`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(seen.has("shell_info")).toBe(true);
    expect(seen.has("plugin:barcode-scanner|scan")).toBe(true);
  });
});
