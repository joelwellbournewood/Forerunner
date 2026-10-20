import { existsSync, readFileSync } from "node:fs";
import {
  type AppDirs,
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  run,
} from "@forerunner/platform";
import type { AuditLogRepo, JsonValue, ReleaseRepo, ReleaseRow } from "@forerunner/state";
import { type CurrentPointer, readPointer, writePointer } from "./pointer.ts";
import type { Restarter, UpdateHumanPort } from "./ports.ts";

/**
 * First start after an update: the new version must pass a health check within a timeout.
 * Failure rolls back to the previous version named in current.json, records the release as
 * rolled_back with the reason, tells the human, and asks the shell to restart. Success marks
 * the release installed. Nothing here reads or writes config, memory or data; only the pointer.
 */
export interface HealthCheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthResult {
  ok: boolean;
  detail: string;
  checks?: HealthCheckItem[];
}

export interface HealthProbeContext {
  /** Version under test (current.json's current). */
  version: string;
  signal: AbortSignal;
}

export interface HealthProbe {
  readonly name: string;
  check(ctx: HealthProbeContext): Promise<HealthResult>;
}

/** Test probe: a fixed result, a function, or a promise that never settles (timeout tests). */
export class StaticHealthProbe implements HealthProbe {
  readonly name = "static";
  readonly calls: HealthProbeContext[] = [];
  constructor(
    private readonly result:
      | HealthResult
      | ((ctx: HealthProbeContext) => Promise<HealthResult> | HealthResult),
  ) {}
  async check(ctx: HealthProbeContext): Promise<HealthResult> {
    this.calls.push(ctx);
    return typeof this.result === "function" ? this.result(ctx) : this.result;
  }
}

/** The daemon's /health route (ADR 0011), located through daemon.json in the runtime dir. */
export class DaemonHealthProbe implements HealthProbe {
  readonly name = "daemon";
  private readonly f: typeof fetch;
  constructor(private readonly opts: { dirs: AppDirs; fetchImpl?: typeof fetch }) {
    this.f = opts.fetchImpl ?? fetch;
  }

  static daemonFile(dirs: AppDirs): string {
    return join(dirs.runtime, "daemon.json");
  }

  async check(ctx: HealthProbeContext): Promise<HealthResult> {
    const file = DaemonHealthProbe.daemonFile(this.opts.dirs);
    if (!existsSync(file))
      return { ok: false, detail: "daemon.json not found: the daemon did not start" };
    let url: string;
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown };
      if (typeof d.url !== "string") throw new Error("no url");
      url = d.url;
    } catch (e) {
      return { ok: false, detail: `daemon.json unreadable: ${errorMessage(e)}` };
    }
    try {
      const res = await this.f(`${url.replace(/\/$/, "")}/health`, { signal: ctx.signal });
      if (!res.ok) return { ok: false, detail: `daemon health answered ${res.status}` };
      const body = (await res.json()) as { ok?: unknown; version?: unknown };
      if (body.ok !== true) return { ok: false, detail: "daemon health did not report ok" };
      if (typeof body.version === "string" && body.version !== ctx.version) {
        return {
          ok: false,
          detail: `daemon reports version ${body.version}, expected ${ctx.version}`,
        };
      }
      return { ok: true, detail: `daemon healthy (${url})` };
    } catch (e) {
      return { ok: false, detail: `daemon unreachable: ${errorMessage(e)}` };
    }
  }
}

/** `fr doctor --json` (or any argv) must exit 0 and print a checks array with every item ok. */
export class DoctorHealthProbe implements HealthProbe {
  readonly name = "doctor";
  constructor(
    private readonly opts: {
      argv: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      /** Check names that must be ok; default: every reported check. */
      required?: string[];
    },
  ) {}

