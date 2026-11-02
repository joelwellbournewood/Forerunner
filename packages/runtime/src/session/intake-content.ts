import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import type { IntakeProposal } from "./intake.ts";
import { MAX_PERSON_QUESTIONS, PERSON_SPECIALIST } from "./person-questions.ts";
import { MAX_PLAN_TASKS, type PlanTask } from "./project-plan.ts";

/**
 * Content the brief says the person will give (live L-11, 2026-11-02). The brief "A one-page
 * website for a small bakery in Bern; I will give you the real menu, hours and address" got a
 * plan of a coder ("All shop facts are placeholders") and a tester: the page was accepted full
 * of PLACEHOLDER markers and the person was never asked for the menu, the hours or the address.
 * The intake's prompt now says such content is a person task the work waits on; this is the
 * rule in code (AGENTS.md: a prompt may ask, only code can allow): a plan without a person task
 * that asks for the promised content gets one, and the tasks that use it wait on it.
 *
 * Only a promise to Forerunner counts (review of 2026-11-02): "we will send subscribers a weekly
 * email" says what the project does for its own people, yet it got a person task "Give
 * subscribers a weekly email" that the build waited on. And the person's change wins: a
 * "Change the plan" that drops the step, or says there is nothing to give, is not overridden.
 */

/**
 * A promise to hand something over: who promises, the verb and the rest of the clause. "I will
 * give you", "I'll send", "we will provide you with", "the owner will supply".
 */
