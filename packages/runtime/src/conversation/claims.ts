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
 * ("Earlier I set …", "you said yes") is the history, not a claim about this turn. The chat
 * (`ConversationAgent.chat`) checks the claim against the turn's command results: a claim no
 * command backs is nudged once (`CLAIM_NUDGE`), then replaced with `NOTHING_CHANGED_REPLY`.
 */

/** What a reply claims the app did in this turn. */
export interface ReplyClaim {
  /** "asked": a yes was asked for or a request sent; "changed": something was changed. */
  kind: "asked" | "changed";
  /** The words that claim it, as the reply has them (logged on the chat.reply row). */
  phrase: string;
}

/** Sentences about an earlier turn: what the history says, not a claim about this turn. */
const EARLIER =
  /\b(?:earlier|previously|last time|in an earlier turn|yesterday|you (?:said|answered|approved|confirmed|agreed)|vorhin|zuvor|vorher|gestern|hast du (?:bestätigt|zugestimmt|ja gesagt))\b/i;

const ASKED: RegExp[] = [
  // "I've asked for confirmation", "so I asked for your yes", "I have sent a request", "I've
  // opened a card in your Inbox".
  /\bI(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|also\s+|already\s+)?(?:asked|requested|sent|filed|raised|opened|submitted|created|queued)\b[^.!?\n]{0,80}?\b(?:confirm(?:ation|ing)?|approv(?:al|e)|your yes|a yes|sign-?off|request|card|inbox)\b/i,
  // "I'm waiting for your yes", "I'll wait for your confirmation".
  /\bI(?:'m|’m| am)\s+(?:now\s+)?waiting\s+for\s+your\s+(?:yes|confirmation|approval|go-ahead|ok)\b/i,
  /\bI(?:'ll|’ll| will)\s+wait\s+for\s+your\s+(?:yes|confirmation|approval|go-ahead|ok)\b/i,
  // "I'll apply it once you approve".
  /\bI(?:'ll|’ll| will)\s+(?:apply|make|change|do|set|switch)\b[^.!?\n]{0,60}\bonce you (?:approve|confirm|say yes)\b/i,
  // "Confirmation has been requested", "a confirmation request was sent".
  /\b(?:confirmation|approval)\s+(?:has been|was|is)\s+(?:requested|sent|asked for)\b/i,
  /\b(?:confirmation|approval)\s+request\s+(?:has been|was|is)\s+(?:sent|filed|opened|created)\b/i,
  // German: "Ich habe um deine Bestätigung gebeten", "habe eine Freigabe angefordert".
  /\bhabe\b[^.!?\n]{0,60}\b(?:Bestätigung|Zustimmung|Freigabe|ein Ja|dein Ja|Ihr Ja)\b[^.!?\n]{0,40}?\b(?:gebeten|angefragt|angefordert|eingeholt|gestellt)\b/i,
  /\bhabe\b[^.!?\n]{0,60}\b(?:Anfrage|Karte|Rückfrage)\b[^.!?\n]{0,40}?\b(?:gesendet|geschickt|erstellt|gestellt|angelegt)\b/i,
  /\bich warte auf (?:deine|Ihre|dein|Ihr)\s+(?:Bestätigung|Zustimmung|Freigabe|Ja|Okay)\b/i,
];

const CHANGED: RegExp[] = [
  // "I've set research to …", "I have changed the budget", "I've now paused it".
  /\bI(?:'ve|’ve| have)\s+(?:now\s+|just\s+|also\s+|already\s+)?(?:changed|set|updated|switched|turned (?:on|off)|added|paused|resumed|cancell?ed|removed|deleted|stopped|started|raised|lowered|widened|narrowed|limited|restricted|allowed|enabled|disabled|reopened|moved|renamed)\b/i,
  // German: "Ich habe die Regel geändert", "habe die Recherche umgestellt".
  /\bhabe\b[^.!?\n]{0,60}\b(?:geändert|gesetzt|umgestellt|aktualisiert|hinzugefügt|pausiert|fortgesetzt|abgebrochen|gestoppt|gestartet|erhöht|gesenkt|eingeschränkt|erweitert|erlaubt|aktiviert|deaktiviert|entfernt|gelöscht|verschoben|umbenannt)\b/i,
];

/** The reply's sentences (a claim is judged per sentence). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first claim the reply makes about this turn, or null. "asked" is looked for first. */
export function claimOf(text: string): ReplyClaim | null {
  const own = sentences(text).filter((s) => !EARLIER.test(s));
  for (const [kind, patterns] of [
    ["asked", ASKED],
    ["changed", CHANGED],
  ] as const)
    for (const s of own)
      for (const re of patterns) {
        const m = re.exec(s);
        if (m) return { kind, phrase: m[0].trim() };
      }
  return null;
}

/**
 * The turn's one more model step when its reply claims what no command did (model-facing; the
 * exact text is asserted in conversation-memory.test.ts, "l3-chat-claims, run L3").
 */
export const CLAIM_NUDGE =
  "Your reply says that you changed something or asked for the person's yes, but no command in this turn did either: nothing changed and nothing waits for a yes. If the person asked for a change, call its command now; the runtime reads a change that needs a yes back with Yes and No. Otherwise answer again and say that nothing changed.";

/** What the person reads when the reply still claims it after the nudge (design §5 rule 8). */
export const NOTHING_CHANGED_REPLY =
  "Nothing changed, and nothing waits for your yes. Say it again to try once more.";