  async check(ctx: HealthProbeContext): Promise<HealthResult> {
    const r = await run(this.opts.argv, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      allowFailure: true,
      signal: ctx.signal,
      timeoutMs: 10 * 60 * 1000,
    });
    if (r.code !== 0) {
      return {
        ok: false,
        detail: `doctor exited ${r.code ?? "by signal"}: ${r.stderr.slice(-500)}`,
      };
    }
    let checks: HealthCheckItem[];
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not a list");
      checks = parsed.map((c) => {
        const item = c as { name?: unknown; ok?: unknown; detail?: unknown };
        return {
          name: String(item.name ?? ""),
          ok: item.ok === true,
          detail: String(item.detail ?? ""),
        };
      });
    } catch (e) {
      return { ok: false, detail: `doctor output unreadable: ${errorMessage(e)}` };
    }
    const required = this.opts.required;
    const failing = checks.filter((c) => !c.ok && (!required || required.includes(c.name)));
    return {
      ok: failing.length === 0,
      detail: failing.length ? `failing: ${failing.map((c) => c.name).join(", ")}` : "doctor ok",
      checks,
    };
  }
}

/** Daemon route when daemon.json exists, else the doctor command. */
export class DefaultHealthProbe implements HealthProbe {
  readonly name = "default";
  private readonly daemon: DaemonHealthProbe;
  private readonly doctor: DoctorHealthProbe | null;
  constructor(opts: { dirs: AppDirs; doctorArgv?: string[]; fetchImpl?: typeof fetch }) {
    this.daemon = new DaemonHealthProbe({ dirs: opts.dirs, fetchImpl: opts.fetchImpl });
    this.doctor = opts.doctorArgv ? new DoctorHealthProbe({ argv: opts.doctorArgv }) : null;
    this.file = DaemonHealthProbe.daemonFile(opts.dirs);
  }
  private readonly file: string;

  check(ctx: HealthProbeContext): Promise<HealthResult> {
    if (existsSync(this.file) || !this.doctor) return this.daemon.check(ctx);
    return this.doctor.check(ctx);
  }
}

export interface HealthCheckDeps {
  dirs: AppDirs;
  clock: Clock;
  probe: HealthProbe;
  timeoutMs: number;
  store: { release: ReleaseRepo; auditLog: AuditLogRepo };
  human: UpdateHumanPort;
  restarter: Restarter;
  /** Version of the running process; a mismatch with current.json is itself a failure. */
  runningVersion?: string;
  humanId?: string | null;
}

export type HealthOutcome =
  | { kind: "not_pending"; pointer: CurrentPointer | null }
  | { kind: "healthy"; version: string; detail: string }
  | { kind: "rolled_back"; from: string; to: string; reason: string }
  | { kind: "failed_no_previous"; version: string; reason: string };

const logger = log("update:health");

/** Run the probe under the timeout; a timeout is a failed result, never an exception. */
export async function probeWithTimeout(
  probe: HealthProbe,
  version: string,
  timeoutMs: number,
  clock: Clock,
): Promise<HealthResult> {
  const ac = new AbortController();
  const timedOut = new Promise<HealthResult>((resolveTimeout) => {
    ac.signal.addEventListener(
      "abort",
      () => resolveTimeout({ ok: false, detail: `health check timed out after ${timeoutMs} ms` }),
      { once: true },
    );
  });
  const cancel = clock.setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await Promise.race([
      probe
        .check({ version, signal: ac.signal })
        .catch(
          (e): HealthResult => ({ ok: false, detail: `health probe threw: ${errorMessage(e)}` }),
        ),
      timedOut,
    ]);
  } finally {
    cancel();
  }
}

async function findRelease(repo: ReleaseRepo, version: string): Promise<ReleaseRow | undefined> {
  const [row] = await repo.list(
    { release_version: version },
    { orderBy: "created_at desc", limit: 1 },
  );
  return row;
}

async function setReleaseStatus(
  repo: ReleaseRepo,
  version: string,
  to: "installed" | "rolled_back" | "failed",
  health: JsonValue,
): Promise<ReleaseRow | undefined> {
  const row = await findRelease(repo, version);
  if (!row) return undefined;
  if (row.status === to) return row;
  try {
    return await repo.setStatus(row.id, row.version, to, health);
  } catch (e) {
    logger.warn("release row not updated", { version, to, error: errorMessage(e) });
    return row;
  }
}

