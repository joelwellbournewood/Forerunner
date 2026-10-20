import { type Clock, log } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { GitHubMirror, PullReport, PushReport } from "./github.ts";

/**
 * Runs the GitHub mirror for every active project on a clock-driven interval (spec: "the
 * service exists for ... the GitHub mirror"; ADR 0024). One pass = `sync` per active project
 * (push, then pull); a project whose sync fails is reported and logged and does not stop the
 * others or the loop. Passes never overlap: a tick that finds one in flight joins it.
 */
export interface MirrorRunReport {
  at: string;
  /** Active projects visited. */
  projects: number;
  failed: number;
  errors: { projectId: string; error: string }[];
  push: PushReport;
  pull: PullReport;
}

export interface MirrorSchedulerOptions {
  mirror: GitHubMirror;
  store: StateStore;
  clock: Clock;
  intervalMs: number;
  /** Delay before the first pass after `start()`; default `intervalMs`. */
  initialDelayMs?: number;
}

const logger = log("state-api:mirror");

export class MirrorScheduler {
  private cancel: (() => void) | undefined;
  private running = false;
  private inFlight: Promise<MirrorRunReport> | undefined;
  runs = 0;
  lastReport: MirrorRunReport | undefined;

  constructor(private readonly opts: MirrorSchedulerOptions) {}

  get repo(): string {
    return this.opts.mirror.repoName;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.runOnce()
        .catch((e) => logger.warn("mirror pass failed", { error: String(e) }))
        .finally(() => {
          if (this.running) this.cancel = this.opts.clock.setTimeout(tick, this.opts.intervalMs);
        });
    };
    this.cancel = this.opts.clock.setTimeout(
      tick,
      this.opts.initialDelayMs ?? this.opts.intervalMs,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.cancel?.();
    this.cancel = undefined;
    await this.settle();
  }

  /** Resolves once no pass is in flight (tests, shutdown). */
  async settle(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /** One pass over every active project. Safe to call directly (admin "sync now", tests). */
  runOnce(): Promise<MirrorRunReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<MirrorRunReport> {
    const report: MirrorRunReport = {
      at: this.opts.clock.nowIso(),
      projects: 0,
      failed: 0,
      errors: [],
      push: { created: 0, updated: 0, unchanged: 0 },
      pull: { comments: 0, transitions: 0, ignored: 0 },
    };
    const projects = await this.opts.store.project.active();
    for (const project of projects) {
      report.projects += 1;
      try {
        const { push, pull } = await this.opts.mirror.sync(project.id);
        report.push.created += push.created;
        report.push.updated += push.updated;
        report.push.unchanged += push.unchanged;
        report.pull.comments += pull.comments;
        report.pull.transitions += pull.transitions;
        report.pull.ignored += pull.ignored;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        report.failed += 1;
        report.errors.push({ projectId: project.id, error });
        logger.warn("mirror sync failed for a project", { projectId: project.id, error });
      }
    }
    this.runs += 1;
    this.lastReport = report;
    logger.debug("mirror pass", {
      repo: this.repo,
      projects: report.projects,
      failed: report.failed,
      ...report.push,
      ...report.pull,
    });
    return report;
  }
}
