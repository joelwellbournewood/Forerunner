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
 *
 * l4-chat-answers (run L4, live check 4): two more kinds. "asks": the reply asks the person for a
 * yes in its own words to make a change ("Shall I set …?", a read-back it wrote itself), which no
 * card carries, so a typed yes reaches no one (design §3.9 keeps "Yes to what?" for a bare yes).
 * "absent": the reply says a record is not there, or offers to look, in a turn that offered
 * recall and called neither recall tool. A forged "The app did: …" line is a "changed" claim.
 */

/** What a reply claims the app did in this turn. */
export interface ReplyClaim {
  /**
   * "asked": a yes was asked for or a request sent; "changed": something was changed.
   * l4-chat-answers (run L4, L4-chat-101/102, L4-selftasks-118): "asks": the reply asks the
   * person for a yes in its own words to make a change ("Shall I set …?", "Do you want me to
   * start …?", a read-back it wrote itself: "Make "X" high priority?"), which no card carries, so
   * a typed yes reaches no one; "absent": it says a record is not there, or offers to look, in a
   * turn that offered recall and called neither recall tool.
   */
  kind: "asked" | "changed" | "asks" | "absent";
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
  // l4-chat-answers (L4-selftasks-118, L4-chat-112): the app's own change line, written by the
  // model ("The app did: Updated the outcome of …" with no command). The line is stripped from
  // every reply (`withoutAppMarkers`); a turn whose command changed nothing is nudged for it.
  { re: /^The app did:/g },
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

/**
 * The verbs of a change a command makes (l4-chat-answers, L4-chat-102): what a question in the
 * reply's own words would do. "look", "search", "check", "open" and "go ahead" are not changes: a
 * lookup offer is the "absent" kind, a stronger model's offer is the app's ask (l4-chat-depth).
 */
const CHANGE_VERB =
  "(?:set|change|widen|narrow|allow|block|start|run|add|create|cancel|pause|resume|stop|raise|lower|increase|reduce|remove|delete|drop|reopen|retry|try|move|rename|switch|turn|enable|disable|make|mark|split|answer|record|update|edit|reword|restart|apply|put|give|let|limit|restrict|reset|leave|skip|undo|merge|close)";

/** German change verbs, as the infinitive ends a "Soll ich …?" question. */
const CHANGE_VERB_DE =
  "(?:ändern|setzen|umstellen|starten|erlauben|freigeben|hinzufügen|anlegen|pausieren|fortsetzen|abbrechen|stoppen|erhöhen|senken|entfernen|löschen|verschieben|umbenennen|aktivieren|deaktivieren|einschränken|erweitern|beantworten|wiederholen|zurücksetzen)";

/**
 * l4-chat-answers (L4-chat-102, L4-selftasks-118): a sentence that asks the person for a yes in
 * the reply's own words to make a change. Judged on question sentences only (a "?" ends them),
 * except the "needs your yes" sentence, which says a yes is due whether or not it asks.
 * A clarifying question (`CLARIFIES`: "Which task should I add it to?", "Add it to Notes or to
 * Site?") stays free under every pattern.
 */
const ASKS: { re: RegExp; question: boolean; besideQuestion?: boolean }[] = [
  // The app's own read-back line, written by the model.
  { re: /^The app asked, with Yes and No:/g, question: false },
  // "Shall I set …?", "Should I start a session?", "Can I add it?".
  {
    re: new RegExp(
      `\\b(?:shall|should|may|can|could)\\s+I\\s+(?:now\\s+|also\\s+|just\\s+|go\\s+ahead\\s+and\\s+)?${CHANGE_VERB}\\b`,
      "gi",
    ),
    question: true,
  },
  // "Do you want me to start a session on Garden club?", "Want me to pause it?".
  {
    re: new RegExp(
      `\\b(?:(?:do|would)\\s+you\\s+(?:want|like)|want)\\s+me\\s+to\\s+(?:now\\s+|also\\s+|go\\s+ahead\\s+and\\s+)?${CHANGE_VERB}\\b`,
      "gi",
    ),
    question: true,
  },
  // "Should research for Reading rules C be allowed to read any public website again?".
  {
    re: /\b(?:should|shall)\s+(?!I\b)[^?]{1,80}?\s+be\s+(?:allowed|set|changed|widened|narrowed|started|raised|lowered|paused|resumed|cancell?ed|removed|added|reopened|switched|turned\s+(?:on|off)|enabled|disabled|made|marked|moved|renamed|stopped)\b/gi,
    question: true,
  },
  // A read-back it wrote itself (L4-selftasks-118): 'Make "Write the prices page" high
  // priority?', 'Start a session on Garden club (up to CHF 1)?'. Only the runtime reads a
  // change back, with Yes and No under it; "Start which task?" asks which and stays free.
  {
    re: /^(?:\[[^\]]{1,40}\]\s*)?(?:Make|Set|Change|Start|Run|Pause|Resume|Cancel|Add|Remove|Delete|Stop|Raise|Lower|Widen|Narrow|Allow|Block|Reopen|Move|Rename|Switch|Turn|Mark|Split|Retry|Leave|Answer|Let|Give|Put|Drop|Skip|Restart|Reset|Merge|Close)\b(?![^?]*\b(?:which|who|whom|whose|where)\b)[^?]{3,}\?$/g,
    question: true,
  },
  // "This widens what research may read, so I need your yes first.", "It needs your
  // confirmation before it applies.", beside a question in the same reply ("… Shall I …?").
  {
    re: /\b(?:I|it|this|that|the change|this change|that change)\s+(?:need|needs|requires?|is\s+waiting\s+for|waits\s+for)\s+your\s+(?:yes|confirmation|approval|go-ahead|ok)\b/gi,
    question: false,
    besideQuestion: true,
  },
  // German: "Soll ich die Regel ändern?", "Möchtest du, dass ich eine Sitzung starte?".
  {
    re: new RegExp(`\\bsoll\\s+ich\\b[^?]{0,80}?\\b${CHANGE_VERB_DE}\\b`, "gi"),
    question: true,
  },
  {
    re: /\b(?:möchtest|willst|möchten|wollen)\s+(?:du|Sie),?\s+dass\s+ich\b/gi,
    question: true,
  },
  {
    re: /\b(?:braucht|brauche|benötigt)\b[^.!?]{0,40}\b(?:dein|Ihr)\s+Ja\b/gi,
    question: false,
    besideQuestion: true,
  },
];

