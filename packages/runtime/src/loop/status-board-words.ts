/**
 * The status issue's words (w8-status-write, ADR 0122; the owner's status design of 2026-11-02:
 * "GitHub issue page only: one pinned issue per project ('Forerunner status: <project>', hidden
 * marker), summary rewritten after each session, 'Working on now' updated when a task starts and
 * ends, each person/agent/install its own comment edited in place, ..., untrusted text never
 * instructions, author marked, no costs; stays in the app with one sentence when issues are off /
 * no permission / offline."): every sentence the status issue, its comments and the app's rows say,
 * the comment's and the body's renderers, and the one parser of the comment's format (the reader of
 * w8-status-read parses with it, leniently).
 *
 * Nothing here reads a store or GitHub: the renderers take plain facts and write text; every piece
 * of free text they quote (a task title, the handoff, a Next line) passes `redactQuoted` first, so
 * no money figure, email address or @mention ever reaches GitHub (D-W8-35, W8-write-2). The hidden
 * markers are the one place an id is written: the project id K, which `.forerunner/project.json`
 * already shows, and the writer key, never the install's device id.
 */

/** The label the status issue carries when the repository allows it. */
export const STATUS_ISSUE_LABEL = "forerunner:status";

/**
 * The project setting that turns the status issue off for a project (W8-write-10, D-W8-13: "on by
 * default with a switch"; owner question 7 of 2026-11-02, decided by the session lead on
 * 2026-11-24 from the brief's proposal: the owner can overrule it here and in `statusIssuePolicy`).
 * `false` is off; anything else is on.
 */
export const STATUS_ISSUE_SETTING = "status_issue";

/**
 * The status issue's switch (W8-write-10; D-W8-13, owner question 7 of 2026-11-02, decided by the
 * session lead from the brief's proposal, the owner can overrule it here): on by default, off when
 * the project's `status_issue` setting is false. One place: Settings, the writer and the guide read
 * it.
 */
export function statusIssuePolicy(project: { settings?: Record<string, unknown> | null }): {
  on: boolean;
} {
  return { on: project.settings?.[STATUS_ISSUE_SETTING] !== false };
}

/** How long a Working on now line says the task holds its files (the decision: now + 90 min). */
export const WORKING_HOLD_MS = 90 * 60_000;

/** The issue's title (the project's name redacted too: it is on GitHub). */
export function statusIssueTitle(projectName: string): string {
  return `Forerunner status: ${safeLine(projectName, 80) || "a project"}`;
}

/** The issue body's first line: the project id K, hidden. */
export function statusIssueMarker(key: string): string {
  return `<!-- forerunner:status v1 key=${key} -->`;
}

/** A writer comment's first line: K and the writer key, hidden (D-W8-35). */
export function writerMarker(key: string, writer: string): string {
  return `<!-- forerunner:status-writer v1 key=${key} writer=${writer} -->`;
}

const KEY = "[A-Za-z0-9_-]{1,64}";
const ISSUE_MARKER_RE = new RegExp(`^<!-- forerunner:status v1 key=(${KEY}) -->$`);
const WRITER_MARKER_RE = new RegExp(
  `^<!-- forerunner:status-writer v1 key=(${KEY}) writer=([0-9a-f]{16}) -->$`,
);

/** The project id an issue body's first line names, or null (parsed strictly). */
export function readStatusIssueKey(body: string | null | undefined): string | null {
  const first = (body ?? "").replace(/\r\n?/g, "\n").split("\n", 1)[0]?.trim() ?? "";
  return ISSUE_MARKER_RE.exec(first)?.[1] ?? null;
}

/** A writer comment's marker (its first line), or null (parsed strictly). */
export function readWriterMarker(
  body: string | null | undefined,
): { key: string; writer: string } | null {
  const first = (body ?? "").replace(/\r\n?/g, "\n").split("\n", 1)[0]?.trim() ?? "";
  const m = WRITER_MARKER_RE.exec(first);
  return m ? { key: m[1] as string, writer: m[2] as string } : null;
}

/** Whether a line is one of the hidden markers (the one place an id may stand, D-W8-35). */
export function isMarkerLine(line: string): boolean {
  const t = line.trim();
  return (
    ISSUE_MARKER_RE.test(t) ||
    WRITER_MARKER_RE.test(t) ||
    t === QUOTE_OPEN ||
    t === QUOTE_CLOSE ||
    t === "<!-- forerunner:agent -->"
  );
}

// ---------------------------------------------------------------------------------------------
// Redaction (the one step every quoted piece of free text passes)
// ---------------------------------------------------------------------------------------------

