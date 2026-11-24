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
 * says GitHub still names the other project. L4i-left-8: the intake's docs write of a project
 * created with a brief records its outcome the same way (`intake_at`); false with no record.
 */
export function scaffoldLeftNoMarker(project: Pick<ProjectRow, "summary_cache">): boolean {
  const docs = (project.summary_cache as JsonObject | null | undefined)?.docs;
  if (!docs || typeof docs !== "object" || Array.isArray(docs)) return false;
  const d = docs as JsonObject;
  if (typeof d.error === "string") return true;
  if (d.together === true) return false;
  if (typeof d.scaffolded_at !== "string" && typeof d.intake_at !== "string") return false;
  const marker = d.marker;
  const other =
    !!marker &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as JsonObject).status === "other_project";
  return !(typeof d.pr_url === "string" && d.pr_url) || other;
}

/**
 * W8a-left-22 (w8-together): the Overview's one line when the repository guide could not go out
 * because every scaffold branch the project may write on holds someone else's pull request
 * (`summary_cache.docs.guide_stopped`, recorded by the scaffold and the guide refresh).
 */
export const GUIDE_BRANCHES_TAKEN_LINE =
  "The repository guide on GitHub was not updated: every branch this project may write its docs on holds someone else's pull request.";

/** The guide line for the Overview, or null (no stop recorded, or the project is closed). */
export function guideStoppedLine(
  project: Pick<ProjectRow, "status" | "summary_cache" | "settings">,
): string | null {
  if (project.status === "archived") return null;
  const docs = (project.summary_cache as JsonObject | null | undefined)?.docs;
  if (!docs || typeof docs !== "object" || Array.isArray(docs)) return null;
  return (docs as JsonObject).guide_stopped === "branches_taken" ? GUIDE_BRANCHES_TAKEN_LINE : null;
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

/**
 * w8-together (OJ-11, W8-join-1): Work together's consequence line on the Overview of a project
 * already here (at most 100 characters): its work moves into the repository's project.
 */
export function overviewTogetherLine(e: Pick<Elsewhere, "name" | "ids">): string {
  return withNameFitted(
    e,
    (name) =>
      `This project's tasks, plan and cards move into ${name}; both Forerunners work on it.`,
  );
}

/** OJ-11: the repository names no project that is not on this computer (nothing to join). */
export function nothingToWorkTogetherSentence(locator: string): string {
  return `${locator} names no other Forerunner project now, so there is nothing to work on together.`;
}

/** OJ-11: the repository names several such projects, so none is the one to work on. */
export function severalToWorkTogetherSentence(locator: string): string {
  return `${locator} names more than one other Forerunner project, so it cannot be worked on together.`;
}

/** OJ-11: the repository's project is on this computer: Make one project is the way. */
export function togetherHereSentence(locator: string, name: string): string {
  return `${locator} is already the project "${name}" on this computer: make one project of the two instead.`;
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
/**
 * The together line's Details (w8-status-write, W8-write-6; exact text from the checkers'
 * review: "you" only for the person looking): the status issue is where the other Forerunner's
 * work shows, beside its pull requests.
 */
export const TOGETHER_OVERVIEW_DETAILS =
  "What the other Forerunner does shows in its comment on the status issue and its pull requests on GitHub. You merge yours; its person merges theirs.";

/**
 * The Docs row of a doc a together project does not have (D9, C2-left-13): a together project
 * never writes docs, so the row says who does, not "not written yet".
 */
export function togetherDocNote(name: string): string {
  return name
    ? `The other Forerunner of "${name}" writes this doc on GitHub; this project does not write docs.`
    : "Another Forerunner writes this doc on GitHub; this project does not write docs.";
}

/**
 * The Docs tab's line of a together project (W8a-left-4 (c), fixup-w8-status-write): the other
 * Forerunner writes its docs on GitHub and this project only its status (its own comment on the
 * status issue, the Status row), so the tab does not say "Kept by the agent".
 */
export const TOGETHER_DOCS_KEPT_BY =
  "The other Forerunner keeps these docs on GitHub; this project keeps only its status.";

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
 * The chat's last words on a repository whose project is not on this computer. w8-together
 * (W8-join-4): project.create takes `together: true` now, so the hint says how to ask in chat
 * (before: "Open New project to work on it together.", OR-15's cut line).
 */
export const CHAT_TOGETHER_HINT = 'Say "work on it together" to join it here.';

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

/**
 * L4e-left-1 (the default of owner question OQ-L4e-1, built until the owner answers): what the
 * take-over's no-pull-request line offers beside it, on the Overview and Docs. The one place
 * the answer changes: `RepositoryUse.overviewOf` sets `tryAgainLine` from this, the screens show
 * Try again only with it, and `POST /projects/:id/take-over/retry` runs the scaffold again.
 */
export const TAKE_OVER_TRY_AGAIN_LINE =
  "Tries again to open the docs pull request that names this project.";

/** L4e-left-1: Try again opened the docs pull request that names this project. */
export function takeOverRetryOpenedSentence(n: number | null): string {
  return n
    ? `Opened #${n}: once you merge it, GitHub names this project.`
    : "Opened the docs pull request: once you merge it, GitHub names this project.";
}

/**
 * Why Try again could not open the take-over's docs pull request (L4i-left-6, design section 5
 * rule 8: what actually went wrong): `blocked`, a docs pull request that is not this project's
 * is open on the scaffold's branch (another project's, or one that names no project: Forerunner
 * never writes to it, L4i-left-2); `branches`, every scaffold branch on GitHub holds another
 * project's docs; `refused`, GitHub refused the push (the token cannot push, a branch rule);
 * `unreachable`, GitHub did not answer.
 */
export type TakeOverRetryFailure = "blocked" | "branches" | "refused" | "unreachable";

/**
 * L4e-left-1: Try again could not open it either, in one sentence with what to do, named by the
 * repository as the line above it names it (`owner/name`, L4i-left-5) and by what stopped it
 * (L4i-left-6).
 */
export function takeOverRetryFailedSentence(locator: string, why: TakeOverRetryFailure): string {
  switch (why) {
    case "blocked":
      return `The docs pull request still could not be opened: another docs pull request is open on ${locator}; close it on GitHub, then try again.`;
    case "branches":
      return `The docs pull request still could not be opened: its branches on ${locator} hold another project's docs; delete fr/docs-scaffold on GitHub, then try again.`;
    case "unreachable":
      return "The docs pull request still could not be opened: GitHub did not answer. Try again in a moment.";
    case "refused":
      return `The docs pull request still could not be opened: check that the saved GitHub token can push to ${locator}, then try again.`;
  }
}

/** L4e-left-1: a Try again with nothing to try (a pull request already names this project). */
export const TAKE_OVER_NOTHING_TO_RETRY =
  "There is nothing to try again: a docs pull request already names this project.";

/** L4i-left-7: Try again on a project with no repository on GitHub. */
export const TAKE_OVER_NO_REPOSITORY =
  "There is nothing to try again: this project has no repository on GitHub.";

/** L4i-left-7: Try again on a project that took no repository over (or whose take-over was undone). */
export const TAKE_OVER_NOT_TAKEN =
  "There is nothing to try again: this project took no repository over.";

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