/**
 * l4-chat-answers (L4-chat-101): a reply that says a record is not there, or offers to look it
 * up, instead of looking ("There is no README task in Quote Page", "I can't find anything about a
 * pizza oven", "I haven't searched the records yet. Should I look …?", live check 4). Judged only
 * in a turn that offered recall and called neither recall tool (`ConversationAgent.chat`). "There
 * is no ready task" (about now, from the facts) names no record by a name and stays free.
 */
const ABSENT: RegExp[] = [
  /\bI\s+(?:can(?:no|')t|cannot|couldn(?:'|’)t|could\s+not|do(?:n't|n’t| not)|did(?:n't|n’t| not))\s+(?:see|find|spot|locate)\b/gi,
  /\bI\s+(?:found|see|have)\s+no\s+(?:record|mention|trace|sign|note|card|decision|task|entry)\b/gi,
  /\bI\s+(?:found|see)\s+nothing\b/gi,
  /\bno\s+records?\s+(?:of|about|for|mention)\b/gi,
  /\bnothing\b[^.!?]{0,80}\bmentions?\b/gi,
  /\bI\s+(?:haven(?:'|’)t|have\s+not|did(?:n't|n’t| not))\s+(?:yet\s+)?(?:searched|looked|checked)\b/gi,
  /\b(?:should|shall|can|could)\s+I\s+(?:look|search|check|dig)\b/gi,
  /\bI\s+can\s+(?:look|search)\s+(?:it\s+up|for|through|the)\b/gi,
  /\b(?:do\s+you\s+want|would\s+you\s+like|want)\s+me\s+to\s+(?:look|search|check)\b/gi,
  /\b[Tt]here(?:'s|’s| is| was| are| were)\s+no\s+(?:(?:["“][^"”]{1,60}["”]|[A-Z][\w.-]*)\s+){1,4}(?:task|card|decision|record|session|document|lesson|question|change)s?\b/g,
  /\bthere(?:'s|’s| is| was| are| were)\s+no\s+(?:task|card|decision|record|session|document|lesson|mention|note|question|change)s?\s+(?:about|of|for|called|named|on|that|with)\b/gi,
  // German: "Ich habe keine Lizenzwahl gefunden", "nicht gefunden", "Soll ich nachsehen?".
  /\bkeine?n?\b[^.!?]{0,60}\bgefunden\b/gi,
  /\bnicht\s+gefunden\b/gi,
  /\bich\s+finde\s+(?:kein|nichts)\w*\b/gi,
  /\bsoll\s+ich\b[^.!?]{0,40}\b(?:nachsehen|nachschauen|suchen|nachschlagen)\b/gi,
];

/**
 * Review of l4-chat-answers (blocking 2): a clarifying question asks which, who, where or what
 * ("Which task should I add it to?", "Where should I put the new page?") or offers a choice ("Add
 * it to Notes or to Site?", "Start it now or wait for the next session?"). It asks for no yes and
 * stays free under every "asks" pattern (the area's decision: "Clarifying questions stay free").
 * "… or not?", "… or leave it as it is?" and "… oder nicht?" offer no choice: the question still
 * asks for a yes. "what" counts only as the question's first word (after a preposition), since
 * "add what you said" is no question word.
 */
const CLARIFIES: RegExp[] = [
  /\b(?:which|who|whom|whose|where)\b/i,
  /^(?:\[[^\]]{1,40}\]\s*)?(?:(?:to|in|for|on|at|with|from|into)\s+)?(?:what|when|how(?!\s+about))\b/i,
  /\bor\b(?!\s+(?:not|no|leave|keep|stay)\b)/i,
  /\b(?:welche[rsmn]?|wer|wem|wen|wo|wohin|wozu)\b/i,
  /\boder\b(?!\s+(?:nicht|nein|lassen|so\s+lassen)\b)/i,
];

const clarifies = (s: string) => CLARIFIES.some((re) => re.test(s));

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

/**
 * Every kind of claim the reply makes about this turn, one per kind, in the order the guard
 * judges them: "asked", "changed", "absent", "asks" (l4-chat-answers: a reply that says a record
 * is missing and offers to add it is first told to look it up).
 */
export function claimsOf(text: string): ReplyClaim[] {
  const own = sentences(text).filter((s) => !EARLIER.test(s));
  const out: ReplyClaim[] = [];
  for (const [kind, patterns] of [
    ["asked", ASKED],
    ["changed", CHANGED],
  ] as const)
    found: for (const s of own)
      for (const p of patterns)
        for (const m of s.matchAll(p.re))
          if (claims(s, m, p)) {
            out.push({ kind, phrase: m[0].trim() });
            break found;
          }
  absent: for (const s of own)
    for (const re of ABSENT)
      for (const m of s.matchAll(re)) {
        out.push({ kind: "absent", phrase: m[0].trim() });
        break absent;
      }
  // A clarifying question is no ask, and a "needs your yes" sentence beside one only is free
  // too: the person's answer to it comes back here, and a change then is read back.
  const asksSomething = own.some((s) => s.endsWith("?") && !clarifies(s));
  // The patterns in their order across the reply's sentences: the question itself is named
  // before a "needs your yes" sentence beside it.
  asks: for (const p of ASKS)
    for (const s of own) {
      if (p.question && (!s.endsWith("?") || clarifies(s))) continue;
      if (p.besideQuestion && !asksSomething) continue;
      for (const m of s.matchAll(p.re)) {
        out.push({ kind: "asks", phrase: m[0].trim() });
        break asks;
      }
    }
  return out;
}

/** The first claim the reply makes about this turn, or null. "asked" is looked for first. */
export function claimOf(text: string): ReplyClaim | null {
  return claimsOf(text)[0] ?? null;
}

/**
 * The turn's one more model step when its reply claims what no command did, the turn's commands
 * did nothing and no card waits (model-facing; the exact text is asserted in
 * conversation-memory.test.ts, "l3-chat-claims, run L3"). `claimNudge` says the other cases.
 */
export const CLAIM_NUDGE =
  'Your reply says that you changed something or asked for the person\'s yes, but no command in this turn did either: nothing changed in this turn and nothing waits for a yes. If the person asked for a change, call its command now; the runtime reads a change that needs a yes back with Yes and No. If you meant a change an earlier turn made, say so ("Earlier, ..."). Otherwise answer again and say that nothing changed.';

/**
 * l4-chat-answers (L4-chat-102, L4-selftasks-118): the nudge for a reply that asks the person for
 * a yes in its own words, or reads a change back itself, while no command of the turn read one
 * back and no card waits (model-facing; asserted word for word in conversation-memory.test.ts,
 * "l4-chat-answers, run L4"). Before, "Shall I set research …?" went to the person with no card,
 * and the person's typed "yes" met "Yes to what?" (design §3.9 keeps that line for a bare yes).
 */
export const ASKS_NUDGE =
  "Your reply asks the person for a yes in words, but no command in this turn read a change back, and a typed yes reaches no one. If the person asked for a change, call its command now; the runtime reads it back with Yes and No. Otherwise answer again without asking for a yes.";

/**
 * l4-chat-answers (L4-chat-101): the nudge for a reply that says a record is not there, or offers
 * to look, in a turn that offered recall and called neither recall tool (model-facing; asserted
 * word for word in chat-recall.test.ts, "l4-chat-answers, run L4"). Before, live check 4's fast
 * model answered "There is no README task" for a task renamed since, and "Should I look …?".
 */
/** What chat shows while the absence nudge looks it up (recall's own step line follows). */
export const LOOKING_STEP = "Looking through everything recorded…";

export const ABSENT_NUDGE =
  "You said it is not there without looking it up. Call recall now with the person's words and other words for it (an earlier name, another language), then answer from what it returns. Never ask whether to look.";

/**
 * The nudge for this claim and what the turn did (model-facing; asserted word for word in
 * conversation-memory.test.ts, "l3-chat-claims, run L3: what the turn did"): what the claim
 * says that no command did, then what is true (a change this turn made, this turn's card
 * waiting, or an earlier turn's card still waiting). With this turn's card waiting the model is
 * told not to call its command again: a second card would wait where no reply shows it.
 */
export function claimNudge(claim: ReplyClaim, did: TurnDid): string {
  if (claim.kind === "absent") return ABSENT_NUDGE;
  if (claim.kind === "asks") return ASKS_NUDGE;
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
