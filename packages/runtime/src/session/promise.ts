/**
 * What a session promises at its start (d1109-starts-engine S-6, ADR 0118): the helpers the
 * Start dialog's check (`start-check.ts`) and the runner both use, so the promise the person saw
 * is the one the session keeps.
 */

/**
 * The waiting tasks a session takes as they become ready (design §3.6): those whose every
 * unfinished dependency runs in it, is in flight, or is itself one of these (a fixed point), in
 * order; never one that waits on a failed, cancelled, missing or person-held task.
 */
export function followersOf<T extends { id: string }>(
  waiting: readonly { task: T; waitsOn: readonly { id: string }[] }[],
  comes: Set<string>,
  skip: (t: T) => boolean = () => false,
): T[] {
  const out: T[] = [];
  const seen = new Set(comes);
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of waiting) {
      if (seen.has(w.task.id) || skip(w.task)) continue;
      if (w.waitsOn.every((d) => seen.has(d.id))) {
        seen.add(w.task.id);
        out.push(w.task);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * The followers cut to the work budget left after what runs first (S-6): in run order, until one
 * does not fit (a follower waits on the ones before it); the rest wait for a later Start.
 */
export function cutFollowers<T extends { estimateUsdMicro: number }>(
  later: readonly T[],
  roomUsdMicro: number,
): { taken: T[]; beyond: T[] } {
  let room = roomUsdMicro;
  const taken: T[] = [];
  let at = 0;
  for (; at < later.length; at++) {
    const t = later[at] as T;
    if (t.estimateUsdMicro > room) break;
    taken.push(t);
    room -= t.estimateUsdMicro;
  }
  return { taken, beyond: later.slice(at) };
}
