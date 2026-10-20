/**
 * Phase 7 gate helpers, release half (spec, build order, phase 7: "A UI change requested in
 * plain language ships as an update both users install, and a deliberately broken build rolls
 * back on its own"; spec M.1 to M.4; ADR 0046).
 *
 * Forerunner as a Forerunner project: the scenario world's repository is a stand-in for the
 * Forerunner repository (`FORERUNNER_FILES`: the standard docs and the one UI file the request
 * is about, `apps/ui/src/inbox-badge.ts`). The request becomes a task through the conversation
 * agent, a session changes the file on a branch, the critic reviews the PR, J merges it, and
 * `releaseFromMain` builds the release the publish job would build from that merge: the UI
 * file as it stands on `main`, `app/VERSION`, the build's doctor script, a changelog line
 * naming the request and the PR, signed with the build key and published on the world's fake
 * git host through `scenario-update.ts` (`releaseFeedOnHost`). A broken build is the same
 * release with a doctor that cannot start (`brokenDoctor`).
 *
 * `plantMarkers` and `changedMarkers` prove spec M.4's "config, memory and data untouched by
 * updates": a file in each of the install's config and data directories and in its memory
 * root before the updates, compared byte for byte after.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "@forerunner/platform";
import type { AuditLogRow } from "@forerunner/state";
import {
  brokenDoctor,
  DOCTOR_SCRIPT,
  healthyDoctor,
  type PublishedRelease,
  type ReleaseFeedOnHost,
  type ScenarioUpdater,
} from "./scenario-update.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

// ---------------------------------------------------------------------------------------
// The Forerunner stand-in repository

/** The UI file of the request, as the repository stores it (POSIX path). */
export const BADGE_FILE = "apps/ui/src/inbox-badge.ts";
/** The same file inside a release artefact. */
export const BADGE_ARTEFACT = "app/ui/inbox-badge.ts";

/** The inbox badge before the change: every open item counts. */
export const BADGE_BEFORE = [
  "export interface InboxItem {",
  "  id: string;",
  "  blocking: boolean;",
  '  status: "open" | "answered";',
  "}",
  "",
  "/** The number the inbox badge shows: every open item. */",
  "export function inboxBadgeCount(items: InboxItem[]): number {",
  '  return items.filter((i) => i.status === "open").length;',
  "}",
  "",
].join("\n");

/** The inbox badge after the change: only the open items that block a session count. */
export const BADGE_AFTER = [
  "export interface InboxItem {",
  "  id: string;",
  "  blocking: boolean;",
  '  status: "open" | "answered";',
  "}",
  "",
  "/** The number the inbox badge shows: the open items that block a session. */",
  "export function inboxBadgeCount(items: InboxItem[]): number {",
  '  return items.filter((i) => i.status === "open" && i.blocking).length;',
  "}",
  "",
].join("\n");

/** The maintainer doc of the apps module; the critic's docs-drift check wants it in the PR. */
export const APPS_DOC = "docs/maintainers/apps.md";

export const APPS_DOC_BEFORE = [
  "# Apps",
  "",
  "## Inbox badge",
  "",
  "The badge on the inbox shows the number of open items.",
  "",
].join("\n");

export const APPS_DOC_AFTER = [
  "# Apps",
  "",
  "## Inbox badge",
  "",
  "The badge on the inbox shows the number of open items that block a session; answered",
  "items and non-blocking questions do not count.",
  "",
].join("\n");

/** The files of the Forerunner stand-in's first commit. */
export const FORERUNNER_FILES: Record<string, string> = {
  "README.md":
    "# Forerunner\n\nThe Forerunner repository, as a project in Forerunner (spec M.1).\n",
  "AGENTS.md":
    "# AGENTS.md\n\nUI changes go through a task, a PR the critic reviews at tier 2, and a human merge.\nA PR that changes a module must touch its maintainer doc.\n",
  "package.json": '{\n  "name": "forerunner",\n  "private": true,\n  "type": "module"\n}\n',
  [BADGE_FILE]: BADGE_BEFORE,
  [APPS_DOC]: APPS_DOC_BEFORE,
};

// ---------------------------------------------------------------------------------------
// The release built from main

export interface ReleaseFromMainInput {
  version: string;
  /** The PR the changelog line names. */
  prNumber: number;
  /** The plain-language request the changelog line repeats. */
  request: string;
  /** When set, the build cannot start: its doctor fails with this reason. */
  broken?: string;
}

export interface BuiltRelease {
  published: PublishedRelease;
  /** The artefact's files, the UI file as read from main. */
  files: Record<string, string>;
  /** The changelog (the manifest's notes, the release row's `changelog`). */
  changelog: string;
}

/**
 * The publish job's input from the merged main: the UI file as it stands on the default
 * branch, the version file, the doctor, and a changelog line per request and PR.
 */
export async function releaseFromMain(
  world: ScenarioWorld,
  feed: ReleaseFeedOnHost,
  input: ReleaseFromMainInput,
): Promise<BuiltRelease> {
  const badge = await world.fileOnHost(BADGE_FILE);
  if (badge === null) throw new Error(`${BADGE_FILE} is not on main`);
  const files: Record<string, string> = {
    "app/VERSION": input.version,
    [BADGE_ARTEFACT]: badge,
    [DOCTOR_SCRIPT]:
      input.broken === undefined ? healthyDoctor(input.version) : brokenDoctor(input.broken),
  };
  const changelog = `## ${input.version}\n- ${input.request} (#${input.prNumber})`;
  const published = await feed.publish({ version: input.version, files, notes: changelog });
  return { published, files, changelog };
}

// ---------------------------------------------------------------------------------------
// What an update must not touch

export interface PlantedMarkers {
  /** Absolute path to the content written. */
  files: Record<string, string>;
}

/** One file each in the install's config and data directories and in its memory root. */
export function plantMarkers(up: ScenarioUpdater, install: Install): PlantedMarkers {
  const files: Record<string, string> = {
    [join(up.dirs.config, "settings.json")]: `{"install":"${install.name}","theme":"dark"}\n`,
    [join(up.dirs.data, "state.marker")]: `state of ${install.name} before the update\n`,
    [join(install.memoryRoot, "private", "marker.md")]:
      `# Lesson\n\nKeep ${install.name}'s memory.\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return { files };
}

/** The planted files that are missing or changed; empty when the update touched none. */
export function changedMarkers(markers: PlantedMarkers): string[] {
  return Object.entries(markers.files)
    .filter(([path, content]) => !existsSync(path) || readFileSync(path, "utf8") !== content)
    .map(([path]) => path);
}

// ---------------------------------------------------------------------------------------
// Reading back

/** The updater's audit rows of one human, in the order written. */
export async function updaterRows(world: ScenarioWorld, humanId: string): Promise<AuditLogRow[]> {
  return (await world.store.auditLog.list({ humanId })).filter((r) => r.tool.startsWith("update."));
}
