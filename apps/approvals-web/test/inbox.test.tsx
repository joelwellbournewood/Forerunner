import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  $,
  $$,
  bodyText,
  click,
  createHarness,
  type Harness,
  must,
  openFromLink,
  submit,
  type,
  waitFor,
} from "./harness.tsx";

async function openInbox(h: Harness, scopes?: string[]) {
  await openFromLink(h, { scopes });
  await waitFor(() => $$("request").length > 0, "requests");
}

describe("inbox", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("lists requests blocking first with context, why, options and the blocking flag", async () => {
    await openInbox(h);
    const cards = $$("request");
    expect(cards.map((c) => c.dataset.requestId)).toEqual([
      "req-blocking",
      "req-approval",
      "req-high",
      "req-free",
      "req-cred",
    ]);
    const first = cards[0] as HTMLElement;
    expect(first.dataset.blocking).toBe("1");
    expect($("blocking", first)).not.toBeNull();
    expect(first.textContent).toMatch(/Why it matters: The schema depends on it/);
    expect(must("steps", first).textContent).toMatch(/Read the plan summary/);
    expect($$("option", first).map((b) => b.textContent)).toEqual(["Postgres", "SQLite"]);
    expect($("non-blocking", cards[1] as HTMLElement)).not.toBeNull();
    expect(bodyText()).toMatch(/PharmaWatch/);
    await waitFor(() => $("blocking-badge") !== null, "badge");
    expect(must("blocking-badge").textContent).toBe("1 blocking");
    expect($$("message")).toHaveLength(2);
  });

  it("answers with the version, drops the request and never shows it again", async () => {
    await openInbox(h);
    const card = must("request");
    await click($$("option", card)[0] as HTMLElement);
    await waitFor(
      () => !$$("request").some((c) => c.dataset.requestId === "req-blocking"),
      "removed",
    );
    const call = h.fake.calls("/requests/req-blocking/answer")[0];
    expect(call?.body).toEqual({ version: 1, answer: "Postgres" });
    expect(call?.headers["x-device-signature"]).toBeTruthy();
    expect(h.fake.state.requests.find((r) => r.id === "req-blocking")?.status).toBe("answered");
    await waitFor(() => $("blocking-badge") === null, "badge gone");
    // A reload (the feed's poll) still does not bring it back.
    await waitFor(() => h.fake.calls("/inbox").length >= 3, "reloads");
    expect($$("request").some((c) => c.dataset.requestId === "req-blocking")).toBe(false);
  });

  it("takes a free-text answer when there are no options and refuses credentials", async () => {
    await openInbox(h);
    const free = $$("request").find((c) => c.dataset.requestId === "req-free") as HTMLElement;
    const input = free.querySelector("input") as HTMLInputElement;
    await type(input, "Europe/Zurich");
    await submit(must("free-text", free));
    await waitFor(() => !$$("request").some((c) => c.dataset.requestId === "req-free"), "answered");
    expect(h.fake.calls("/requests/req-free/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Europe/Zurich",
    });
    const cred = $$("request").find((c) => c.dataset.requestId === "req-cred") as HTMLElement;
    expect($("credential-notice", cred)).not.toBeNull();
    expect(cred.querySelector("input")).toBeNull();
    expect($$("option", cred)).toHaveLength(0);
  });

  it("shows a 409 as changed, with a reload that fetches the latest", async () => {
    // The feed polls the inbox when the stream is not live; a poll landing between the version
    // bump below and the click would hand the card the new version and the answer would succeed.
    // This case keeps the poll far away so the only reload is the explicit one it clicks.
    await openFromLink(h, { feed: { pollIntervalMs: 600_000 } });
    await waitFor(() => $$("request").length > 0, "requests");
    const target = h.fake.state.requests.find((r) => r.id === "req-approval");
    if (!target) throw new Error("fixture");
    target.version = 2;
    const card = $$("request").find((c) => c.dataset.requestId === "req-approval") as HTMLElement;
    await click($$("option", card)[0] as HTMLElement);
    await waitFor(() => $("conflict") !== null, "conflict");
    expect(must("conflict").textContent).toMatch(/changed on another device/);
    expect($$("option", card)).toHaveLength(0);
    const before = h.fake.calls("/inbox").length;
    await click(must("reload"));
    await waitFor(() => h.fake.calls("/inbox").length > before, "reloaded");
    await waitFor(() => $("conflict") === null, "conflict cleared");
    const fresh = $$("request").find((c) => c.dataset.requestId === "req-approval") as HTMLElement;
    await click($$("option", fresh)[1] as HTMLElement);
    await waitFor(
      () => !$$("request").some((c) => c.dataset.requestId === "req-approval"),
      "answered",
    );
    expect(h.fake.calls("/requests/req-approval/answer")[1]?.body).toEqual({
      version: 2,
      answer: "Reject",
    });
  });

  it("asks for a fresh code on a high-risk answer, rejects a wrong one and accepts the right one", async () => {
    await openInbox(h);
    const card = $$("request").find((c) => c.dataset.requestId === "req-high") as HTMLElement;
    expect($("high-risk", card)).not.toBeNull();
    await click($$("option", card)[0] as HTMLElement);
    await waitFor(() => $("confirm-form") !== null, "confirm dialog");
    expect(h.fake.calls("/requests/req-high/answer")).toHaveLength(0);
    expect(h.fake.calls("/confirm/challenge")[0]?.body).toEqual({ requestId: "req-high" });
    expect(must("confirm-dialog").textContent).toMatch(/sent to your phone/);
    const sentCode = h.fake.state.lastCode as string;
    expect(sentCode).toMatch(/^[A-Z2-9]{8}$/);
    await type(must("confirm-code") as HTMLInputElement, "WRONG234");
    await submit(must("confirm-form"));
    await waitFor(() => $("confirm-error") !== null, "wrong code");
    expect(must("confirm-error").textContent).toMatch(/wrong or has expired/);
    expect($$("request").some((c) => c.dataset.requestId === "req-high")).toBe(true);
    await type(must("confirm-code") as HTMLInputElement, sentCode.toLowerCase());
    await submit(must("confirm-form"));
    await waitFor(() => !$$("request").some((c) => c.dataset.requestId === "req-high"), "answered");
    const calls = h.fake.calls("/requests/req-high/answer");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({
      version: 1,
      answer: "Yes, raise it",
      confirmation: { challengeId: "ch-2", code: sentCode },
    });
    expect(calls.every((c) => c.headers["x-biometric-assertion"] === undefined)).toBe(true);
    expect(h.fake.state.requests.find((r) => r.id === "req-high")?.status).toBe("answered");
  });

  it("explains when the service cannot send confirmation codes", async () => {
    await h.close();
    h = await createHarness({ supportsConfirm: false });
    await openInbox(h);
    const card = $$("request").find((c) => c.dataset.requestId === "req-high") as HTMLElement;
    await click($$("option", card)[0] as HTMLElement);
    await waitFor(() => $("confirm-unavailable") !== null, "unavailable");
    expect(must("confirm-unavailable").textContent).toMatch(/cannot send confirmation codes yet/);
    expect(h.fake.calls("/requests/req-high/answer")).toHaveLength(0);
  });

  it("marks a message read and reloads when another device answers", async () => {
    await openInbox(h);
    await click($$("mark-read")[0] as HTMLElement);
    await waitFor(() => $$("read").length === 1, "read badge");
    expect(h.fake.calls("/messages/msg-1/receipt")[0]?.body).toEqual({ state: "read" });
    const r = h.fake.state.requests.find((x) => x.id === "req-blocking");
    if (!r) throw new Error("fixture");
    r.status = "answered";
    h.fake.emit({
      type: "human_request.changed",
      humanId: "h1",
      projectId: "proj-1",
      sessionId: null,
      payload: { id: r.id, version: 2, status: "answered", blocking: true },
    });
    await waitFor(
      () => !$$("request").some((c) => c.dataset.requestId === "req-blocking"),
      "reloaded",
    );
  });

  it("only shows requests when the link has no approvals scope", async () => {
    await openInbox(h, ["read"]);
    expect($$("option")).toHaveLength(0);
    expect($$("no-approvals-scope").length).toBeGreaterThan(0);
    expect($$("mark-read")).toHaveLength(0);
  });
});
