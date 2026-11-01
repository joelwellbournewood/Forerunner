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
 * without markers comes out exactly as it went in (lines kept with `whitespace-pre-wrap`).
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
 * `code`, **bold**, __bold__, *italic*, _italic_ (not inside a word: snake_case stays) and
 * [text](url); a marker needs text right inside it, so "2 * 3 * 4" stays as it is. No
 * lookbehind (WebKitGTK before 2.40 has none): an _italic_'s leading boundary is matched and
 * put back as text.
 */
const INLINE =
  /`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)?)\*\*|__(\S(?:[^\n]*?\S)?)__|\*([^\s*](?:[^*\n]*?[^\s*])?)\*|(^|[^\p{L}\p{N}_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\p{L}\p{N}_])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

export function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}.${n++}`;
    // `before` is the character in front of an _italic_ (no lookbehind: older WebKitGTK).
    const [, code, bold1, bold2, em1, before, em2, linkText, href] = m;
    if (before) out.push(before);
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
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
