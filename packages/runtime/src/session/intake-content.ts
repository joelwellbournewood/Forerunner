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
 */

/** "I will give you", "I'll send", "we will provide you with", "the owner will supply". */
const PROMISE =
  /\b(?:(?:i|we)(?:\s+will|'ll|\s+can|\s+am\s+going\s+to|\s+are\s+going\s+to)|(?:the\s+)?(?:owner|client|customer)\s+will)\s+(?:give|send|provide|supply|share|hand\s+over|deliver)(?:\s+(?:you|it|them))?(?:\s+with)?\s+(?<items>[^.;!?\n]+)/gi;
/** A promise for later: the work starts without it. */
const LATER = /\b(?:later|afterwards|eventually|at\s+some\s+point|in\s+a\s+(?:week|month))\b/i;
/** The person asks for the work to start with stand-ins: theirs to choose. */
const STARTS_WITHOUT = /\b(?:placeholders?|dummy|lorem\s+ipsum|sample\s+(?:text|data|content))\b/i;
/** Where the list of items ends inside a clause: "… once it opens", "… for the page". */
const LIST_END =
  /\s+(?:later|soon|next\s+week|tomorrow|when|once|before|after|by|so\s+that|to\s+put|for\s+the)\b.*$/i;
/** What only the person can give for the work: words, numbers, facts, media. */
const CONTENT_WORD =
  /\b(?:menus?|prices?|pricing|hours|opening\s+times|times|address(?:es)?|phone(?:\s+numbers?)?|telephone|e-?mails?(?:\s+address)?|contacts?|texts?|copy|content|wording|words|photos?|images?|pictures?|logos?|icons?|videos?|data|dataset|figures|numbers|list|names?|descriptions?|details|dates|schedule|timetable|quotes|faqs?|bios?|story|products?|catalogu?e|recipes?|team|members?|events?|locations?|map|colou?rs|fonts?|brand(?:ing)?|slogan|tagline|titles?|headlines?|csv|spreadsheets?|files?|documents?|pdfs?)\b/i;
/** Never asked for in the Inbox: a secret is referred to by name (AGENTS.md). */
const SECRET_WORD =
  /\b(?:keys?|tokens?|passwords?|passphrases?|credentials?|secrets?|logins?|accounts?)\b/i;
/** Asked for as a place, not typed: a file or a picture. */
const MEDIA_WORD =
  /\b(?:photos?|images?|pictures?|logos?|icons?|videos?|files?|csv|spreadsheets?|documents?|pdfs?)\b/i;
const LEADING = /^(?:(?:the|a|an|my|our|their|your|its|all|any|some)\s+)+/i;
const ADJECTIVES = /^(?:(?:real|actual|final|exact|correct|proper|current|own|full|complete)\s+)+/i;

/** What the brief says the person will give: its words as written, and each item. */
export interface PromisedContent {
  /** "the real menu, hours and address" */
  phrase: string;
  /** "menu", "hours", "address" */
  items: string[];
}

function itemsOf(list: string): string[] {
  return list
    .replace(LIST_END, "")
    .split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+|\s*&\s*|\s*\/\s*/)
    .map((s) => s.replace(LEADING, "").replace(ADJECTIVES, "").replace(LEADING, "").trim())
    .filter((s) => s.length >= 2 && s.length <= 60);
}

/**
 * The content a brief (or a goal) says the person will give: the promise's items that are
 * content (a menu, prices, hours, an address, texts, photos, data), never a secret (a key, a
 * password); null when it promises none. Feedback, a review or an approval is not content.
 */
export function promisedContent(text: string): PromisedContent | null {
  const items: string[] = [];
  const phrases: string[] = [];
  for (const m of text.matchAll(PROMISE)) {
    const raw = m.groups?.items ?? "";
    // "… later", "use placeholders for now": the person chose to start without it.
    if (LATER.test(raw)) continue;
    const list = raw.replace(LIST_END, "").trim();
    const found = itemsOf(list).filter((i) => CONTENT_WORD.test(i) && !SECRET_WORD.test(i));
    if (!found.length) continue;
    if (!phrases.some((p) => p.toLowerCase() === list.toLowerCase())) phrases.push(list);
    for (const i of found)
      if (!items.some((x) => x.toLowerCase() === i.toLowerCase())) items.push(i);
  }
  if (!items.length || STARTS_WITHOUT.test(text)) return null;
  return { phrase: phrases.join("; "), items: items.slice(0, MAX_PERSON_QUESTIONS) };
}

const plural = (item: string) => {
  const last = item.split(/\s+/).pop()?.toLowerCase() ?? "";
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

const mentions = (t: KeyedTask, words: readonly string[]) => {
  const text = textOf(t);
  return words.some((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}`, "i").test(text));
};

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
 */
export function withOwnersContent(proposal: IntakeProposal, brief: string): IntakeProposal {
  const promised = promisedContent(brief);
  if (!promised) return proposal;
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
