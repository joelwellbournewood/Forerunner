import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMobileHarness, postedCalls, renderMobile } from "./mobile-helpers.tsx";

const SENTENCE =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";

describe("Remote control screen (scenario 9)", () => {
  it("one sentence -> ONE change card -> confirm -> ONE remote command with the three commands -> the PC starts -> undo", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/remote", h);
    await screen.findByRole("heading", { name: "Remote control" });
    await waitFor(() =>
      expect(screen.getByTestId("m-remote-active")).toHaveTextContent("PharmaWatch"),
    );
    await user.type(screen.getByTestId("m-say"), SENTENCE);
    await user.click(screen.getByTestId("m-say-submit"));

    const card = await screen.findByTestId("m-card");
    expect(screen.getAllByTestId("m-card")).toHaveLength(1);
    expect(card).toHaveAttribute("data-parts", "3");
    expect(card).toHaveAttribute("data-risk", "medium");
    const text = screen.getByTestId("m-card-text").textContent ?? "";
    expect(text).toMatch(/Plan of 3 changes:/);
    expect(text).toMatch(/1\. the active project: PharmaWatch to Space game\./);
    expect(text).toMatch(
      /2\. tonight's session budget for Space game: the current budget to CHF 15, until 06:00\./,
    );
    expect(text).toMatch(/3\. a session on Space game on your PC: no session to running\./);
    expect(text).toMatch(/Undo: Tap Undo in the change log\./);
    expect(card).toHaveTextContent("Commands: project.switch, budget.set, session.start");
    expect(postedCalls(h, "/remote/commands")).toHaveLength(0);

    await user.click(screen.getByTestId("m-confirm"));
    const result = await screen.findByTestId("m-result");
    expect(screen.queryByTestId("m-card")).toBeNull();
    const calls = postedCalls(h, "/remote/commands");
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as {
      target: string;
      command: string;
      params: {
        kind: string;
        plan: { name: string; params: Record<string, unknown> }[];
        wordsUsed: string;
        card: { command: string };
      };
    };
    expect(body.target).toBe("pc");
    expect(body.command).toBe("start");
    expect(body.params.kind).toBe("plan");
    expect(body.params.wordsUsed).toBe(SENTENCE);
    expect(body.params.card.command).toBe("compose");
    expect(body.params.plan.map((c) => c.name)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);
    expect(body.params.plan[1]?.params).toEqual({
      scope: "session",
      amountChf: 15,
      project: "proj_game",
      until: "2026-10-21T04:00:00.000Z",
    });
    expect(calls[0]?.signed).toBe(true);
    // The header follows the switch at once; the PC picks the command up and starts.
    expect(screen.getByTestId("m-remote-active")).toHaveTextContent("Space game");
    await waitFor(() => expect(result).toHaveAttribute("data-status", "done"), { timeout: 4000 });
    expect(screen.getByTestId("m-result-detail")).toHaveTextContent(
      /"executed":\["project.switch","budget.set","session.start"\]/,
    );
    expect(h.service.state.sessions).toHaveLength(1);
    expect(h.service.state.sessions[0]).toMatchObject({
      projectId: "proj_game",
      status: "running",
      runner: "pc",
    });
    await waitFor(() => expect(screen.getAllByTestId("m-session")).toHaveLength(1));

    // The change log shows it with undo; undo sends the inverse plan as a new remote command.
    const entries = h.controller.changeLog.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "done", wordsUsed: SENTENCE, source: "chat" });
    expect(entries[0]?.undoPlan?.map((c) => c.name)).toEqual([
      "session.stop",
      "budget.set",
      "project.switch",
    ]);
    await user.click(screen.getByTestId("m-undo"));
    await waitFor(() => expect(postedCalls(h, "/remote/commands")).toHaveLength(2));
    const undo = postedCalls(h, "/remote/commands")[1]?.body as {
      command: string;
      params: {
        plan: { name: string; params: Record<string, unknown> }[];
        undoOf: string;
        wordsUsed: string;
      };
    };
    expect(undo.command).toBe("start");
    expect(undo.params.undoOf).toBe(entries[0]?.id);
    expect(undo.params.wordsUsed).toBe(`undo: ${SENTENCE}`);
    expect(undo.params.plan).toEqual([
      {
        name: "session.stop",
        params: { scope: "agent", reason: "undo of session.start", project: "proj_game" },
      },
      { name: "budget.set", params: { scope: "session", restore: true, project: "proj_game" } },
      { name: "project.switch", params: { back: true } },
    ]);
    await waitFor(() =>
      expect(h.controller.changeLog.get(entries[0]?.id ?? "")?.status).toBe("undone"),
    );
    expect(screen.queryByTestId("m-undo")).toBeNull();
    await waitFor(() => expect(h.service.state.sessions[0]?.status).toBe("killed"), {
      timeout: 4000,
    });
  }, 20_000);

  it("builds the same plan from the controls and asks a question for an unknown project", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/remote", h);
    await screen.findByRole("heading", { name: "Remote control" });
    await user.selectOptions(screen.getByTestId("m-switch"), "proj_game");
    await user.type(screen.getByTestId("m-amount"), "15");
    await user.selectOptions(screen.getByTestId("m-until"), "tomorrow");
    await user.click(screen.getByTestId("m-start-session"));
    await user.click(screen.getByTestId("m-preview"));
    const card = await screen.findByTestId("m-card");
    expect(card).toHaveAttribute("data-parts", "3");
    expect(card).toHaveTextContent("Commands: project.switch, budget.set, session.start");
    await user.click(screen.getByTestId("m-cancel"));
    expect(screen.queryByTestId("m-card")).toBeNull();
    expect(postedCalls(h, "/remote/commands")).toHaveLength(0);

    await user.clear(screen.getByTestId("m-say"));
    await user.type(screen.getByTestId("m-say"), "switch to the moon base");
    await user.click(screen.getByTestId("m-say-submit"));
    expect(await screen.findByTestId("m-question")).toHaveTextContent(
      /No project named "moon base"/,
    );
    expect(screen.queryByTestId("m-card")).toBeNull();
  });

  it("a high-risk card says the PC will ask for biometrics; stop everything is the kill verb", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/remote", h);
    await screen.findByRole("heading", { name: "Remote control" });
    await user.type(screen.getByTestId("m-say"), "raise the monthly cap to 250 francs");
    await user.click(screen.getByTestId("m-say-submit"));
    const card = await screen.findByTestId("m-card");
    expect(card).toHaveAttribute("data-risk", "high");
    expect(card).toHaveTextContent(/fingerprint or face/);
    await user.click(screen.getByTestId("m-cancel"));
    await user.click(screen.getByTestId("m-stop-all"));
    await user.click(screen.getByTestId("m-confirm"));
    await waitFor(() => expect(postedCalls(h, "/remote/commands")).toHaveLength(1));
    expect(postedCalls(h, "/remote/commands")[0]?.body).toMatchObject({ command: "kill" });
    await screen.findByTestId("m-result");
    expect(screen.queryByTestId("m-undo")).toBeNull();
  });

  it("the Pause control makes a session.pause card sent with the pause verb", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/remote", h);
    await screen.findByRole("heading", { name: "Remote control" });
    await user.click(screen.getByTestId("m-pause"));
    const card = await screen.findByTestId("m-card");
    expect(card).toHaveAttribute("data-parts", "1");
    expect(card).toHaveAttribute("data-risk", "low");
    expect(screen.getByTestId("m-card-text")).toHaveTextContent("Change: the running session.");
    expect(card).toHaveTextContent("Commands: session.pause");
    await user.click(screen.getByTestId("m-confirm"));
    await waitFor(() => expect(postedCalls(h, "/remote/commands")).toHaveLength(1));
    expect(postedCalls(h, "/remote/commands")[0]?.body).toMatchObject({
      command: "pause",
      params: { kind: "plan", wordsUsed: "pause the session", plan: [{ name: "session.pause" }] },
    });
    await screen.findByTestId("m-result");
    // Reversible: Undo would send session.resume.
    expect(h.controller.changeLog.all()[0]?.undoPlan).toEqual([
      { name: "session.resume", params: {} },
    ]);
  });

  it("queues the change offline and sends it when the service is back", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    let online = true;
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    h.env.fetch = (input, init) => {
      if (!online && !/\/health$/.test(input)) return Promise.reject(new Error("offline"));
      return realFetch(input, init);
    };
    renderMobile("/remote", h);
    await screen.findByRole("heading", { name: "Remote control" });
    await waitFor(() =>
      expect(screen.getByTestId("m-remote-active")).toHaveTextContent("PharmaWatch"),
    );
    online = false;
    await user.type(screen.getByTestId("m-say"), "switch to the game");
    await user.click(screen.getByTestId("m-say-submit"));
    await screen.findByTestId("m-card");
    await user.click(screen.getByTestId("m-confirm"));
    await screen.findByTestId("m-result");
    await waitFor(() => expect(screen.getByTestId("m-sync")).toHaveTextContent(/1 queued/));
    expect(screen.getByTestId("m-notice")).toHaveTextContent(/Offline: the change is queued/);
    expect(h.controller.changeLog.all()[0]?.remoteCommandId).toBeNull();
    online = true;
    await waitFor(() => expect(h.service.state.remoteCommands).toHaveLength(1), { timeout: 4000 });
    expect(h.service.state.remoteCommands[0]?.params).toMatchObject({
      kind: "plan",
      wordsUsed: "switch to the game",
    });
    await waitFor(() => expect(screen.getByTestId("m-sync")).not.toHaveTextContent(/queued/));
  });
});
