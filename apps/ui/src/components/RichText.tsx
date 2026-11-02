import type { ReactNode } from "react";

/**
 * Text a model wrote (a chat reply, a specialist's report in a session line), with the small
 * markdown subset models use shown as formatting instead of raw markers (design §3.7, §3.9, §5
 * rule 6: no markdown asterisks): **bold** and __bold__, *italic* and _italic_, `inline code`,
 * "- " / "* " bullet lists, "1. " numbered lists, "#" headings as a bold line, and line breaks.
 * Before (the live run of 2026-11-01) replies and session lines showed "**…**" and
 * "**Summary**:" as typed.
 *
 * Never HTML: every piece is a React text node or one of a few fixed elements, so `<img
 * onerror=…>` in a reply reads as text. A link `[text](url)` shows its text and the address in
 * brackets; nothing is made clickable here (links open through `ExternalLink` elsewhere). Text
 * without markers comes out exactly as it went in (lines kept with `whitespace-pre-wrap`), and
 * so do file names, paths and arithmetic with underscores or asterisks in them (`delimited`).
 * Only model text goes through it: the session log's own lines do not (`EventText`).
 */
export function RichText({
  text,
  className = "",
  testId,
}: {
  text: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={`whitespace-pre-wrap ${className}`.trim()} data-testid={testId}>
      {blocks(text)}
    </div>
  );
}

const BULLET = /^\s{0,3}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

type Line =
  | { kind: "text"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "number"; n: number; text: string };

function lineOf(raw: string): Line | null {
  if (RULE.test(raw)) return null;
  const heading = HEADING.exec(raw);
  if (heading) return { kind: "text", text: `**${heading[1] ?? ""}**` };
  const bullet = BULLET.exec(raw);
  if (bullet) return { kind: "bullet", text: bullet[1] ?? "" };
  const numbered = NUMBERED.exec(raw);
  if (numbered) return { kind: "number", n: Number(numbered[1]), text: numbered[2] ?? "" };
  return { kind: "text", text: raw };
}

/** Lines grouped into runs of text (joined by line breaks) and lists. */
function blocks(text: string): ReactNode[] {
  const lines = text
    .split(/\r?\n/)
    .map(lineOf)
    .filter((l): l is Line => l !== null);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.kind === "text") {
      const run: ReactNode[] = [];
      while (i < lines.length && (lines[i] as Line).kind === "text") {
        if (run.length) run.push("\n");
        run.push(...inline((lines[i] as Line).text, `t${i}`));
        i++;
      }
      // A line break between this run and a list after it is the list's own.
      out.push(...trimTrailingBreaks(run));
      continue;
    }
    const kind = line.kind;
    const items: { key: string; text: string; n?: number }[] = [];
    while (i < lines.length && (lines[i] as Line).kind === kind) {
      const l = lines[i] as Line;
      items.push({ key: `l${i}`, text: l.text, ...(l.kind === "number" ? { n: l.n } : {}) });
      i++;
    }
    const lis = items.map((it) => (
      <li key={it.key} className="whitespace-normal">
        {inline(it.text, it.key)}
      </li>
    ));
    out.push(
      kind === "bullet" ? (
        <ul key={`ul${i}`} className="my-1 list-disc pl-5">
          {lis}
        </ul>
      ) : (
        <ol key={`ol${i}`} className="my-1 list-decimal pl-5" start={items[0]?.n ?? 1}>
          {lis}
        </ol>
      ),
    );
  }
  return out;
}

function trimTrailingBreaks(run: ReactNode[]): ReactNode[] {
  const out = [...run];
  while (out.length && out.at(-1) === "\n") out.pop();
  return out;
}

/**
 * `code`, **bold**, __bold__, *italic*, _italic_ and [text](url); a marker needs text right
 * inside it, so "2 * 3 * 4" stays as it is, and the nearest closing marker ends it ("**2** of
 * **3**" is two bold parts). These are candidates: `delimited` then decides from the characters
 * around them (no lookbehind: WebKitGTK before 2.40 has none).
 */
