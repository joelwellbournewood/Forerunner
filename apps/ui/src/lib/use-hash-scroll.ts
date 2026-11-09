import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Scroll to the element the address's `#hash` names once the page has it (`ready`): in-app
 * links such as "Set up Docker" (`/settings#sandbox`) and Home's "Answer" (`/inbox#card-<id>`)
 * land on what they name, not at the top of the page (wave 2: the page stayed at the top).
 * `ready` is when what comes before it is on the page (P7-12: Settings scrolled at mount, before
 * its rows loaded and pushed the section down, so "Change" on the Overview opened Settings at
 * its top); an element that is not there yet is waited for (up to 15 s) as the page fills in.
 */
export function useScrollToHash(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash || hash.length < 2) return;
    const id = decodeURIComponent(hash.slice(1));
    const land = (): boolean => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView?.({ block: "start", behavior: "smooth" });
      el.setAttribute("data-targeted", "true");
      return true;
    };
    if (land() || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (land()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const stop = setTimeout(() => observer.disconnect(), 15_000);
    return () => {
      observer.disconnect();
      clearTimeout(stop);
    };
  }, [hash, ready]);
}
