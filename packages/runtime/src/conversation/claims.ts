/**
 * l3-chat-claims (live check 3, L3-run-1): the chat never says it changed something or asked for
 * the person's yes unless a command of that turn answered so (design §5 rules 4 and 9). Live,
 * Haiku answered "research may read any public website again" with "Widening research access
 * needs your yes, so I've asked for confirmation. Once you approve, …" and called no tool: no
 * card, nothing in the Inbox, the rule unchanged.
 *
 * `claimOf` finds such a claim in a reply: the reply speaks for itself ("I've asked for
 * confirmation", "I've set research to …", "Ich habe um deine Bestätigung gebeten"), in English
 * or German like the chat's other patterns. A sentence that places the act in an earlier turn
 * ("Earlier I set …", "you said yes") is the history, not a claim about this turn, and a negated
 * one ("I've changed nothing", "Ich habe nichts geändert") claims nothing. The chat
 * (`ConversationAgent.chat`) checks the claim against what the turn's commands did (`TurnDid`):
 * a claim no command backs is nudged once (`claimNudge`), then replaced with what is true (the
 * turn's change sentences, its read-back, or one of the "Nothing changed" lines below).
 */

/** What a reply claims the app did in this turn. */
export interface ReplyClaim {
  /** "asked": a yes was asked for or a request sent; "changed": something was changed. */
  kind: "asked" | "changed";
  /** The words that claim it, as the reply has them (logged on the chat.reply row). */
  phrase: string;
}

/**
 * What the turn's commands did, the nudge step's included (l3-chat-claims review): the guard
 * judges a claim by it, and the nudge and the true line say it. Before, the guard knew one
 * answer only ("nothing changed and nothing waits") and wrote it above the turn's own Yes/No
 * card or its change's row with Undo.
 */
export interface TurnDid {
  /** A command of this turn changed something (done, or partly done). */
  changed: boolean;
  /** A command of this turn read a change back that waits for the person's yes. */
  asked: boolean;
  /** A change read back in an earlier turn of this conversation still waits for the yes. */
  waiting: boolean;
}

/** Sentences about an earlier turn: what the history says, not a claim about this turn. */
const EARLIER =
  /\b(?:earlier|previously|last time|in an earlier turn|yesterday|you (?:said|answered|approved|confirmed|agreed)|vorhin|zuvor|vorher|gestern|hast du (?:bestätigt|zugestimmt|ja gesagt))\b/i;

/**
 * Words that say the act did not happen: "I've changed nothing", "I have added no task", "Ich
 * habe die Regel nicht geändert", "habe keine Anfrage gesendet". "no longer", "not only", "nicht
 * mehr" and "nicht nur" say what changed ("Ich habe facebook.com nicht mehr erlaubt"); the
 * "No" of "Yes/No" and the "Nie" of "Nie-Liste" name a card and a list.
 */
const NEGATION =
  /\b(?:nothing|none|neither|nichts|niemals|kein(?:e|en|em|er|es)?)\b|\bnie(?![-\w])|(?<!\/)\b(?:no|not|never|nicht)\b(?!\s+(?:longer|only|just|mehr|nur)\b)/i;

/**
 * A word after the verb that makes it about the reply itself, not the app: "I've limited my
 * answer", "I have limited knowledge of that page", "I've stopped short of widening it".
 */
const NOT_THE_APP = /^(?:my|myself|me|short|knowledge|information|insight|context|visibility)$/i;

/**
 * A claim pattern (global, every match of a sentence is read); `verbEnds`: the match ends at the
 * verb, so the word after it is read too ("I've changed" + "nothing").
 */
interface ClaimPattern {
  re: RegExp;
  verbEnds?: boolean;
}

