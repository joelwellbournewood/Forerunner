import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "../src/api/types.ts";
import { ACTIVE_PROJECT_KEY } from "../src/store/AppContext.tsx";
import {
  $,
  click,
  createHarness,
  delayingFetch,
  type Harness,
  must,
  openFromLink,
  remoteCommandPost,
  select,
  waitFor,
} from "./harness.tsx";

const REMOTE = ["read", "write:inbox", "write:approvals", "write:remote"];

/** A session running on the cloud runner: makes the kill switch target `cloud` as well. */
function cloudSession(): SessionView {
  return {
    id: "s-cloud",
    agentId: "agent-pm",
    agentName: "Alice's PM",
    projectId: "proj-1",
    trigger: "schedule",
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
    runner: "cloud",
  };
}

describe("shell", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("always shows the active project and remembers a switch for the tab", async () => {
    await openFromLink(h);
    const sel = must("active-project") as HTMLSelectElement;
    await waitFor(() => sel.options.length === 2, "projects");
    expect(sel.value).toBe("proj-1");
    expect([...sel.options].map((o) => o.textContent)).toEqual(["PharmaWatch", "Space game"]);
    await select(sel, "proj-2");
    expect(sel.value).toBe("proj-2");
    expect(h.storage.get(ACTIVE_PROJECT_KEY)).toBe("proj-2");
    await waitFor(() => must("feed-mode").textContent === "live", "live feed");
  });

  it("kill switch confirms first, then sends the kill command and reports its outcome", async () => {
    await openFromLink(h, { scopes: REMOTE });
    await waitFor(() => !(must("kill-switch") as HTMLButtonElement).disabled, "kill enabled");
    await click(must("kill-switch"));
    await waitFor(() => $("kill-dialog") !== null, "dialog");
    expect(must("kill-dialog").textContent).toMatch(/every session stops/);
    await click(must("kill-dialog").querySelector("button:not([data-testid])") as HTMLElement);
    // The first non-testid button is the × close; nothing was sent.
    expect(h.fake.calls("/remote/commands").filter((c) => c.method === "POST")).toHaveLength(0);
    await click(must("kill-switch"));
    await waitFor(() => $("kill-confirm") !== null, "dialog again");
    await click(must("kill-confirm"));
    await waitFor(() => $("kill-status") !== null, "status");
    const call = h.fake.calls("/remote/commands").find((c) => c.method === "POST");
    expect(call?.body).toEqual({ target: "pc", command: "kill", params: { scope: "all" } });
    expect(call?.headers["x-device-signature"]).toBeTruthy();
    await waitFor(() => (must("kill-status").textContent ?? "").includes("pc done"), "done");
  });

  it("a kill that reaches the PC but not the cloud keeps the PC's status next to the cloud failure", async () => {
    await h.close();
    h = await createHarness({ rejectCommandsFor: "cloud" });
    h.fake.state.sessions.push(cloudSession());
    await openFromLink(h, { scopes: REMOTE });
    await waitFor(() => !(must("kill-switch") as HTMLButtonElement).disabled, "kill enabled");
    await click(must("kill-switch"));
    await waitFor(() => $("kill-confirm") !== null, "dialog");
    expect(must("kill-dialog").textContent).toMatch(/and the cloud runner/);
    await click(must("kill-confirm"));
    await waitFor(() => $("kill-status") !== null, "status");
    const posts = h.fake.calls("/remote/commands").filter((c) => c.method === "POST");
    expect(posts.map((c) => (c.body as { target: string }).target).sort()).toEqual(["cloud", "pc"]);
    // The PC command was accepted: its pick-up and outcome keep arriving.
    await waitFor(() => (must("kill-status").textContent ?? "").includes("pc done"), "pc done");
    // The cloud refusal is shown next to it, in plain words, and does not hide the PC's status.
    expect(must("kill-status").textContent).toMatch(
      /Not sent to cloud: the cloud runner cannot be reached/,
    );
    expect($("kill-error")).toBeNull();
  });

  it("a kill whose second target answers slowly still shows the PC's outcome in live mode", async () => {
    // Regression: the fake's PC picks the kill up and finishes it within ~25 ms while the
    // cloud POST is still in flight, so both `remote_command.changed` events reach the page
    // before the status banner (and its subscription) exists. In live mode nothing polls;
    // the outcome has to be caught up by the page itself.
    await h.close();
    h = await createHarness({ rejectCommandsFor: "cloud" });
    h.fake.state.sessions.push(cloudSession());
    await openFromLink(h, {
      scopes: REMOTE,
      fetchImpl: delayingFetch(remoteCommandPost('"target":"cloud"'), 300),
    });
    await waitFor(() => must("feed-mode").textContent === "live", "live");
    await waitFor(() => !(must("kill-switch") as HTMLButtonElement).disabled, "kill enabled");
    await click(must("kill-switch"));
    await waitFor(() => $("kill-confirm") !== null, "dialog");
    await click(must("kill-confirm"));
    await waitFor(() => $("kill-status") !== null, "status");
    // The PC was done long before the banner appeared, and the feed never left live mode.
    expect(h.fake.state.commands.find((c) => c.target === "pc")?.status).toBe("done");
    expect(must("feed-mode").textContent).toBe("live");
    await waitFor(() => (must("kill-status").textContent ?? "").includes("pc done"), "pc done", {
      timeoutMs: 3000,
    });
    expect(must("feed-mode").textContent).toBe("live");
    expect(must("kill-status").textContent).toMatch(/Not sent to cloud/);
  });

  it("kill switch reaches the cloud runner when no PC is online", async () => {
    await h.close();
    h = await createHarness({ pcOnline: false });
    h.fake.state.sessions.push(cloudSession());
    await openFromLink(h, { scopes: REMOTE });
    await waitFor(() => !(must("kill-switch") as HTMLButtonElement).disabled, "kill enabled");
    expect((must("kill-switch") as HTMLButtonElement).title).toBe(
      "Stop every session on the cloud runner",
    );
    await click(must("kill-switch"));
    await waitFor(() => $("kill-confirm") !== null, "dialog");
    expect(must("kill-dialog").textContent).toMatch(/kill command to the cloud runner:/);
    expect(must("kill-dialog").textContent).not.toMatch(/your PC/);
    await click(must("kill-confirm"));
    await waitFor(() => $("kill-status") !== null, "status");
    // Only the runner that is there gets the command: nothing is queued for an offline PC.
    const posts = h.fake.calls("/remote/commands").filter((c) => c.method === "POST");
    expect(posts.map((c) => (c.body as { target: string }).target)).toEqual(["cloud"]);
    expect(must("kill-status").textContent).toMatch(/cloud pending/);
    expect($("kill-failure")).toBeNull();
  });

  it("kill switch is disabled without remote scope or without a PC", async () => {
    await openFromLink(h);
    await waitFor(() => must("feed-mode").textContent === "live", "live");
    const button = must("kill-switch") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/without remote control/);
    await h.close();
    h = await createHarness({ pcOnline: false });
    await openFromLink(h, { scopes: REMOTE });
    await waitFor(() => must("feed-mode").textContent === "live", "live");
    await waitFor(
      () => (must("kill-switch") as HTMLButtonElement).title.includes("No PC"),
      "no pc",
    );
    expect((must("kill-switch") as HTMLButtonElement).title).toMatch(/or cloud runner/);
    expect((must("kill-switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
