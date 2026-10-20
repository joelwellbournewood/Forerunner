import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_KEY } from "../src/api/session.ts";
import {
  $,
  $$,
  assertNoTokenLeak,
  click,
  createHarness,
  type Harness,
  mountApp,
  must,
  openFromLink,
  sessionToken,
  submit,
  type,
  unmountApp,
  waitFor,
} from "./harness.tsx";

/**
 * Security review of the approvals web page (spec K.8, R.7; ADR 0009, ADR 0034): the
 * one-time link, the per-tab key, the re-entered code for high-risk answers and the
 * refusal of credential requests. Each test is an attack from a real input (a code in the
 * query string, the link's own code as a confirmation, a tampered storage record) and
 * asserts what the page sends and keeps.
 */
async function openInbox(h: Harness, scopes?: string[]): Promise<string> {
  const code = await openFromLink(h, { scopes });
  await waitFor(() => $$("request").length > 0, "requests");
  return code;
}

function requestCard(id: string): HTMLElement {
  const card = $$("request").find((c) => c.dataset.requestId === id);
  if (!card) throw new Error(`no request card ${id}`);
  return card;
}

/** Everything the fake saw from this page, as text, without the bearer header. */
function wireText(h: Harness): string {
  return h.fake
    .calls()
    .map((c) => {
      const headers = { ...c.headers };
      delete headers.authorization;
      return JSON.stringify({ p: c.path, q: c.query, h: headers, b: c.body });
    })
    .join("\n");
}

describe("security: the one-time link", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    window.history.replaceState(null, "", "/");
    await h.close();
  });

  it("a code in the query string is never exchanged: only the fragment carries it", async () => {
    const code = h.fake.startPairing({});
    window.history.replaceState(null, "", `/?code=${code}`);
    await mountApp(h);
    await waitFor(() => $("sign-in") !== null, "sign-in screen");
    expect(h.fake.calls("/pairing/complete")).toHaveLength(0);
    expect(sessionToken(h)).toBeNull();
    // The unused code is still valid for the real link: nothing was burnt by the page.
    expect(h.fake.state.pairings.has(code)).toBe(true);
  });

  it("the exchanged code is gone from the address bar and history, and the fragment is never sent", async () => {
    const code = await openInbox(h);
    expect(window.location.hash).toBe("");
    expect(window.location.href.includes(code)).toBe(false);
    for (const call of h.fake.calls()) {
      // The code travels once, in the body of /pairing/complete, never in a URL.
      expect(call.path.includes(code), call.path).toBe(false);
      expect(call.query.includes(code), call.path).toBe(false);
    }
    const exchange = h.fake.calls("/pairing/complete");
    expect(exchange).toHaveLength(1);
    // A second exchange of the same code by anyone is refused by the service.
    expect(h.fake.state.pairings.has(code)).toBe(false);
  });

  it("the token and the private key live in sessionStorage only and never go over the wire", async () => {
    await openInbox(h);
    const token = sessionToken(h) as string;
    expect(token.length).toBeGreaterThan(20);
    const raw = h.storage.get(SESSION_KEY) as string;
    const session = JSON.parse(raw) as { privateJwk: { d: string; x: string }; publicKey: string };
    expect(session.privateJwk.d.length).toBeGreaterThan(20);
    assertNoTokenLeak(h, token);
    expect(document.cookie).toBe("");
    expect(localStorage.length).toBe(0);
    const wire = wireText(h);
    expect(wire.includes(token)).toBe(false);
    expect(wire.includes(session.privateJwk.d)).toBe(false);
    // The public key did go out, exactly once, at pairing.
    expect(h.fake.calls("/pairing/complete")[0]?.body).toMatchObject({
      publicKey: session.publicKey,
    });
    expect(h.fake.state.devices.some((d) => d.publicKey === session.publicKey)).toBe(true);
    // Every mutation the page made afterwards was signed by that key.
    await click($$("option", requestCard("req-blocking"))[0] as HTMLElement);
    await waitFor(() => h.fake.calls("/requests/req-blocking/answer").length > 0, "answer");
    const answer = h.fake.calls("/requests/req-blocking/answer")[0];
    expect(answer?.headers["x-device-signature"]).toBeTruthy();
    expect(answer?.headers["x-device-timestamp"]).toBeTruthy();
    expect(answer?.headers["x-biometric-assertion"]).toBeUndefined();
  });

  it("a storage record with widened scopes does not get past the service", async () => {
    await openFromLink(h, { scopes: ["read"] });
    await waitFor(() => $$("request").length > 0, "requests");
    expect($$("option", requestCard("req-blocking"))).toHaveLength(0);
    // Tamper with the tab's own record: claim approvals, then reload the page.
    const raw = h.storage.get(SESSION_KEY) as string;
    const record = JSON.parse(raw) as { scopes: string[] };
    record.scopes = [...record.scopes, "write:approvals"];
    h.storage.set(SESSION_KEY, JSON.stringify(record));
    await unmountApp(h);
    await mountApp(h);
    await waitFor(() => $$("request").length > 0, "requests after reload");
    const card = requestCard("req-blocking");
    expect($$("option", card).length).toBeGreaterThan(0);
    await click($$("option", card)[0] as HTMLElement);
    await waitFor(() => $("answer-error", card) !== null, "refusal shown");
    expect(must("answer-error", card).textContent).toMatch(/does not allow/);
    const call = h.fake.calls("/requests/req-blocking/answer")[0];
    expect(call?.headers["x-device-signature"]).toBeTruthy();
    expect(h.fake.state.requests.find((r) => r.id === "req-blocking")?.status).toBe("open");
  });
});

