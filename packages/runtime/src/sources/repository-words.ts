import type { JsonObject, ProjectRow } from "@forerunner/state";

/**
 * The words and settings readers of one repository, one project (d1109-onerepo-link, ADR 0117),
 * apart from `repository-use.ts` so a page or the UI's fake daemon can say the same sentences
 * without loading the git host, the store or the file system. Every sentence follows design
 * section 5: one sentence read at a glance, names in quotes, no ids.
 */

/** A project nobody else touched for this many days may be taken over (the 14-day rule). */
export const ACTIVE_ELSEWHERE_DAYS = 14;

/** The settings key of a project that took a repository over (`took_over`). */
export const TOOK_OVER_KEY = "took_over";
/** The settings key of a project worked on together with another Forerunner (D9). */
export const TOGETHER_KEY = "together";
/** The settings key d1109-onerepo-join writes on the kept project (read here, never written). */
export const JOINED_FROM_KEY = "joined_from";
/** The settings key project.create's Undo writes on a removed project (W15-36). */
const REMOVED_NAME_KEY = "removed_name";

function settingsOf(project: Pick<ProjectRow, "settings">): JsonObject {
  const s = project.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

/** The ids a project answers to: its own and the ones joined into it (d1109-onerepo-join). */
export function projectIdsOf(project: Pick<ProjectRow, "id" | "settings">): string[] {
  const joined = settingsOf(project)[JOINED_FROM_KEY];
  const ids = Array.isArray(joined) ? joined.filter((x): x is string => typeof x === "string") : [];
  return [project.id, ...ids.filter((id) => id !== project.id)];
}

/** What a together project keeps of the repository's project (D9), or null for any other. */
export interface TogetherFacts {
  name: string;
  at: string;
  activeOn: string | null;
  login: string | null;
}

export function togetherOf(project: Pick<ProjectRow, "settings">): TogetherFacts | null {
  const t = settingsOf(project)[TOGETHER_KEY];
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const o = t as JsonObject;
  return {
    name: typeof o.name === "string" ? o.name : "",
    at: typeof o.at === "string" ? o.at : "",
    activeOn: typeof o.activeOn === "string" ? o.activeOn : null,
    login: typeof o.login === "string" ? o.login : null,
  };
}

/** Whether the project works on its repository together with another Forerunner (D9). */
export function isTogether(project: Pick<ProjectRow, "settings">): boolean {
  return togetherOf(project) !== null;
}

/** A take-over a project recorded: the project ids it replaced in the repository. */
export interface TookOverFacts {
  projects: string[];
  name: string;
  at: string;
  removed: boolean;
}

export function tookOverOf(project: Pick<ProjectRow, "settings">): TookOverFacts | null {
  const t = settingsOf(project)[TOOK_OVER_KEY];
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const o = t as JsonObject;
  const projects = Array.isArray(o.projects)
    ? o.projects.filter((x): x is string => typeof x === "string")
    : [];
  return {
    projects,
    name: typeof o.name === "string" ? o.name : "",
    at: typeof o.at === "string" ? o.at : "",
    removed: o.removed === true,
  };
}

/**
 * L4-github-102: the project's last scaffold run (`summary_cache.docs`, written by the
 * scaffold) left no docs pull request that names this project: it failed, opened nothing, or
 * left another project's marker. Read only for a take-over (`overviewOf`): the Overview then
 * says GitHub still names the other project. False with no record (the intake writes the docs
 * of a project created with a brief).
 */
export function scaffoldLeftNoMarker(project: Pick<ProjectRow, "summary_cache">): boolean {
  const docs = (project.summary_cache as JsonObject | null | undefined)?.docs;
  if (!docs || typeof docs !== "object" || Array.isArray(docs)) return false;
  const d = docs as JsonObject;
  if (typeof d.error === "string") return true;
  if (d.together === true || typeof d.scaffolded_at !== "string") return false;
  const marker = d.marker;
  const other =
    !!marker &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as JsonObject).status === "other_project";
  return !(typeof d.pr_url === "string" && d.pr_url) || other;
}

/** A project whose creation was undone (W15-36): archived, with its old name kept. */
export function isRemovedProject(project: Pick<ProjectRow, "status" | "settings">): boolean {
  return project.status === "archived" && typeof settingsOf(project)[REMOVED_NAME_KEY] === "string";
}

export function shownNameOf(project: Pick<ProjectRow, "name" | "status" | "settings">): string {
  const kept = settingsOf(project)[REMOVED_NAME_KEY];
  return project.status === "archived" && typeof kept === "string" && kept ? kept : project.name;
}

/** When the repository's project was last worked on, and whether by this install's account. */
export interface Activity {
  at: string;
  own: boolean;
}

