/*
 * The plan card's words (design §3.3): the decision the plan records in one or two sentences,
 * and what the total covers. Live (2026-11-01) the card pasted the whole decision record
 * ("Status: proposed. The human reads this before approving.", "Answers: _pending_") and the
 * total left out a task with no estimate without saying so.
 */

/** Markdown marks out of one line of text: emphasis, code ticks, a heading or list marker. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])[_*]([^_*\n]+)[_*](?=[\s).,;:!?]|$)/g, "$1$2")
    .trim();
}

/** The first one or two sentences of a text, at most `max` characters, cut at a word. */
function sentences(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  // A sentence ends at ".", "!" or "?" before white space: "quotes.js" is one word.
  const two = t
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ")
    .trim();
  if (two.length <= max) return two;
  const cut = two.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** Lines that are about the record, not the decision: status, date, answer placeholders. */
const META =
  /^(?:status|date|answers?|human answers|decided by|deciders?)\b|^\(?to be (?:filled|recorded)/i;

/**
 * The decision a drafted record makes, in one or two sentences, or null: the record's own
 * "Decision: …" line (the intake asks for one), else the first item or paragraph under the
 * first heading about a decision or a choice (not the open questions), else the first paragraph
 * that is not the title or a status line.
 */
export function decisionLine(md: string): string | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  // 1. "Decision: …" (any emphasis around the word).
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:\*\*|__)?decision(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i.exec(
      lines[i] as string,
    );
    if (!m) continue;
    const rest = [m[1] ?? ""];
    for (let j = i + 1; j < lines.length && (lines[j] as string).trim(); j++)
      rest.push(lines[j] as string);
    const text = plainLine(rest.join(" "));
    if (text) return sentences(text);
  }
  const blockAfter = (start: number): string | null => {
    for (let i = start; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.trim()) continue;
      if (/^\s*#/.test(line)) return null;
      const text = plainLine(line);
      if (!text || META.test(text)) continue;
      // A list item is its first line; a paragraph runs to the blank line.
      if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) return text;
      const para = [text];
      for (let j = i + 1; j < lines.length && (lines[j] as string).trim(); j++) {
        if (/^\s*(?:#|[-*•]\s|\d+[.)]\s)/.test(lines[j] as string)) break;
        para.push(plainLine(lines[j] as string));
      }
      return para.join(" ");
    }
    return null;
  };
  // 2. Under the first heading about a decision or a choice, not the open questions.
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*#{1,6}\s*(.*)$/.exec(lines[i] as string)?.[1] ?? null;
    if (h === null || i === 0) continue;
    if (!/decid|decision|choice|chose|chosen/i.test(h)) continue;
    if (/question|open|answer|pending|human|status|consequence/i.test(h)) continue;
    const text = blockAfter(i + 1);
    if (text) return sentences(text);
  }
  // 3. The first paragraph that is not the title or a status line.
  const first = lines.findIndex((l) => /^\s*#/.test(l));
  const text = blockAfter(first >= 0 ? first + 1 : 0);
  return text ? sentences(text) : null;
}

/**
 * What the plan's total covers, in words (design §5: say what a number is): every task the
 * agent does has an estimate, some do, or none do. A person's task costs nothing and is not
 * counted; when there is one, the sentence says "the tasks the agent does".
 */
export function planTotalWords(o: {
  /** Tasks a specialist does (not the person's). */
  agentTasks: number;
  /** Of those, the ones with an estimate. */
  estimated: number;
  /** The estimates' sum, as the card shows money ("CHF 1.04"). */
  total: string;
  /** The plan has a task for the person. */
  personTasks: boolean;
}): string {
  const who = o.personTasks ? " the agent does" : "";
  const all = o.agentTasks === 1 ? `the task${who}` : `the ${o.agentTasks} tasks${who}`;
  if (o.agentTasks === 0) return "";
  if (o.estimated === 0) return `The cost of ${all} is not known yet.`;
  if (o.estimated >= o.agentTasks) return `About ${o.total} for ${all}.`;
  const rest = o.agentTasks - o.estimated;
  return `About ${o.total} for ${o.estimated} of the ${o.agentTasks} tasks${who}; ${
    rest === 1 ? "the other one has" : `the other ${rest} have`
  } no estimate yet.`;
}