describe("security: high-risk answers and credential requests", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("the link's own code is refused as a confirmation code; the page never asserts biometrics", async () => {
    const linkCode = await openInbox(h);
    const card = requestCard("req-high");
    await click($$("option", card)[0] as HTMLElement);
    await waitFor(() => $("confirm-form") !== null, "confirm dialog");
    expect(h.fake.calls("/requests/req-high/answer")).toHaveLength(0);
    await type(must("confirm-code") as HTMLInputElement, linkCode);
    await submit(must("confirm-form"));
    await waitFor(() => $("confirm-error") !== null, "refused");
    expect(h.fake.state.requests.find((r) => r.id === "req-high")?.status).toBe("open");
    // Guessing: a string of the right shape is refused too, and the request stays open.
    await type(must("confirm-code") as HTMLInputElement, "ABCD2345");
    await submit(must("confirm-form"));
    await waitFor(() => h.fake.calls("/requests/req-high/answer").length >= 2, "second try");
    expect(h.fake.state.requests.find((r) => r.id === "req-high")?.status).toBe("open");
    for (const call of h.fake.calls()) {
      expect(call.headers["x-biometric-assertion"], call.path).toBeUndefined();
    }
    const answers = h.fake.calls("/requests/req-high/answer");
    expect(answers.every((c) => c.headers["x-device-signature"])).toBe(true);
    // The wrong attempts carried the challenge id and the typed code, never the token or the key.
    const wire = wireText(h);
    expect(wire.includes(sessionToken(h) as string)).toBe(false);
  });

  it("a high-risk answer without the confirmation route is not sent at all", async () => {
    await h.close();
    h = await createHarness({ supportsConfirm: false });
    await openInbox(h);
    await click($$("option", requestCard("req-high"))[0] as HTMLElement);
    await waitFor(() => $("confirm-unavailable") !== null, "unavailable");
    expect(h.fake.calls("/requests/req-high/answer")).toHaveLength(0);
    expect(h.fake.state.requests.find((r) => r.id === "req-high")?.status).toBe("open");
  });

  it("a credential request has no answer controls and nothing is ever posted for it", async () => {
    await openInbox(h);
    const cred = requestCard("req-cred");
    expect($("credential-notice", cred)).not.toBeNull();
    expect(cred.querySelector("input, textarea, select")).toBeNull();
    expect($$("option", cred)).toHaveLength(0);
    expect(cred.querySelector("form")).toBeNull();
    expect(must("credential-notice", cred).textContent).toMatch(/never through this page/);
    // Answering other requests does not touch it.
    await click($$("option", requestCard("req-blocking"))[0] as HTMLElement);
    await waitFor(() => h.fake.calls("/requests/req-blocking/answer").length > 0, "answer");
    expect(h.fake.calls("/requests/req-cred/answer")).toHaveLength(0);
    expect(h.fake.state.requests.find((r) => r.id === "req-cred")?.status).toBe("open");
  });

  it("a link without the approvals scope cannot answer anything, high risk included", async () => {
    await openInbox(h, ["read"]);
    for (const id of ["req-blocking", "req-high", "req-free", "req-cred"]) {
      const card = requestCard(id);
      expect($$("option", card), id).toHaveLength(0);
      expect(card.querySelector("input"), id).toBeNull();
    }
    expect(h.fake.calls().filter((c) => c.path.endsWith("/answer"))).toHaveLength(0);
    expect(h.fake.calls("/confirm/challenge")).toHaveLength(0);
  });
});