/** The project (or projects) a repository names that is not on this computer. */
export interface Elsewhere {
  /** The ids the repository names that this install does not know (marker first). */
  ids: string[];
  /** The marker's name for one id, cleaned; null when unknown or flagged. */
  name: string | null;
  /** The latest update of a pull request carrying one of the marks, any account. */
  lastActive: Activity | null;
  /** The latest update by another GitHub account within `ACTIVE_ELSEWHERE_DAYS`, else null. */
  otherAccount: string | null;
  canWorkTogether: boolean;
  canTakeOver: boolean;
}

/** "3 Nov" in the person's time zone (UTC when it is not known). */
export function dayWords(iso: string, timezone?: string | null): string {
  let zone = timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short" })
    .format(new Date(iso))
    .replace(",", "");
}

/** OR-02: a link another project here uses. */
export function inUseSentence(
  use: { kind: "repo" | "folder"; locator: string },
  name: string,
): string {
  return use.kind === "repo"
    ? `${use.locator} is already the project "${name}". Open it, or add this to it as new work.`
    : `This folder is already used by the project "${name}". Open it, or add this to it as new work.`;
}

/** The together creation's refusal for an id that is a row here (OR-15). */
export function alreadyHereSentence(locator: string, name: string): string {
  return `${locator} is already the project "${name}". Open it.`;
}

function projectWords(e: Pick<Elsewhere, "ids" | "name">): string {
  if (e.ids.length > 1) return "other Forerunner projects";
  return e.name ? `the Forerunner project "${e.name}"` : "another Forerunner project";
}

/** OR-06: a repository whose project is not on this computer, as the offer says it. */
export function elsewhereSentence(locator: string, e: Elsewhere, timezone?: string | null): string {
  const many = e.ids.length > 1;
  const subject = many
    ? `${locator} is already used by other Forerunner projects`
    : `${locator} is already ${projectWords(e)}`;
  if (e.otherAccount) {
    const day = dayWords(e.otherAccount, timezone);
    return many
      ? `${subject}; another GitHub account worked on them on ${day}. One repository is one project, so link another repository.`
      : `${subject}; another GitHub account worked on it on ${day}. One repository is one project, so work on it together here.`;
  }
  const active = e.lastActive
    ? `; last active on GitHub on ${dayWords(e.lastActive.at, timezone)}${e.lastActive.own ? ", from your account" : ""}`
    : "";
  return many
    ? `${subject}, which are not on this computer${active}. Take it over if nobody works on them any more.`
    : `${subject}, which is not on this computer${active}. Work on it together, or take it over if nobody works on it any more.`;
}

/** The name an offer's consequence lines use for the repository's project. */
export function quotedNameOf(e: Pick<Elsewhere, "name" | "ids">): string {
  if (e.ids.length > 1) return "those projects";
  return e.name ? `"${e.name}"` : "that project";
}

/** A consequence line's limit (design section 5 rule 1). */
export const CONSEQUENCE_LINE_MAX = 100;

