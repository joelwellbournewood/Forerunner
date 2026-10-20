import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MobileChangeCard } from "../src/mobile/change-card.ts";
import type { ChangeEntry } from "../src/mobile/change-log.ts";
import { createMobileHarness, postedCalls, renderMobile } from "./mobile-helpers.tsx";

const card = (over: Partial<MobileChangeCard> = {}): MobileChangeCard => ({
  command: "project.switch",
  what: "the active project",
  oldValue: "PharmaWatch",
  newValue: "Space game",
  scope: "global",
  scopeLabel: "everything",
  duration: "until reverted",
  impact: { risk: "low" },
  undoHint: "Tap Undo in the change log.",
  sentence: "Switched the active project to Space game. Undo.",
  projectId: "proj_game",
  projectName: "Space game",
  usesActiveProject: false,
  expiresAt: null,
  reversible: true,
  ...over,
});

const entry = (over: Partial<ChangeEntry> & { id: string; at: string }): ChangeEntry => ({
  wordsUsed: "switch to the game",
  source: "chat",
  plan: [{ name: "project.switch", params: { project: "proj_game" } }],
  card: card(),
  remoteCommandId: "cmd_x",
  status: "done",
  result: null,
  undoPlan: [{ name: "project.switch", params: { back: true } }],
  undoneBy: null,
  undoOf: null,
  ...over,
});

describe("Change log screen (spec Q.11)", () => {
  it("lists entries newest first, offers Undo only while reversible, and marks queued ones", async () => {
    const h = await createMobileHarness();
    h.controller.changeLog.add(
      entry({ id: "e_done", at: "2026-10-20T08:00:00.000Z", status: "done" }),
    );
    h.controller.changeLog.add(
      entry({
        id: "e_queued",
        at: "2026-10-20T09:00:00.000Z",
        status: "sent",
        remoteCommandId: null,
        wordsUsed: "give it 5 francs",
        card: card({ sentence: "Raised the session budget to CHF 5. Undo." }),
      }),
    );
    h.controller.changeLog.add(
      entry({ id: "e_undone", at: "2026-10-20T07:00:00.000Z", status: "undone", undoneBy: "x" }),
    );
    h.controller.changeLog.add(
      entry({ id: "e_failed", at: "2026-10-20T06:00:00.000Z", status: "failed" }),
    );
    h.controller.changeLog.add(
      entry({
        id: "e_stop",
        at: "2026-10-20T05:00:00.000Z",
        status: "done",
        plan: [{ name: "session.stop", params: { scope: "all" } }],
        undoPlan: null,
        card: card({ sentence: "Stopped every running session.", reversible: false }),
      }),
    );
    renderMobile("/changes", h);
    await screen.findByRole("heading", { name: "Change log" });
    const rows = await screen.findAllByTestId("m-change-entry");
    expect(rows.map((r) => r.getAttribute("data-entry-id"))).toEqual([
      "e_queued",
      "e_done",
      "e_undone",
      "e_failed",
      "e_stop",
    ]);
    const byId = (id: string) =>
      rows.find((r) => r.getAttribute("data-entry-id") === id) as HTMLElement;
    expect(within(byId("e_queued")).getByTestId("m-change-undo")).toBeInTheDocument();
    expect(within(byId("e_done")).getByTestId("m-change-undo")).toBeInTheDocument();
    expect(within(byId("e_undone")).queryByTestId("m-change-undo")).toBeNull();
    expect(within(byId("e_failed")).queryByTestId("m-change-undo")).toBeNull();
    expect(within(byId("e_stop")).queryByTestId("m-change-undo")).toBeNull();
    expect(byId("e_queued")).toHaveTextContent("Queued offline");
    expect(byId("e_done")).toHaveTextContent("Remote command cmd_x");
    expect(byId("e_done")).not.toHaveTextContent("Queued offline");
    expect(byId("e_done")).toHaveTextContent("J said: “switch to the game”");
    expect(byId("e_done")).toHaveTextContent("Commands: project.switch · PharmaWatch → Space game");
    expect(byId("e_undone")).toHaveAttribute("data-status", "undone");
    expect(screen.queryByTestId("m-no-changes")).toBeNull();
  });

  it("Undo sends the inverse plan as a new entry and the original becomes undone", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    h.controller.changeLog.add(entry({ id: "e_done", at: "2026-10-20T08:00:00.000Z" }));
    renderMobile("/changes", h);
    const row = await screen.findByTestId("m-change-entry");
    await user.click(within(row).getByTestId("m-change-undo"));
    await waitFor(() => expect(postedCalls(h, "/remote/commands")).toHaveLength(1));
    expect(postedCalls(h, "/remote/commands")[0]?.body).toMatchObject({
      target: "pc",
      command: "start",
      params: {
        kind: "plan",
        undoOf: "e_done",
        wordsUsed: "undo: switch to the game",
        plan: [{ name: "project.switch", params: { back: true } }],
      },
    });
    await waitFor(() => expect(screen.getAllByTestId("m-change-entry")).toHaveLength(2));
    const rows = screen.getAllByTestId("m-change-entry");
    expect(rows[0]).toHaveTextContent("undo");
    expect(rows[0]?.getAttribute("data-entry-id")).not.toBe("e_done");
    expect(within(rows[0] as HTMLElement).queryByTestId("m-change-undo")).toBeNull();
    expect(rows[1]).toHaveAttribute("data-entry-id", "e_done");
    expect(rows[1]).toHaveAttribute("data-status", "undone");
    expect(within(rows[1] as HTMLElement).queryByTestId("m-change-undo")).toBeNull();
    expect(screen.queryByTestId("m-change-undo")).toBeNull();
  });

  it("says when nothing was changed from this phone", async () => {
    const h = await createMobileHarness();
    renderMobile("/changes", h);
    expect(await screen.findByTestId("m-no-changes")).toHaveTextContent(
      /No changes from this phone/,
    );
  });
});
