import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_KEY } from "../src/api/session.ts";
import {
  $,
  assertNoTokenLeak,
  bodyText,
  click,
  createHarness,
  type Harness,
  mountApp,
  must,
  openFromLink,
  sessionToken,
  unmountApp,
  waitFor,
} from "./harness.tsx";

describe("sign-in from a link", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("exchanges the fragment code for a session, strips the code and keeps the token in sessionStorage only", async () => {
    const code = await openFromLink(h);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(code);
    const token = sessionToken(h);
    expect(token).toBeTruthy();
    expect(sessionStorage.getItem(SESSION_KEY)).toContain(token as string);
    expect(localStorage.length).toBe(0);
    // The code went over the wire once, in a POST body, never in a path or query string.
    const calls = h.fake.calls();
    expect(calls.filter((c) => c.path === "/pairing/complete")).toHaveLength(1);
    expect(calls.every((c) => !c.path.includes(code) && !c.query.includes(code))).toBe(true);
    await waitFor(() => $("inbox") !== null, "inbox");
    await waitFor(() => must("feed-mode").textContent === "live", "live");
    assertNoTokenLeak(h, token as string);
    expect(h.fake.state.pairings.has(code)).toBe(false);
    expect(h.consoleLines).toEqual([]);
  });

  it("reuses the tab's session on reload without a second exchange", async () => {
    await openFromLink(h);
    const token = sessionToken(h) as string;
    await unmountApp(h);
    await mountApp(h);
    await waitFor(() => $("active-project") !== null, "shell after reload");
    expect(h.fake.calls("/pairing/complete")).toHaveLength(1);
    expect(sessionToken(h)).toBe(token);
    assertNoTokenLeak(h, token);
  });

  it("ignores a session issued by another service and asks for a link", async () => {
    await openFromLink(h);
    await unmountApp(h);
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "{}") as {
      serviceUrl: string;
    };
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...stored, serviceUrl: "http://127.0.0.1:9" }),
    );
    await mountApp(h);
    await waitFor(() => $("sign-in") !== null, "sign-in");
    expect(bodyText()).toMatch(/Open this page from the link/);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(h.fake.calls("/pairing/complete")).toHaveLength(1);
  });

  it("signs out on request and forgets the session", async () => {
    await openFromLink(h);
    expect(sessionToken(h)).toBeTruthy();
    await click(must("sign-out"));
    await waitFor(() => $("sign-in") !== null, "sign-in after sign out");
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    await unmountApp(h);
    await mountApp(h);
    await waitFor(() => $("empty-state") !== null, "still signed out");
  });

  it("shows plain words for a used or unknown code and for a page without a link", async () => {
    await mountApp(h, { code: "NOPE2345" });
    await waitFor(() => $("sign-in-error") !== null, "error");
    expect(must("sign-in-error").textContent).toMatch(/already used or has expired/);
    expect(window.location.hash).toBe("");
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    await unmountApp(h);
    await mountApp(h);
    await waitFor(() => $("empty-state") !== null, "empty state");
    expect(h.fake.calls()).toHaveLength(1);
  });

  it("refuses a link whose code was already used by another tab", async () => {
    const code = h.fake.startPairing();
    h.fake.state.pairings.delete(code);
    await mountApp(h, { code });
    await waitFor(() => $("sign-in-error") !== null, "error");
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