const ASKED: ClaimPattern[] = [
  // "I've opened a card in your Inbox", "I've sent you a Yes/No question": a card or a question,
  // never "the report card" or "the task in your inbox" (the review: those were claims).
  {
    re: /\bI(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|also\s+|already\s+)?(?:sent|filed|raised|opened|created|queued|put|placed)\s+(?:you\s+)?(?:a|an|one)\s+(?:(?:yes\/no|confirmation|approval)\s+)?(?:card|question)\b/gi,
  },
  // "I've asked for confirmation", "so I asked for your yes", "I have sent a request" (not "the
  // pull request").
  {
    re: /\bI(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|also\s+|already\s+)?(?:asked|requested|sent|filed|raised|opened|submitted|created|queued)\b(?:[^.!?\n]|\.(?=\S)){0,80}?\b(?:confirm(?:ation|ing)?|approv(?:al|e)|your yes|a yes|sign-?off|(?<!pull )request)\b/gi,
  },
  // "I'm waiting for your yes", "I'll wait for your confirmation".
  {
    re: /\bI(?:'m|’m| am)\s+(?:now\s+)?waiting\s+for\s+your\s+(?:yes|confirmation|approval|go-ahead|ok)\b/gi,
  },
  {
    re: /\bI(?:'ll|’ll| will)\s+wait\s+for\s+your\s+(?:yes|confirmation|approval|go-ahead|ok)\b/gi,
  },
  // "I'll apply it once you approve".
  {
    re: /\bI(?:'ll|’ll| will)\s+(?:apply|make|change|do|set|switch)\b(?:[^.!?\n]|\.(?=\S)){0,60}\bonce you (?:approve|confirm|say yes)\b/gi,
  },
  // "Confirmation has been requested", "a confirmation request was sent".
  { re: /\b(?:confirmation|approval)\s+(?:has been|was|is)\s+(?:requested|sent|asked for)\b/gi },
  {
    re: /\b(?:confirmation|approval)\s+request\s+(?:has been|was|is)\s+(?:sent|filed|opened|created)\b/gi,
  },
  // German: "Ich habe um deine Bestätigung gebeten", "habe eine Freigabe angefordert".
  {
    re: /\bhabe\b(?:[^.!?\n]|\.(?=\S)){0,60}?\b(?:Bestätigung|Zustimmung|Freigabe|ein Ja|dein Ja|Ihr Ja)\b(?:[^.!?\n]|\.(?=\S)){0,40}?\b(?:gebeten|angefragt|angefordert|eingeholt|gestellt)\b/gi,
  },
  {
    re: /\bhabe\b(?:[^.!?\n]|\.(?=\S)){0,60}?\b(?:Anfrage|Karte|Rückfrage)\b(?:[^.!?\n]|\.(?=\S)){0,40}?\b(?:gesendet|geschickt|erstellt|gestellt|angelegt)\b/gi,
  },
  {
    re: /\bich warte auf (?:deine|Ihre|dein|Ihr)\s+(?:Bestätigung|Zustimmung|Freigabe|Ja|Okay)\b/gi,
  },
];

const CHANGED: ClaimPattern[] = [
  // "I've set research to …", "I have changed the budget", "I've now paused it".
  {
    re: /\bI(?:'ve|’ve| have)\s+(?:now\s+|just\s+|also\s+|already\s+)?(?:changed|set|updated|switched|turned (?:on|off)|added|paused|resumed|cancell?ed|removed|deleted|stopped|started|raised|lowered|widened|narrowed|limited|restricted|allowed|enabled|disabled|reopened|moved|renamed)\b/gi,
    verbEnds: true,
  },
  // German: "Ich habe die Regel geändert", "habe die Recherche umgestellt" (up to the first
  // participle, so a negation after it is not read as this claim's).
  {
    re: /\bhabe\b(?:[^.!?\n]|\.(?=\S)){0,60}?\b(?:geändert|gesetzt|umgestellt|aktualisiert|hinzugefügt|pausiert|fortgesetzt|abgebrochen|gestoppt|gestartet|erhöht|gesenkt|eingeschränkt|erweitert|erlaubt|aktiviert|deaktiviert|entfernt|gelöscht|verschoben|umbenannt)\b/gi,
  },
];

/** The reply's sentences (a claim is judged per sentence). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether this match claims the act: not negated, not about the reply itself. */
function claims(s: string, m: RegExpMatchArray, p: ClaimPattern): boolean {
  if (NEGATION.test(m[0])) return false;
  if (!p.verbEnds) return true;
  const after = s.slice((m.index ?? 0) + m[0].length).trimStart();
  const word = /^[\p{L}'’-]+/u.exec(after)?.[0] ?? "";
  return !(word && (NEGATION.test(word) || NOT_THE_APP.test(word)));
}

/** The first claim the reply makes about this turn, or null. "asked" is looked for first. */
export function claimOf(text: string): ReplyClaim | null {
  const own = sentences(text).filter((s) => !EARLIER.test(s));
  for (const [kind, patterns] of [
    ["asked", ASKED],
    ["changed", CHANGED],
  ] as const)
    for (const s of own)
      for (const p of patterns)
        for (const m of s.matchAll(p.re)) if (claims(s, m, p)) return { kind, phrase: m[0].trim() };
  return null;
}

/**
 * The turn's one more model step when its reply claims what no command did, the turn's commands
 * did nothing and no card waits (model-facing; the exact text is asserted in
 * conversation-memory.test.ts, "l3-chat-claims, run L3"). `claimNudge` says the other cases.
 */
export const CLAIM_NUDGE =
  'Your reply says that you changed something or asked for the person\'s yes, but no command in this turn did either: nothing changed in this turn and nothing waits for a yes. If the person asked for a change, call its command now; the runtime reads a change that needs a yes back with Yes and No. If you meant a change an earlier turn made, say so ("Earlier, ..."). Otherwise answer again and say that nothing changed.';

/**
 * The nudge for this claim and what the turn did (model-facing; asserted word for word in
 * conversation-memory.test.ts, "l3-chat-claims, run L3: what the turn did"): what the claim
 * says that no command did, then what is true (a change this turn made, this turn's card
 * waiting, or an earlier turn's card still waiting). With this turn's card waiting the model is
 * told not to call its command again: a second card would wait where no reply shows it.
 */
export function claimNudge(claim: ReplyClaim, did: TurnDid): string {
  if (!did.changed && !did.asked && !did.waiting) return CLAIM_NUDGE;
  const lead =
    claim.kind === "asked"
      ? "Your reply says that you asked for the person's yes, but no command in this turn asked for one"
      : "Your reply says that you changed something, but no command in this turn changed anything";
  const changed = did.changed
    ? "a command of this turn made a change, which the runtime shows under your reply"
    : did.asked
      ? "nothing changed yet"
      : "nothing changed in this turn";
  const yes = did.asked
    ? "the change your command read back waits for the person's yes, with Yes and No under your reply"
    : did.waiting
      ? "a change read back in an earlier turn still waits for the person's yes"
      : "nothing waits for a yes";
  const next = did.asked
    ? "Do not call that command again."
    : "If the person asked for a change that no command made, call its command now; the runtime reads a change that needs a yes back with Yes and No.";
  const end =
    did.changed || did.asked
      ? "Otherwise answer again and say only what this turn's commands did."
      : "Otherwise answer again and say that nothing changed.";
  return `${lead}: ${changed}, and ${yes}. ${next} If you meant a change an earlier turn made, say so ("Earlier, ..."). ${end}`;
}

/**
 * What the person reads when the reply still claims it after the nudge, and the turn changed
 * nothing, asked nothing and no card waits (design §5 rule 8).
 */
export const NOTHING_CHANGED_REPLY =
  "Nothing changed, and nothing waits for your yes. Say it again to try once more.";

/**
 * The same when a card an earlier turn read back still waits for the person's yes (its Yes and
 * No stay under that earlier reply): "nothing waits" would be false there.
 */
export const NOTHING_CHANGED_CARD_WAITS_REPLY =
  "Nothing changed; the change I asked about earlier still waits for your yes.";
