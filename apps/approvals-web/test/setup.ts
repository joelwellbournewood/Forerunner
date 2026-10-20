import { afterEach } from "vitest";

/**
 * React's act() environment flag is on only while the harness drives an interaction; the
 * rest of the time React schedules work as it does in a browser, so updates from fetch
 * callbacks flush on their own while `waitFor` polls (the same split Testing Library makes).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

afterEach(() => {
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    // storage may be unavailable in some runs
  }
  window.history.replaceState(null, "", window.location.pathname);
});
