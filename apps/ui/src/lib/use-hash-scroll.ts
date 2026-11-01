import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Scroll to the element the address's `#hash` names once the page has it (`ready`): in-app
 * links such as "Set up Docker" (`/settings#sandbox`) and Home's "Answer" (`/inbox#card-<id>`)
 * land on what they name, not at the top of the page (wave 2: the page stayed at the top).
 */
export function useScrollToHash(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash || hash.length < 2) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    el.scrollIntoView?.({ block: "start", behavior: "smooth" });
    el.setAttribute("data-targeted", "true");
  }, [hash, ready]);
}
