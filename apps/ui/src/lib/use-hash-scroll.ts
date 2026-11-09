import { useEffect } from "react";
import { useLocation } from "react-router";

/** How long a page may keep filling in above the target before it is left where it is. */
const SETTLE_MS = 15_000;

/** Input that means the person moves the page themselves; landing stops at the first. */
const PERSON_INPUT = ["wheel", "touchstart", "keydown", "pointerdown", "mousedown"] as const;

/**
 * Scroll to the element the address's `#hash` names once the page has it (`ready`): in-app
 * links such as "Set up Docker" (`/settings#sandbox`) and Home's "Answer" (`/inbox#card-<id>`)
 * land on what they name, not at the top of the page (wave 2: the page stayed at the top).
 *
 * The sections above a target often load on their own after `ready` (Settings: the models, the
 * subscription allowance, the credential order, devices, sources and voice above "Other
 * settings"), and each pushes it down. So the page lands again, at once and not smoothly,
 * whenever the page changes, until the person moves it themselves (wheel, touch, a key, a
 * click) or the page has had `SETTLE_MS` to fill in. P7-12: a single smooth scroll as the rows
 * came left "Other settings" 400 to 1900 px down the page once the sections above had loaded.
 * An element that is not there yet is waited for the same way.
 */
export function useScrollToHash(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash || hash.length < 2) return;
    const id = decodeURIComponent(hash.slice(1));
    let stopped = false;
    let frame: number | null = null;
    const land = (): void => {
      const el = document.getElementById(id);
      if (!el) return;
      // "instant": a smooth scroll aims at where the element was when it began, and the
      // sections that load meanwhile leave it short.
      el.scrollIntoView?.({ block: "start", behavior: "instant" as ScrollBehavior });
      if (!el.hasAttribute("data-targeted")) el.setAttribute("data-targeted", "true");
    };
    const later = (): void => {
      if (stopped || frame !== null) return;
      if (typeof requestAnimationFrame === "undefined") {
        land();
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!stopped) land();
      });
    };
    const observers: { disconnect(): void }[] = [];
    let settle: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      for (const o of observers) o.disconnect();
      if (frame !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(frame);
      }
      frame = null;
      for (const type of PERSON_INPUT) window.removeEventListener(type, stop, true);
      clearTimeout(settle);
    };
    land();
    if (typeof MutationObserver !== "undefined") {
      const mutations = new MutationObserver(later);
      mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
      observers.push(mutations);
    }
    if (typeof ResizeObserver !== "undefined") {
      // A section that grows without a change in the page's tree (an image, a font).
      const sizes = new ResizeObserver(later);
      sizes.observe(document.body);
      observers.push(sizes);
    }
    for (const type of PERSON_INPUT) {
      window.addEventListener(type, stop, { capture: true, passive: true });
    }
    settle = setTimeout(stop, SETTLE_MS);
    return stop;
  }, [hash, ready]);
}