/**
 * The startup health check. Call it once on every start; it does nothing unless current.json
 * says a health check is pending.
 */
export async function runStartupHealthCheck(deps: HealthCheckDeps): Promise<HealthOutcome> {
  const pointer = readPointer(deps.dirs);
  if (pointer?.state !== "pending_health_check" || !pointer.current) {
    return { kind: "not_pending", pointer };
  }
  const version = pointer.current;
  const now = () => deps.clock.nowIso();
  let result: HealthResult;
  if (deps.runningVersion !== undefined && deps.runningVersion !== version) {
    result = {
      ok: false,
      detail: `running version ${deps.runningVersion} is not the staged ${version}: the new build did not start`,
    };
  } else {
    result = await probeWithTimeout(deps.probe, version, deps.timeoutMs, deps.clock);
  }
  const health: JsonValue = {
    ok: result.ok,
    detail: result.detail,
    probe: deps.probe.name,
    checkedAt: now(),
    ...(result.checks
      ? { checks: result.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })) }
      : {}),
  };

  if (result.ok) {
    writePointer(deps.dirs, { ...pointer, state: "installed", updatedAt: now() });
    await setReleaseStatus(deps.store.release, version, "installed", health);
    await deps.store.auditLog.append({
      tool: "update.health",
      allowed: true,
      input_summary: `health check of ${version} (${deps.probe.name})`,
      result_summary: result.detail,
      human_id: deps.humanId ?? null,
      occurred_at: now(),
    });
    logger.info("update healthy", { version });
    return { kind: "healthy", version, detail: result.detail };
  }

  const reason = result.detail;
  if (!pointer.previous) {
    writePointer(deps.dirs, {
      ...pointer,
      state: "failed",
      updatedAt: now(),
      lastRollback: { from: version, to: null, reason, at: now(), automatic: true },
    });
    await setReleaseStatus(deps.store.release, version, "failed", health);
    await deps.store.auditLog.append({
      tool: "update.health",
      allowed: false,
      denied_reason: reason,
      input_summary: `health check of ${version} (${deps.probe.name})`,
      result_summary: "failed; no previous version to roll back to",
      human_id: deps.humanId ?? null,
      occurred_at: now(),
    });
    await deps.human.notify({
      title: `Update ${version} failed its health check`,
      body: `${reason}\n\nNo previous version is available to roll back to. Reinstall the last good release.`,
      severity: "error",
      humanId: deps.humanId ?? null,
    });
    return { kind: "failed_no_previous", version, reason };
  }

  const to = pointer.previous;
  writePointer(deps.dirs, {
    schema: 1,
    current: to,
    previous: null,
    state: "installed",
    updatedAt: now(),
    lastRollback: { from: version, to, reason, at: now(), automatic: true },
  });
  await setReleaseStatus(deps.store.release, version, "rolled_back", health);
  await deps.store.auditLog.append({
    tool: "update.rollback",
    allowed: true,
    input_summary: `automatic rollback: health check of ${version} failed (${deps.probe.name})`,
    result_summary: `rolled back to ${to}: ${reason}`,
    human_id: deps.humanId ?? null,
    occurred_at: now(),
  });
  await deps.human.notify({
    title: `Update ${version} rolled back`,
    body: `The new version failed its health check and Forerunner went back to ${to}.\n\nReason: ${reason}`,
    severity: "error",
    humanId: deps.humanId ?? null,
  });
  logger.warn("update rolled back", { from: version, to, reason });
  try {
    await deps.restarter.restart({ reason: "rollback", targetVersion: to, fromVersion: version });
  } catch (e) {
    throw new ForerunnerError(
      "internal",
      `rollback written but restart failed: ${errorMessage(e)}`,
      {
        details: { from: version, to },
        cause: e,
      },
    );
  }
  return { kind: "rolled_back", from: version, to, reason };
}
