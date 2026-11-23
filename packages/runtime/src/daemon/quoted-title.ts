/**
 * L3-github-9 (live check 3, step G9): a task title shown in double quotes is cut at a word when
 * it is long, and a title that quotes something itself ('Link trips page from kite/index.html as
 * "Our trips"') must not be cut inside its own quotes. Before, the Inbox titled a card
 * '"Link trips page from kite/index.html as "Our…" changed after the review': the cut left an
 * opening quote without its closing one, so the line read as if the title ended at "Our".
 *
 * `balancedCut` cuts with the caller's own cutter (each screen keeps its way of cutting, its
 * length and its "…"), then, when the part kept opens a quote it does not close, or when the cut
 * dropped a quoted part of the title whole (L4-github-123: 'Write kite/ferry.txt about the ferry
 * trip to "Seal Bay"' read '…trip to…'): the whole title when it is at most `slack` characters
 * longer than `max`, else the part before that quote. With `slack` 0 nothing changes.
 */
export function balancedCut(
  text: string,
  max: number,
  cut: (text: string, max: number) => string,
  slack = 15,
): string {
  const t = text.replace(/\s+/g, " ").trim();
  const done = cut(t, max);
  const kept = done.endsWith("…") ? done.slice(0, -1) : done;
  if ((kept.match(/"/g) ?? []).length % 2 === 0) {
    // L4-github-123: the cut dropped a quoted part of the title's own whole (the word cut ended
    // before its opening quote): a short overrun keeps the title whole, as for a quote left open.
    const dropped = done !== t && t.slice(kept.trimEnd().length).includes('"');
    return dropped && t.length <= max + slack ? t : done;
  }
  if (t.length <= max + slack) return t;
  const before = kept
    .slice(0, kept.lastIndexOf('"'))
    .replace(/[\s,;:.]+$/, "")
    .trim();
  // A title that starts with its quote: the quote marks are dropped rather than left open.
  return before ? `${before}…` : done.replace(/"/g, "");
}
