import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AppDirs,
  appDirs,
  dirname,
  ForerunnerError,
  isAbsolute,
  join,
  newId,
  resolve,
} from "@forerunner/platform";

/**
 * The install record `fr setup` writes under `<config>/install.json` (ADR 0026): where the
 * checkout that runs `fr` is and which node binary ran the setup. The desktop shell
 * (`apps/desktop/src-tauri/src/install.rs`, `parse_install_record`) reads it after
 * `current.json` and `FORERUNNER_INSTALL_DIR` and before `fr` on `PATH`, and runs
 * `node <installDir>/node_modules/tsx/dist/cli.mjs <installDir>/packages/runtime/src/cli/main.ts`.
 * The rules here mirror the shell's parser: `schema` is the number 1, `installDir` a non-empty
 * string, `node` optional (an empty string counts as absent). Nothing in the record is a
 * secret and nothing in it is hardcoded: both paths come from the running process.
 */
export const INSTALL_RECORD_FILE = "install.json";
export const INSTALL_RECORD_SCHEMA = 1;

export interface InstallRecord {
  schema: typeof INSTALL_RECORD_SCHEMA;
  /** Absolute path of the checkout (or staged version directory) that holds `fr`. */
  installDir: string;
  /** Node binary to run it with; the shell falls back to `node` on PATH when absent. */
  node?: string;
}

export function installRecordPath(dirs: AppDirs = appDirs()): string {
  return join(dirs.config, INSTALL_RECORD_FILE);
}

/** The shell's rules, as a function: throws `validation` on what `install.rs` would refuse. */
export function parseInstallRecord(text: string): InstallRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ForerunnerError("validation", `${INSTALL_RECORD_FILE}: not JSON`, {
      details: { reason: e instanceof Error ? e.message : String(e) },
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ForerunnerError("validation", `${INSTALL_RECORD_FILE}: not an object`);
  }
  const v = raw as Record<string, unknown>;
  if (v.schema !== INSTALL_RECORD_SCHEMA) {
    throw new ForerunnerError("validation", `${INSTALL_RECORD_FILE}: schema is not 1`, {
      details: { schema: v.schema },
    });
  }
  const installDir = typeof v.installDir === "string" && v.installDir !== "" ? v.installDir : null;
  if (installDir === null) {
    throw new ForerunnerError("validation", `${INSTALL_RECORD_FILE}: installDir missing`);
  }
  const node = typeof v.node === "string" && v.node !== "" ? v.node : undefined;
  return node === undefined
    ? { schema: INSTALL_RECORD_SCHEMA, installDir }
    : { schema: INSTALL_RECORD_SCHEMA, installDir, node };
}

/** The record on disk, or null when absent or unreadable (the shell falls through the same way). */
export function readInstallRecord(dirs: AppDirs = appDirs()): InstallRecord | null {
  try {
    return parseInstallRecord(readFileSync(installRecordPath(dirs), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The repository root this module runs from: `<root>/packages/runtime/src/setup/` is where
 * this file lives, in a checkout and in a staged version directory alike (the shell expects
 * `<installDir>/packages/runtime/src/cli/main.ts`). Never a configured or hardcoded path.
 */
export function repositoryRootFrom(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..", "..");
}

export interface CurrentInstallOptions {
  /** The node binary that runs this process; default `process.execPath`. */
  execPath?: string;
  /** The module to derive the root from; default this module. */
  moduleUrl?: string;
}

/** What this process knows about itself: its checkout and its node binary. */
export function currentInstallRecord(opts: CurrentInstallOptions = {}): InstallRecord {
  const installDir = repositoryRootFrom(opts.moduleUrl);
  const execPath = opts.execPath ?? process.execPath;
  return execPath && isAbsolute(execPath)
    ? { schema: INSTALL_RECORD_SCHEMA, installDir, node: execPath }
    : { schema: INSTALL_RECORD_SCHEMA, installDir };
}

/**
 * Atomic write (temp file in the config directory, fsync, rename): the shell never reads a
 * half-written record. The record is validated against the shell's rules first, and
 * `installDir` (and `node` when present) must be absolute, since the shell resolves nothing.
 */
export function writeInstallRecord(dirs: AppDirs, record: InstallRecord): string {
  const checked = parseInstallRecord(JSON.stringify(record));
  if (!isAbsolute(checked.installDir)) {
    throw new ForerunnerError("validation", `${INSTALL_RECORD_FILE}: installDir must be absolute`, {
      details: { installDir: checked.installDir },
    });
  }
  if (checked.node !== undefined && !isAbsolute(checked.node)) {
    throw new ForerunnerError("validation", `${INSTALL_RECORD_FILE}: node must be absolute`, {
      details: { node: checked.node },
    });
  }
  mkdirSync(dirs.config, { recursive: true });
  const final = installRecordPath(dirs);
  const temp = join(dirs.config, `${INSTALL_RECORD_FILE}.${newId()}.tmp`);
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, `${JSON.stringify(checked, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, final);
  return final;
}