const NUM = String.raw`\d+(?:[.,'’]\d+)*(?:\.-)?`;
const CURRENCY = String.raw`(?:CHF|USD|EUR|GBP|SFr\.?|Fr\.)`;
const MONEY_RES: RegExp[] = [
  new RegExp(String.raw`(?<![A-Za-z])${CURRENCY}\s?-?${NUM}`, "gi"),
  new RegExp(String.raw`-?${NUM}\s?${CURRENCY}(?![A-Za-z])`, "gi"),
  new RegExp(String.raw`[$€£]\s?-?${NUM}`, "g"),
  new RegExp(String.raw`-?${NUM}\s?[$€£]`, "g"),
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const MENTION_RE = /[@＠](?=[A-Za-z0-9_])/g;

/**
 * Free text made fit for GitHub (the session lead's redaction rule of 2026-11-24): money figures
 * (a number beside CHF, USD, EUR, $, € or £) and email addresses are removed, an @mention loses its
 * @ (the name stays), and nothing else changes: "Fix the cost page" is written as it is.
 */
export function redactQuoted(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    out = out.replace(EMAIL_RE, "");
    for (const re of MONEY_RES) out = out.replace(re, "");
    out = out.replace(MENTION_RE, "");
    if (out === before) break;
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/** Whether a text still holds a money figure, an email address or an @mention (the tests' check). */
export function holdsPrivateText(text: string): boolean {
  return (
    /(?<![A-Za-z])(CHF|USD|EUR|GBP)\s?-?\d|\d\s?(CHF|USD|EUR|GBP)(?![A-Za-z])|[$€£]\s?\d|\d\s?[$€£]/i.test(
      text,
    ) ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/.test(text) ||
    /(^|[^A-Za-z0-9_`])[@＠][A-Za-z0-9_]/.test(text)
  );
}

/** One line of free text, cut at a word with "…" when longer than `max`. */
export function oneLine(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters become spaces.
  const one = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ");
  const t = one.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, Math.max(1, max - 1));
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Free text as the status issue quotes it: redacted, on one line, its double quotes made single
 * and its angle brackets harmless (no HTML, no hidden marker), cut at `max`.
 */
export function quotedText(text: string, max = 100): string {
  return oneLine(redactQuoted(text), max)
    .replace(/"/g, "'")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/`/g, "'");
}

/**
 * A line of GitHub text as the body quotes it (another writer's parsed line): redacted, on one
 * line, its angle brackets and backticks harmless; its double quotes kept (they quote titles).
 */
export function safeLine(text: string, max: number): string {
  return oneLine(redactQuoted(text), max).replace(/</g, "‹").replace(/>/g, "›").replace(/`/g, "'");
}

/** A task title in quotes, as every line names it. */
export function quotedTitle(title: string): string {
  return `"${quotedText(title, 100) || "a task"}"`;
}

/** File paths as a line names them: plain paths only, at most five. */
export function filesWords(files: readonly string[]): string {
  const clean = files
    .map((f) => f.trim())
    .filter((f) => /^[\w./*-]{1,120}$/.test(f) && !f.includes("@"))
    .slice(0, 5);
  return clean.join(", ");
}

// ---------------------------------------------------------------------------------------------
// The writer's comment
// ---------------------------------------------------------------------------------------------

/** One task this writer works on now. */
export interface WorkingLine {
  title: string;
  files: string[];
  /** When it started (ISO). */
  since: string;
  /** Until when it says it holds the files (ISO; since + 90 min). */
  until: string;
}

/** One accepted task whose pull request waits for its person's Merge. */
export interface WaitingLine {
  number: number;
  title: string;
  files: string[];
}

/** One paused task: what is done and left (from its handoff), and its checks on the kept work. */
export interface PausedLine {
  title: string;
  done: string | null;
  left: string[];
  /** true: the project's checks pass on the kept work; false: they fail; null: not run. */
  checksPass: boolean | null;
  /** The pause got no further than the one before: it waits for its owner's answer. */
  noProgress: boolean;
}

/**
 * A session waiting for its Claude credential, by the person's policy (D5, D-W8-40): `wait` with
 * the reset time when the session goes on by itself then, `ask` while the person is asked first;
 * the policy that goes on with the next credential gives no line.
 */
export type ClaudeWaitLine = { kind: "wait"; until: string } | { kind: "ask" };

/** The last session's result for the comment. */
export interface LastSessionLine {
  endedAt: string;
  done: string[];
  next: string[];
}

export interface WriterCommentFacts {
  key: string;
  writer: string;
  /** The agent's name (the person's own agent). */
  agentName: string;
  /** The GitHub login the comment is written as. */
  login: string;
  updatedAt: string;
  working: WorkingLine[];
  waiting: WaitingLine[];
  paused: PausedLine[];
  claudeWait: ClaudeWaitLine | null;
  lastSession: LastSessionLine | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "21:05", the UTC time of day. */
export function utcClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "24 Nov 21:05 UTC". */
export function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a moment ago";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${utcClock(iso)} UTC`;
}

/** Up to three quoted titles, then "and N more" (design §5 rule 5). */
function titlesWords(titles: readonly string[]): string {
  const named = titles.slice(0, 3).map(quotedTitle);
  const more = titles.length - named.length;
  const list =
    named.length <= 1
      ? (named[0] ?? "")
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return more > 0 ? `${named.join(", ")} and ${more} more` : list;
}

/** A Working on now line. */
export function workingLineText(w: WorkingLine): string {
  const files = filesWords(w.files);
  return `- ${quotedTitle(w.title)}${files ? ` · files ${files}` : ""} · since ${utcClock(w.since)} · until ${utcClock(w.until)} UTC`;
}

/** A Waiting for Merge line. */
export function waitingLineText(w: WaitingLine): string {
  const files = filesWords(w.files);
  return `- #${w.number} ${quotedTitle(w.title)}${files ? ` · files ${files}` : ""}`;
}

/** A Paused line (W8-write-4): what is done and left, and the checks; or its owner's answer. */
export function pausedLineText(p: PausedLine): string {
  if (p.noProgress) return `- ${quotedTitle(p.title)} · waits for its owner's answer`;
  const parts = [`- ${quotedTitle(p.title)}`];
  if (p.done) parts.push(`done: ${quotedText(p.done, 140)}`);
  const left = p.left.map((l) => quotedText(l, 80)).filter(Boolean);
  if (left.length)
    parts.push(
      `left: ${left.slice(0, 3).join("; ")}${left.length > 3 ? ` and ${left.length - 3} more` : ""}`,
    );
  if (p.checksPass === true) parts.push("the checks pass on the kept work");
  else if (p.checksPass === false) parts.push("the checks fail on the kept work");
  return parts.join(" · ");
}

/** The Waiting for Claude line, by the person's policy (D-W8-40); null under go on. */
export function claudeWaitLineText(w: ClaudeWaitLine | null): string | null {
  if (!w) return null;
  return w.kind === "wait"
    ? `- waits until ${utcClock(w.until)} UTC, then it goes on`
    : "- waits for its person's answer";
}

/** The Last session line. */
export function lastSessionText(s: LastSessionLine): string {
  const did =
    s.done.length === 0
      ? "finished no task"
      : `did ${s.done.length} task${s.done.length === 1 ? "" : "s"}: ${titlesWords(s.done)}`;
  const next = s.next.length ? ` Next: ${titlesWords(s.next)}.` : "";
  return `Last session (${utcStamp(s.endedAt)}): ${did}.${next}`;
}

/** The section headings, in order. */
export const SECTION_HEADINGS = {
  working: "Working on now",
  waiting: "Waiting for Merge",
  paused: "Paused",
  claude: "Waiting for Claude",
} as const;

/**
 * The writer's comment (the decision's format): its marker, the header naming the agent and the
 * login, then each section that has lines, then the last session. Built from this install's own
 * facts only (never from another writer's comment); every quoted text is redacted.
 */
export function renderWriterComment(f: WriterCommentFacts): string {
  const lines = [
    writerMarker(f.key, f.writer),
    `**${quotedText(f.agentName, 60) || "Agent"} (Forerunner)** · ${f.login} · updated ${utcStamp(f.updatedAt)}`,
    "",
  ];
  const section = (heading: string, items: string[]) => {
    if (!items.length) return;
    lines.push(heading, ...items, "");
  };
  section(SECTION_HEADINGS.working, f.working.map(workingLineText));
  section(SECTION_HEADINGS.waiting, f.waiting.map(waitingLineText));
  section(SECTION_HEADINGS.paused, f.paused.map(pausedLineText));
  const claude = claudeWaitLineText(f.claudeWait);
  section(SECTION_HEADINGS.claude, claude ? [claude] : []);
  if (!f.working.length && !f.waiting.length && !f.paused.length && !claude)
    lines.push("Nothing in progress.", "");
  if (f.lastSession) lines.push(lastSessionText(f.lastSession), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A writer's comment as the parser reads it (leniently: unknown lines are skipped). */
export interface ParsedWriterComment {
  key: string;
  writer: string;
  agentName: string;
  login: string;
  updated: string;
  working: string[];
  waiting: string[];
  paused: string[];
  claude: string[];
  lastSession: string | null;
}

const HEADER_RE =
  /^\*\*(.{1,80}) \(Forerunner\)\*\* · ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) · updated (.{1,40})$/;

/**
 * The comment's format read back (the one parser; w8-status-read's reader uses it): the marker
 * strictly, then the header, then the items under each heading; every other line is skipped. The
 * text is data: nothing here follows it.
 */
export function parseWriterComment(body: string | null | undefined): ParsedWriterComment | null {
  const text = (body ?? "").replace(/\r\n?/g, "\n");
  const marker = readWriterMarker(text);
  if (!marker) return null;
  const lines = text.split("\n").slice(1);
  let header: RegExpExecArray | null = null;
  const out: ParsedWriterComment = {
    ...marker,
    agentName: "",
    login: "",
    updated: "",
    working: [],
    waiting: [],
    paused: [],
    claude: [],
    lastSession: null,
  };
  let at: "working" | "waiting" | "paused" | "claude" | null = null;
  for (const raw of lines.slice(0, 200)) {
    const line = raw.trimEnd();
    if (!header) {
      header = HEADER_RE.exec(line.trim());
      if (header) {
        out.agentName = header[1] as string;
        out.login = header[2] as string;
        out.updated = header[3] as string;
      }
      continue;
    }
    const heading = (Object.entries(SECTION_HEADINGS) as [typeof at & string, string][]).find(
      ([, h]) => line.trim() === h,
    );
    if (heading) {
      at = heading[0];
      continue;
    }
    if (line.startsWith("Last session (")) {
      out.lastSession = line.slice(0, 400);
      at = null;
      continue;
    }
    if (at && line.startsWith("- ")) (out[at] as string[]).push(line.slice(2, 402));
    else if (!line.trim()) continue;
    else at = null;
  }
  return header ? out : null;
}

// ---------------------------------------------------------------------------------------------
// The issue's body
// ---------------------------------------------------------------------------------------------

/** The body's fixed lead (the decision's words). */
export const STATUS_BODY_LEAD =
  "Each person and agent keeps one comment below up to date; this summary is rebuilt from them. How to work here: AGENTS.md.";

/** The markers between which the body quotes a writer's lines as data. */
export const QUOTE_OPEN = "<!-- forerunner:status-quote -->";
export const QUOTE_CLOSE = "<!-- /forerunner:status-quote -->";

/** One writer as the body summarises it (from its parsed comment, never copied raw). */
export interface BodyWriter {
  login: string;
  agentName: string;
  updated: string;
  working: string[];
  waiting: string[];
  paused: string[];
  lastSession: string | null;
}

/**
 * The issue's body: the marker, the lead, then each writer that passed the writer filter, its
 * lines quoted as data between the data markers (redacted again: another writer's text is
 * GitHub text).
 */
export function renderIssueBody(key: string, writers: readonly BodyWriter[]): string {
  const lines = [statusIssueMarker(key), STATUS_BODY_LEAD, ""];
  const items = (label: string, list: string[]) =>
    list.slice(0, 10).map((l) => `- ${label}: ${safeLine(l, 160)}`);
  for (const w of writers) {
    lines.push(
      `**${quotedText(w.login, 40)}'s Forerunner** (${quotedText(w.agentName, 60)}), updated ${quotedText(w.updated, 40)}`,
      QUOTE_OPEN,
      ...items(SECTION_HEADINGS.working, w.working),
      ...items(SECTION_HEADINGS.waiting, w.waiting),
      ...items(SECTION_HEADINGS.paused, w.paused),
      ...(w.lastSession ? [`- ${safeLine(w.lastSession, 300)}`] : []),
      QUOTE_CLOSE,
      "",
    );
  }
  if (!writers.length) lines.push("No Forerunner has written its status yet.", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------
// The sentences the app says (Settings, the Docs tab, Updates) and GitHub's one-liners
// ---------------------------------------------------------------------------------------------

/** Where a project's status is (`statusIssueState`): the guide's fact (D-W8-44) and the rows'. */
export type StatusPlace =
  | { kind: "none" }
  | { kind: "switched_off"; projectName: string }
  | { kind: "issues_off"; repo: string }
  | { kind: "no_permission"; repo: string }
  | { kind: "other_project"; repo: string; projectName: string | null }
  | { kind: "closed"; issue: number }
  | { kind: "waiting"; lastAt: string | null }
  | { kind: "not_yet" }
  | { kind: "on"; issue: number; pinned: boolean | null; lastAt: string | null };

/** Issues turned off on the repository. */
export function issuesOffSentence(repo: string): string {
  return `Status stays in the app: issues are turned off on ${repo}.`;
}

/** The token may not write issues. */
export function noIssuePermissionSentence(repo: string): string {
  return `Status stays in the app: Forerunner may not write issues on ${repo} (the GitHub key needs Issues: read and write).`;
}

/** GitHub did not answer: the last write's time in the person's zone. */
export function statusWaitsForGitHubSentence(lastClock: string | null): string {
  return lastClock
    ? `Status on GitHub: last updated ${lastClock}; it updates when GitHub answers.`
    : "Status on GitHub: not written yet; it is written when GitHub answers.";
}

/** The switch is off (W8-write-10). */
export function statusSwitchedOffSentence(projectName: string): string {
  return `Status stays in the app: the status issue is turned off for "${oneLine(projectName, 60)}" in Settings.`;
}

/**
 * W8-write-9 (D-W8-45): the repository's marker names another Forerunner project and this one is
 * not worked on together: it writes no issue. The marker's name is data (`markerNameOf` cleaned it).
 */
export function otherProjectStatusSentence(repo: string, projectName: string | null): string {
  return projectName
    ? `Status stays in the app: ${repo} is the Forerunner project "${projectName}"; Work together on the Overview shares its status issue.`
    : `Status stays in the app: ${repo} is another Forerunner project; Work together on the Overview shares its status issue.`;
}

/** The issue was closed on GitHub (W8-write-8): never reopened by Forerunner. */
export function closedIssueSentence(issue: number): string {
  return `The status issue #${issue} was closed on GitHub; reopen it there to use it again.`;
}

/** Settings' row when the issue is current. */
export function statusOnGitHubSentence(issue: number, pinned: boolean | null): string {
  if (pinned === false)
    return `Status on GitHub: issue #${issue} (not pinned: the repository has three pinned issues already)`;
  return pinned === true
    ? `Status on GitHub: issue #${issue} (pinned)`
    : `Status on GitHub: issue #${issue}`;
}

/** Before the first task starts or session ends: nothing is on GitHub yet. */
export const STATUS_NOT_YET_SENTENCE =
  "Status on GitHub: the status issue is written when a task starts or a session ends.";

/** W8-write-10: on a public repository Settings says who can read the issue (exact text). */
export const PUBLIC_REPOSITORY_SENTENCE = "Everyone who can see this repository can read it.";

/** The one sentence for a place, as Settings shows it under the switch. */
export function statusPlaceSentence(place: StatusPlace, lastClock: string | null): string | null {
  switch (place.kind) {
    case "none":
      return null;
    case "switched_off":
      return statusSwitchedOffSentence(place.projectName);
    case "issues_off":
      return issuesOffSentence(place.repo);
    case "no_permission":
      return noIssuePermissionSentence(place.repo);
    case "other_project":
      return otherProjectStatusSentence(place.repo, place.projectName);
    case "closed":
      return closedIssueSentence(place.issue);
    case "waiting":
      return statusWaitsForGitHubSentence(lastClock);
    case "not_yet":
      return STATUS_NOT_YET_SENTENCE;
    case "on":
      return statusOnGitHubSentence(place.issue, place.pinned);
  }
}

/** The Docs tab's Status row (exact text): the status is the app's, and also on GitHub. */
export function docsStatusNote(place: StatusPlace, lastClock: string | null): string {
  if (place.kind === "on") return `In the app; also on GitHub: issue #${place.issue}`;
  const sentence = statusPlaceSentence(place, lastClock);
  return sentence ?? "In the app";
}

/** The one line a Forerunner writes when it closes its own duplicate status issue. */
export function duplicateIssueLine(kept: number): string {
  return `Closed: #${kept} is this project's status issue.`;
}

/** The Update the person gets once when their comment was changed on GitHub (W8-write-8). */
export function commentChangedUpdate(issue: number): string {
  return `Your Forerunner's status comment on issue #${issue} was changed on GitHub; Forerunner writes its own text there again.`;
}

/** The Update the person gets once when the status issue was deleted on GitHub (W8-write-8). */
export function issueDeletedUpdate(issue: number): string {
  return `The status issue #${issue} is gone from GitHub, so Forerunner opened a new one.`;
}

/**
 * The one line on an old status pull request this install opened for the project (W8-write-5,
 * amendment 2): the status pull request goes; the status is the status issue now.
 */
export const OLD_STATUS_PR_LINE =
  "Closed by Forerunner: the project's status is kept in its status issue now, not in a pull request.";