const PROMISE =
  /\b(?<who>i|we|(?:the\s+)?(?:owners?|clients?|customers?))(?<modal>\s+will|'ll|\s+can|\s+am\s+going\s+to|\s+are\s+going\s+to|\s+is\s+going\s+to)\s+(?<verb>give|send|provide|supply|share|hand|deliver|pass|forward|e-?mail|upload)\b(?<rest>[^.;!?\n]*)/gi;
/** "send over the photos", "hand in the texts". */
const PARTICLE = /^(?:over|in|along|across|on|back)\s+/i;
/** Forerunner is who it goes to, named first: "give you", "provide you with". */
const TO_YOU_FIRST = /^you(?:\s+all)?(?:\s+with)?\s+/i;
/** … or after the content: "send the texts to you", "share the list with you". */
const TO_YOU_AFTER = /\s+(?:to|with)\s+you\b.*$/i;
/** Someone else is who it goes to: "give them the menu". */
const TO_PRONOUN = /^(?:them|him|her|us|me)\s+\S/i;
/** A word that cannot end who it goes to: "the menu and the photos", "the photos of the garden". */
const NOT_A_NOUN =
  "(?!(?:and|or|but|plus|nor|of|with|for|from|about|on|in|at|to|into|onto|by|as|so|than)\\b)";
/** … named before what they get: "send subscribers a weekly email", "give the team a demo". */
const DOUBLE_OBJECT = new RegExp(
  `^(?<np>(?:(?:the|my|our|their|his|her|its|all|every)\\s+)?${NOT_A_NOUN}[a-z][\\w'-]*(?:\\s+${NOT_A_NOUN}[a-z][\\w'-]*)?)\\s+(?:a|an|the|my|our|their|his|her|its|this|that|these|those|some|every|each|any|weekly|daily|monthly|free|new)\\b`,
  "i",
);
/** "send emails to subscribers"; "to put on the page", "to the folder" is not someone. */
const TO_OTHER = /\s+to\s+(?:(?:the|our|my|their|all|every|each|new|any)\s+)*(?<to>[a-z][\w'-]*)/i;
const NOT_A_PERSON =
  /^(?:put|use|show|add|include|fill|replace|build|make|work|start|finish|check|test|be|get|go|have|help|display|publish|post|place|design|create|write|update|print|folder|project|repository|repo|drive|dropbox|page|site|website|inbox|chat|app)$/i;
/** "provide members with a newsletter": the members are who it goes to. */
const WITH_OBJECT = /^(?<np>[^,]+?)\s+with\s+/i;
/** Not who it goes to, though it stands before an article: "all the photos". */
const NOT_SOMEONE =
  /^(?:all|both|half|some|any|more|most|few|further|extra|additional|real|actual|final|exact|correct|proper|current|own|full|complete|also|then|now|soon|just|only|over|along|back|in|out|up|on|through|together|first|later|again|even|right|straight)$/i;
/** Ongoing work of the project ("a weekly email"), not something handed over once. */
const RECURRING =
  /\b(?:weekly|daily|monthly|yearly|annual(?:ly)?|nightly|hourly|regular(?:ly)?|(?:every|each)\s+(?:day|week|month|year|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
/** A promise for later: the work starts without it. */
const LATER = /\b(?:later|afterwards|eventually|at\s+some\s+point|in\s+a\s+(?:week|month))\b/i;
/** The person asks for the work to start with stand-ins: theirs to choose. */
const STARTS_WITHOUT = /\b(?:placeholders?|dummy|lorem\s+ipsum|sample\s+(?:text|data|content))\b/i;
/** Where the list of items ends in a clause: "… once it opens", "… for the page", "… to the folder". */
const LIST_END =
  /\s+(?:later|soon|next\s+week|tomorrow|today|tonight|now|asap|too|as\s+well|this\s+week|when|once|before|after|by|so\s+that|to(?!\s+\d)|for\s+the)\b.*$/i;
/** Where an item's head ends: "photos of the garden", "a REST API with JSON data". */
const HEAD_END =
  /\s+(?:with|of|for|from|about|on|in|at|to|into|onto|including|that|which|who|so|as|via|by)\b.*$/i;
/**
 * What only the person can give for the work: words, numbers, facts, media; the last word of the
 * item's head ("the real menu", "phone numbers", "photos of the garden"), so "the team a demo" or
 * "a REST API with JSON data" is not content. People are not content: "members", "the team".
 */
const CONTENT_WORD =
  /\b(?:menus?|prices?|pricing|hours|opening\s+times|times|address(?:es)?|phone(?:\s+numbers?)?|telephone|e-?mails?(?:\s+address)?|contacts?|texts?|copy|content|wording|words|photos?|images?|pictures?|logos?|icons?|videos?|data|dataset|figures|numbers|list|names?|descriptions?|details|dates|schedule|timetable|quotes|faqs?|bios?|story|products?|catalogu?e|recipes?|events?|locations?|map|colou?rs|fonts?|brand(?:ing)?|slogan|tagline|titles?|headlines?|csv|spreadsheets?|files?|documents?|pdfs?)$/i;
/** Never asked for in the Inbox: a secret is referred to by name (AGENTS.md). */
const SECRET_WORD =
  /\b(?:keys?|tokens?|passwords?|passphrases?|credentials?|secrets?|logins?|accounts?)\b/i;
/** Asked for as a place, not typed: a file or a picture. */
const MEDIA_WORD =
  /\b(?:photos?|images?|pictures?|logos?|icons?|videos?|files?|csv|spreadsheets?|documents?|pdfs?)\b/i;
const LEADING =
  /^(?:(?:the|a|an|my|our|their|your|its|all|any|some|more|further|extra|additional)\s+)+/i;
const ADJECTIVES = /^(?:(?:real|actual|final|exact|correct|proper|current|own|full|complete)\s+)+/i;

/** What the brief says the person will give: its words as written, and each item. */
export interface PromisedContent {
  /** "the real menu, hours and address" */
  phrase: string;
  /** "menu", "hours", "address" */
  items: string[];
}

/** An item's head: its words before a preposition ("photos" of "photos of the garden"). */
const headOf = (item: string) => item.replace(HEAD_END, "");

function itemsOf(list: string): string[] {
  return list
    .replace(LIST_END, "")
    .split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+|\s*&\s*|\s*\/\s*/)
    .map((s) => s.replace(LEADING, "").replace(ADJECTIVES, "").replace(LEADING, "").trim())
    .filter((s) => s.length >= 2 && s.length <= 60);
}

/**
 * What a promise hands Forerunner, or null when it goes to someone else. Forerunner is named
 * ("give you", "send … to you", "share … with you"): whoever promises it. No one is named: only
 * the person ("I", "we", the owner, the client), never with "can" (what they are able to do),
 * "share" (with the public) or for ongoing work ("a weekly email"). Someone else is named ("send
 * subscribers …", "give them …", "… to members", "provide members with …"): the project's work.
 */
function handedToForerunner(groups: Record<string, string | undefined>): string | null {
  const who = (groups.who ?? "").toLowerCase();
  const modal = (groups.modal ?? "").trim().toLowerCase();
  const verb = (groups.verb ?? "").toLowerCase();
  const rest = (groups.rest ?? "").trim().replace(PARTICLE, "");
  if (TO_YOU_FIRST.test(rest)) return rest.replace(TO_YOU_FIRST, "");
  if (TO_YOU_AFTER.test(` ${rest}`)) return ` ${rest}`.replace(TO_YOU_AFTER, "").trim();
  if (who.includes("customer") || modal === "can" || verb === "share" || RECURRING.test(rest))
    return null;
  if (TO_PRONOUN.test(rest)) return null;
  const double = DOUBLE_OBJECT.exec(rest)?.groups?.np;
  if (double) {
    const last = double.split(/\s+/).pop() ?? "";
    if (!NOT_SOMEONE.test(last) && !CONTENT_WORD.test(last)) return null;
  }
  const to = TO_OTHER.exec(rest)?.groups?.to;
  if (to && !NOT_A_PERSON.test(to)) return null;
  if (verb === "provide" || verb === "supply") {
    const np = WITH_OBJECT.exec(rest)?.groups?.np;
    if (np && np.split(/\s+/).length <= 3 && !CONTENT_WORD.test(headOf(np))) return null;
  }
  return rest;
}

/**
 * The content a brief (or a goal, or the person's change) says the person will give Forerunner:
 * the promise's items that are content (a menu, prices, hours, an address, texts, photos, data),
 * never a secret (a key, a password); null when it promises none. Feedback, a review or an
 * approval is not content, and neither is what the project gives its own people.
 */
export function promisedContent(text: string): PromisedContent | null {
  const items: string[] = [];
  const phrases: string[] = [];
  for (const m of text.matchAll(PROMISE)) {
    const raw = handedToForerunner(m.groups ?? {});
    // "… later", "use placeholders for now": the person chose to start without it.
    if (raw === null || LATER.test(raw)) continue;
    const list = raw.replace(LIST_END, "").trim();
    const found = itemsOf(list).filter((i) => CONTENT_WORD.test(headOf(i)) && !SECRET_WORD.test(i));
    if (!found.length) continue;
    if (!phrases.some((p) => p.toLowerCase() === list.toLowerCase())) phrases.push(list);
    for (const i of found)
      if (!items.some((x) => x.toLowerCase() === i.toLowerCase())) items.push(i);
  }
  if (!items.length || STARTS_WITHOUT.test(text)) return null;
  return { phrase: phrases.join("; "), items: items.slice(0, MAX_PERSON_QUESTIONS) };
}

/** A change that takes the step away: "drop", "leave … out", "nothing to give", "no", "not". */
const DROPS =
  /\b(?:drop|remove|delete|cut|skip|omit|leave\b[^.;!?]*\bout|take\b[^.;!?]*\bout|get\s+rid|no|not|nothing|none|don'?t|do\s+not|won'?t|will\s+not|never|without|instead)\b/i;
/** A change about the step for the person, or about what they give. */
const ABOUT_THE_STEP =
  /\b(?:content|first\s+(?:task|step)|person(?:'s)?\s+(?:task|step)|(?:my|your|that|this)\s+(?:task|step)|asks?\s+me|asking\s+me|questions?|for\s+me|from\s+me|my\s+answers?|give|giving|provide|providing|send|sending|supply|supplying|hand\s+over)\b/i;

/**
 * The person's change takes the step for their content away (design §3.3: Change the plan "drafts
 * a new plan for you to approve"; review of 2026-11-02, where the step came back on every
 * redraft): it speaks of the step, its questions or the content, and drops or refuses it.
 * "Make the headings blue" or "Keep the menu step" does not.
 */
export function dropsOwnersContent(change: string, items: readonly string[]): boolean {
  if (!DROPS.test(change)) return false;
  return ABOUT_THE_STEP.test(change) || mentionsAny(change, itemWords(items));
}

const plural = (item: string) => {
  const last = headOf(item).split(/\s+/).pop()?.toLowerCase() ?? "";
  return /s$/.test(last) && !/(?:ss|us|is)$/.test(last);
};

/** The question a person task asks for one item: "What is the menu?", "Where are the photos …?" */
export function contentQuestion(item: string): string {
  const be = plural(item) ? "are" : "is";
  return MEDIA_WORD.test(item)
    ? `Where ${be} the ${item} (a path in the project's folder, or a link)?`
    : `What ${be} the ${item}?`;
}

type KeyedTask = PlanTask & { key?: string };

const textOf = (t: KeyedTask) =>
  [t.title, t.outcome, ...t.acceptanceCriteria].join("\n").toLowerCase();

const isPerson = (t: KeyedTask) =>
  !!t.specialist && canonicalSpecialistName(t.specialist) === PERSON_SPECIALIST;

/** Words of the items that name them ("opening hours" -> opening, hours). */
const itemWords = (items: readonly string[]) =>
  items.flatMap((i) => i.toLowerCase().split(/\s+/)).filter((w) => w.length >= 3);

const mentionsAny = (text: string, words: readonly string[]) =>
  words.some((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}`, "i").test(text));

const mentions = (t: KeyedTask, words: readonly string[]) => mentionsAny(textOf(t), words);

/** A key not used by the plan yet. */
function freshKey(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The keys a task waits on, directly or through other tasks of the plan. */
function closure(start: KeyedTask, byKey: ReadonlyMap<string, KeyedTask>): Set<string> {
  const seen = new Set<string>();
  const todo = [...start.dependsOn];
  while (todo.length) {
    const k = todo.pop() as string;
    if (seen.has(k)) continue;
    seen.add(k);
    todo.push(...(byKey.get(k)?.dependsOn ?? []));
  }
  return seen;
}

/**
 * The proposal with a person task for the content the brief says the person will give (live
 * L-11), when the plan asks for it nowhere: "Give the real menu, hours and address", for the
 * person, its acceptance criteria one question per item, high priority, first in the milestone
 * of the work that uses it. A person task the plan already has for that content is kept. Either
 * way the tasks that start the work and use the content (they name an item; when none does,
 * every task that waits on nothing) wait on it, so nothing is built from placeholders. The
 * proposal as it was when the brief promises nothing, or the plan is full.
 *
 * `changes` are the person's words from "Change the plan", in order: content they promise is
 * asked for too, and once one of them drops the step or says there is nothing to give
 * (`dropsOwnersContent`) the plan is the model's redraft with their change, as it is.
 */
export function withOwnersContent(
  proposal: IntakeProposal,
  brief: string,
  changes: readonly string[] = [],
): IntakeProposal {
  const promised = promisedContent([brief, ...changes].join("\n"));
  if (!promised) return proposal;
  if (changes.some((c) => dropsOwnersContent(c, promised.items))) return proposal;
  const plan = structuredClone(proposal.plan);
  const all: KeyedTask[] = [...plan.milestones.flatMap((m) => m.tasks), ...plan.tasks];
  const words = itemWords(promised.items);
  let asks = all.find((t) => isPerson(t) && mentions(t, words));
  if (!asks) {
    if (all.length >= MAX_PLAN_TASKS) return proposal;
    const taken = new Set(all.map((t) => t.key).filter((k): k is string => !!k));
    asks = {
      key: freshKey(taken, "your-content"),
      title: `Give ${promised.phrase}`.slice(0, 200),
      outcome: `You give ${promised.phrase}, as your brief said; the work that uses it waits for your answers and uses them instead of placeholders.`,
      acceptanceCriteria: promised.items.map(contentQuestion),
      priority: "high",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: PERSON_SPECIALIST,
      status: "ready",
    };
    // First in the milestone of the work that uses it, else the first milestone.
    const home =
      plan.milestones.find((m) => m.tasks.some((t) => !isPerson(t) && mentions(t, words))) ??
      plan.milestones[0];
    if (home) home.tasks.unshift(asks);
    else plan.tasks.unshift(asks);
    all.unshift(asks);
  }
  if (!asks.key) {
    asks.key = freshKey(
      new Set(all.map((t) => t.key).filter((k): k is string => !!k)),
      "your-content",
    );
  }
  const key = asks.key as string;
  const byKey = new Map(all.filter((t) => t.key).map((t) => [t.key as string, t]));
  const ahead = closure(asks, byKey);
  const roots = all.filter(
    (t) => t !== asks && !isPerson(t) && t.dependsOn.length === 0 && !(t.key && ahead.has(t.key)),
  );
  const users = roots.filter((t) => mentions(t, words));
  for (const t of users.length ? users : roots)
    if (!t.dependsOn.includes(key)) t.dependsOn.push(key);
  return { ...proposal, plan };
}