const INLINE =
  /`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)??)\*\*|__(\S(?:[^\n]*?\S)??)__|\*([^\s*](?:[^*\n]*?[^\s*])?)\*|_([^\s_](?:[^_\n]*?[^\s_])?)_|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

const WORD = /[\p{L}\p{N}]/u;
const PATH_SEPARATOR = /[/\\]/;
/** A dunder name (`__init__`, `__tests__`, `__mocks__`): Python's and Jest's, never bold. */
const DUNDER = /^[a-z][a-z0-9_]*$/;

/**
 * Whether the markers at `at` (opening) and `end` (just after the closing one) are formatting,
 * not part of a name, a path or arithmetic: no letter, digit, path separator or marker of the
 * same kind touches them on the outside, no dot joins them to a name, and no path separator
 * sits right inside them; `__name__` in lower case is a dunder name. So
 * "__tests__/quote.test.js", "app/__init__.py", "test/**\/*.test.js" and "2*3 and 4*5" stay as
 * typed (before, their underscores or asterisks vanished and part of the path turned bold: the
 * review of 2026-11-02), while "**Summary**:", "*style.css*." and "(_your_)" format.
 */
function delimited(
  text: string,
  at: number,
  end: number,
  marker: "*" | "_",
  inner: string,
): boolean {
  const before = text[at - 1] ?? "";
  const after = text[end] ?? "";
  const touches = (c: string) => c === marker || PATH_SEPARATOR.test(c) || WORD.test(c);
  if (touches(before) || touches(after)) return false;
  if (before === "." || (after === "." && WORD.test(text[end + 1] ?? ""))) return false;
  if (PATH_SEPARATOR.test(inner[0] ?? "") || PATH_SEPARATOR.test(inner.at(-1) ?? "")) return false;
  if (marker === "_" && text.startsWith("__", at) && DUNDER.test(inner)) return false;
  return true;
}

export function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, INLINE.flags);
  let last = 0;
  let n = 0;
  let from = 0;
  while (from < text.length) {
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) break;
    const at = m.index;
    const end = at + m[0].length;
    const [, code, bold1, bold2, em1, em2, linkText, href] = m;
    const emphasis = bold1 ?? bold2 ?? em1 ?? em2;
    const marker = bold1 !== undefined || em1 !== undefined ? "*" : "_";
    if (emphasis !== undefined && !delimited(text, at, end, marker, emphasis)) {
      // Not formatting here: the marker is text. Look again from the next character.
      from = at + 1;
      continue;
    }
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}.${n++}`;
    if (code !== undefined)
      out.push(
        <code key={k} className="rounded bg-black/5 px-1 font-mono text-[0.9em] dark:bg-white/10">
          {code}
        </code>,
      );
    else if (bold1 !== undefined || bold2 !== undefined)
      out.push(<strong key={k}>{inline(bold1 ?? bold2 ?? "", k)}</strong>);
    else if (em1 !== undefined || em2 !== undefined)
      out.push(<em key={k}>{inline(em1 ?? em2 ?? "", k)}</em>);
    else if (linkText !== undefined)
      out.push(href && href !== linkText ? `${linkText} (${href})` : linkText);
    last = end;
    from = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The session log's event types whose line ends in text a model wrote: the plan's summary, a
 * specialist's report, the critic's summaries and the chat's reply. Every other line is the
 * runtime's own words, often with file names and commands in it ("wrote __tests__/a.test.js",
 * "ran node --test test/**\/*.test.js: ok"), and shows exactly as it came.
 */
export const MODEL_TEXT_EVENTS: ReadonlySet<string> = new Set([
  "session.planned",
  "task.finished",
  "critic.verdict",
  "critic.session_review",
  "chat.reply",
]);

/** One session log line: a model's text formatted (`RichText`), the runtime's own as typed. */
export function EventText({
  type,
  text,
  className = "",
}: {
  type: string;
  text: string;
  className?: string;
}) {
  return MODEL_TEXT_EVENTS.has(type) ? (
    <RichText text={text} className={className} />
  ) : (
    <span className={`whitespace-pre-wrap ${className}`.trim()}>{text}</span>
  );
}