/** `text` whole when it fits `max`, else cut at a word with "…" (a name is never cut mid-word). */
function cutAtWord(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * L4-github-109: a consequence line that quotes the repository's project stays within
 * `CONSEQUENCE_LINE_MAX`: the name whole when it fits, else cut at a word (a marker's name may be
 * 60 characters, so the line under Take it over read 144).
 */
function withNameFitted(
  e: Pick<Elsewhere, "name" | "ids">,
  line: (quotedName: string) => string,
  shorter: (quotedName: string) => string = line,
): string {
  const whole = line(quotedNameOf(e));
  if (whole.length <= CONSEQUENCE_LINE_MAX || e.ids.length > 1 || !e.name) return whole;
  const room = CONSEQUENCE_LINE_MAX - shorter('""').length;
  return shorter(`"${cutAtWord(e.name, room)}"`);
}

/** Work together's consequence line (at most 100 characters). */
export function togetherLine(e: Pick<Elsewhere, "name" | "ids">, withBrief: boolean): string {
  return withNameFitted(e, (name) =>
    withBrief
      ? `Works on ${name} too and plans your brief as its new work.`
      : `This Forerunner works on ${name} too; nothing on GitHub changes now.`,
  );
}

/** Take it over's consequence line (at most 100 characters). */
export function takeOverLine(e: Pick<Elsewhere, "name" | "ids">): string {
  return withNameFitted(
    e,
    (name) =>
      `The repository then names this project: choose it only if no Forerunner uses ${name} now.`,
    (name) => `GitHub then names this project; choose it only if nobody uses ${name} now.`,
  );
}

/** Take it over's Details line. */
export function takeOverDetails(e: Pick<Elsewhere, "name" | "ids">): string {
  return `The pull requests of ${quotedNameOf(e)} stay as they are.`;
}

/**
 * OR-11: a URL on a git host this install does not use. L4-github-109: it names the host this
 * install is set up for (`configured`: an Enterprise install's own host from its API base,
 * `configuredWebHost`), never github.com by default alone.
 */
export function otherHostSentence(host: string, configured = "github.com"): string {
  return `Forerunner works with repositories on ${configured}, not ${host}. Link a GitHub repository or a folder.`;
}

/**
 * The web host a person links repositories on, from the hosts this install accepts
 * (`repoHostsFor`: the remote base's and the API base's): an Enterprise host when one is set up,
 * else github.com.
 */
export function configuredWebHost(hosts: readonly string[]): string {
  return hosts.find((h) => h !== "github.com") ?? "github.com";
}

/** OR-15: Work together needs GitHub's answer (it does not fail open as creation does). */
export const TOGETHER_UNREADABLE =
  "GitHub did not answer, so the project cannot be checked. Try again.";

/** OR-15: Work together on a folder. */
export function togetherFolderSentence(locator: string | null): string {
  return locator
    ? `Work together needs the GitHub repository: link ${locator}, not a folder.`
    : "Work together needs the GitHub repository: link it, not a folder.";
}

/** The Overview line of a together project (D9). */
export const TOGETHER_OVERVIEW_LINE =
  "Shared on GitHub with another Forerunner: each keeps its own tasks.";
export const TOGETHER_OVERVIEW_DETAILS =
  "What the other Forerunner does shows in its pull requests on GitHub; each of you merges your own.";

/**
 * OR-09 (L3-github-5): the Docs row of a status kept in the app because another status pull
 * request is open on `fr/status` while this project's status pull request is on: the holder by
 * its name when it is a project here, else what it is, and what to do. Never "(Settings turns
 * it on)", which was untrue while the setting is on.
 */
export function heldStatusNote(holder: { projectName: string | null; marked: boolean }): string {
  if (holder.projectName)
    return `Kept in the app while the status pull request of "${holder.projectName}" is open on GitHub.`;
  return holder.marked
    ? "Kept in the app while another project's status pull request is open on GitHub; close it there to have this one's there."
    : "Kept in the app while another status pull request is open on GitHub; close it there to have this one's there.";
}

/**
 * L4-github-103 (D9): `settings.set status_pull_request` on a project worked on together is
 * refused in this sentence (Settings, chat and voice alike): such a project writes nothing to
 * the repository, so a status pull request is never opened for it.
 */
export function togetherStatusPullRequestSentence(name: string): string {
  return `You work on "${name}" together with another Forerunner, so its status stays in the app (Docs, Status); no status pull request is opened.`;
}

/** The Docs row of a together project's status (D9). */
export function togetherStatusNote(name: string): string {
  return `Kept in the app: you work on "${name}" together, so GitHub's copy is left as it is.`;
}

/**
 * The Docs row of a doc a together project does not have (D9, C2-left-13): a together project
 * never writes docs, so the row says who does, not "not written yet".
 */
export function togetherDocNote(name: string): string {
  return name
    ? `The other Forerunner of "${name}" writes this doc on GitHub; this project does not write docs.`
    : "Another Forerunner writes this doc on GitHub; this project does not write docs.";
}

/** Why a link was refused (`details.cause` of the 409): the UI's offer reads it. */
export type LinkRefusalCause =
  | "repository_in_use"
  | "repository_used_elsewhere"
  | "other_host"
  | "together_refused"
  | "github_unreadable";

/** The offer's facts the refusal carries (the person never sees an id; the buttons use them). */
export interface LinkRefusalDetails {
  cause: LinkRefusalCause;
  /** The project on this computer that uses the link (repository_in_use). */
  projectId?: string;
  projectName?: string;
  /** The ids the repository names that are not on this computer (repository_used_elsewhere). */
  projects?: string[];
  canWorkTogether?: boolean;
  canTakeOver?: boolean;
  /** The consequence lines of the offer's buttons, in the daemon's words. */
  togetherLine?: string;
  takeOverLine?: string;
  takeOverDetails?: string;
  /** The refusal quotes repository text (a marker's name): data, for chat (ADR 0114). */
  untrusted?: { source: "repo_file"; origin: string };
}

/** Whether a refusal's cause is a link's (the route answers its details as they are). */
export function isLinkRefusalCause(cause: unknown): cause is LinkRefusalCause {
  return (
    cause === "repository_in_use" ||
    cause === "repository_used_elsewhere" ||
    cause === "other_host" ||
    cause === "together_refused" ||
    cause === "github_unreadable"
  );
}

/**
 * The chat's last words on a repository whose project is not on this computer (OR-15's cut
 * line: project.create has no together flag yet, the New project dialog has Work together).
 */
export const CHAT_TOGETHER_HINT = "Open New project to work on it together.";

/**
 * OR-07: the Overview line of a project whose repository (this computer's copy of its default
 * branch) names a Forerunner project that is not on this computer: 'o/kite is also the
 * Forerunner project "Kite club", which is not on this computer.', with "; another GitHub
 * account worked on it on 8 Nov" when one did within the 14 days (then there is no Take it
 * over).
 */
export function alsoElsewhereSentence(
  locator: string,
  e: Pick<Elsewhere, "ids" | "name" | "otherAccount">,
  timezone?: string | null,
): string {
  const many = e.ids.length > 1;
  const subject = many
    ? `${locator} is also used by other Forerunner projects, which are not on this computer`
    : `${locator} is also ${projectWords(e)}, which is not on this computer`;
  if (!e.otherAccount) return `${subject}.`;
  return `${subject}; another GitHub account worked on ${many ? "them" : "it"} on ${dayWords(e.otherAccount, timezone)}.`;
}

/** OR-07: an agent never takes a repository over (repo.take_over). */
export const ONLY_YOU_TAKE_OVER = "Only you can take over a repository.";

/** OR-07: repo.take_over's change sentence, also the Changes row: 'Took over o/kite from "Kite club".' */
export function tookOverSentence(locator: string, e: Pick<Elsewhere, "ids" | "name">): string {
  return `Took over ${locator} from ${projectFromWords(e)}.`;
}

/**
 * C2-left-11: repo.take_over's sentence when its docs pull request could not be opened: what it
 * did (here) and what it could not do (GitHub still names the other project).
 */
export function tookOverNoPullRequestSentence(
  locator: string,
  e: Pick<Elsewhere, "ids" | "name">,
): string {
  const from = projectFromWords(e);
  return `Took over ${locator} from ${from} here, but the docs pull request that names this project could not be opened, so GitHub still names ${from}.`;
}

/** OR-07: repo.take_over's read-back question. */
export function takeOverAsk(locator: string, e: Pick<Elsewhere, "ids" | "name">): string {
  return `Take over ${locator} from ${projectFromWords(e)}? ${takeOverLine(e)}`;
}

/** OR-07: the sentence of repo.take_over's Undo. */
export function takeOverUndoneSentence(
  locator: string,
  e: Pick<Elsewhere, "ids" | "name">,
): string {
  return `${locator} is no longer taken over from ${projectFromWords(e)}.`;
}

function projectFromWords(e: Pick<Elsewhere, "ids" | "name">): string {
  if (e.ids.length > 1) return "other Forerunner projects";
  return e.name ? `"${e.name}"` : "another Forerunner project";
}

/*
 * OR-07: why repo.take_over's Undo cannot be done now, as every command's `undoBlocked` says it:
 * a fragment the screens complete ("Cannot be undone now: …." on Changes, "Not undone: …." after
 * a refused press; the chat's answer the same), so it starts in lower case (GitHub keeps its
 * capital) and has no final period. The review of the fix saw the full sentences these were
 * read on Changes as "Cannot be undone now: Its pull request on GitHub already names this
 * project: close it there first..".
 */
/** OR-07: repo.take_over's Undo while its docs pull request is open. */
export const TAKE_OVER_UNDO_OPEN =
  "its pull request on GitHub already names this project. Close it there first";
/** OR-07: repo.take_over's Undo once that pull request merged. */
export const TAKE_OVER_UNDO_MERGED = "the repository already names this project on GitHub";
/** OR-07: Undo cannot see GitHub, so it cannot tell whether the repository names this project. */
export const TAKE_OVER_UNDO_UNREADABLE =
  "GitHub did not answer, so the repository cannot be checked. Try again";

/** OR-07: Take it over refused at the press because GitHub could not be read. */
export const TAKE_OVER_UNREADABLE =
  "GitHub did not answer, so the repository cannot be checked. Try again.";

/** OR-07: Take it over refused because the repository names no project elsewhere now. */
export function nothingToTakeOverSentence(locator: string): string {
  return `${locator} names no Forerunner project that is not on this computer now, so there is nothing to take over.`;
}

/** OR-07: Take it over refused because another GitHub account worked on it within 14 days. */
export function takeOverActiveSentence(
  locator: string,
  e: Pick<Elsewhere, "ids" | "name" | "otherAccount">,
  timezone?: string | null,
): string {
  return `${alsoElsewhereSentence(locator, e, timezone).replace(/\.$/, "")}, so it cannot be taken over now.`;
}
