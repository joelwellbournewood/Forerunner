import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  $,
  $$,
  click,
  createHarness,
  delayingFetch,
  type Harness,
  must,
  openFromLink,
  remoteCommandPost,
  type,
  waitFor,
} from "./harness.tsx";

const REMOTE = ["read", "write:inbox", "write:approvals", "write:remote"];

describe("quick chat", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("relays a message to the PC as a chat remote command and shows the reply", async () => {
    await openFromLink(h, { scopes: REMOTE, route: "/chat" });
    // Enabled once the presence check saw the desktop device; the input is usable, the send
    // button waits for text.
    await waitFor(() => $("chat-disabled") === null, "enabled");
    expect((must("chat-input") as HTMLInputElement).disabled).toBe(false);
    expect((must("chat-send") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toMatch(/PharmaWatch/);
    await type(must("chat-input") as HTMLInputElement, "What is next?");
    await click(must("chat-send"));
    await waitFor(() => $("chat-you") !== null, "sent");
    const call = h.fake.calls("/remote/commands").find((c) => c.method === "POST");
    expect(call?.body).toEqual({
      target: "pc",
      command: "chat",
      params: { projectId: "proj-1", text: "What is next?" },
    });
    expect(call?.headers["x-device-signature"]).toBeTruthy();
    await waitFor(() => must("chat-agent").dataset.status === "done", "reply");
    expect(must("chat-agent").textContent).toMatch(/Echo: What is next\?/);
    expect((must("chat-input") as HTMLInputElement).value).toBe("");
  });

  it("shows a reply the feed announced before the send response arrived (live mode)", async () => {
    // Regression: the fake's PC answers within ~25 ms, so when the POST response is slow both
    // `remote_command.changed` events reach the page before it knows the command id. In live
    // mode nothing polls; the reply has to be caught up by the page itself.
    await openFromLink(h, {
      scopes: REMOTE,
      route: "/chat",
      fetchImpl: delayingFetch(remoteCommandPost(), 200),
    });
    await waitFor(() => must("feed-mode").textContent === "live", "live");
    await waitFor(() => $("chat-disabled") === null, "enabled");
    await type(must("chat-input") as HTMLInputElement, "Still there?");
    await click(must("chat-send"));
    await waitFor(() => $("chat-agent") !== null, "entry");
    // The command was done long before the entry appeared, and the feed never left live mode.
    expect(h.fake.state.commands[0]?.status).toBe("done");
    expect(must("feed-mode").textContent).toBe("live");
    await waitFor(() => must("chat-agent").dataset.status === "done", "reply", {
      timeoutMs: 3000,
    });
    expect(must("chat-agent").textContent).toMatch(/Echo: Still there\?/);
    expect(must("feed-mode").textContent).toBe("live");
  });

  it("is disabled with an explanation when no PC is online", async () => {
    await h.close();
    h = await createHarness({ pcOnline: false });
    await openFromLink(h, { scopes: REMOTE, route: "/chat" });
    await waitFor(
      () => ($("chat-disabled")?.textContent ?? "").includes("No PC is online"),
      "reason",
    );
    expect((must("chat-send") as HTMLButtonElement).disabled).toBe(true);
    expect((must("chat-input") as HTMLInputElement).disabled).toBe(true);
    expect(h.fake.calls("/remote/commands").filter((c) => c.method === "POST")).toHaveLength(0);
    // The PC comes online (a session starts on it): the next presence check enables chat.
    h.fake.state.sessions.push({
      id: "s1",
      agentId: "agent-pm",
      agentName: "Alice's PM",
      projectId: "proj-1",
      trigger: "manual",
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      budgetCap: { usdMicro: 0, chfMicro: 0 },
      spent: { usdMicro: 0, chfMicro: 0 },
      stepCap: 100,
      steps: 1,
      currentTask: null,
      summary: "",
      handoff: null,
      runner: "pc",
    });
    h.fake.emit({
      type: "session.changed",
      humanId: "h1",
      projectId: "proj-1",
      sessionId: "s1",
      payload: { id: "s1" },
    });
    await waitFor(() => $("chat-disabled") === null, "enabled after session");
  });

  it("is disabled with an explanation when the link has no remote scope", async () => {
    await openFromLink(h, { route: "/chat" });
    await waitFor(() => $("chat-disabled") !== null, "disabled");
    expect(must("chat-disabled").textContent).toMatch(/without remote control/);
    expect((must("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a service that does not relay chat and a PC that fails", async () => {
    await h.close();
    h = await createHarness({ supportsChat: false });
    await openFromLink(h, { scopes: REMOTE, route: "/chat" });
    await waitFor(() => $("chat-disabled") === null, "enabled");
    await type(must("chat-input") as HTMLInputElement, "hello");
    await click(must("chat-send"));
    await waitFor(() => $("chat-error") !== null, "error");
    expect(must("chat-error").textContent).toMatch(/does not relay chat yet/);
    expect($$("chat-you")).toHaveLength(0);
  });

  it("shows a failed answer from the PC", async () => {
    await h.close();
    h = await createHarness({ autoReply: null });
    await openFromLink(h, { scopes: REMOTE, route: "/chat" });
    await waitFor(() => $("chat-disabled") === null, "enabled");
    await type(must("chat-input") as HTMLInputElement, "hello");
    await click(must("chat-send"));
    await waitFor(() => must("chat-agent").dataset.status === "picked_up", "picked up");
    expect(must("chat-agent").textContent).toMatch(/answering/);
    const id = h.fake.state.commands[0]?.id as string;
    h.fake.failCommand(id, { error: "The conversation agent is over budget." });
    await waitFor(() => must("chat-agent").dataset.status === "failed", "failed");
    expect(must("chat-agent").textContent).toMatch(/over budget/);
  });
});
