import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { memoryViews, sortLessons } from "../src/pages/MemoryPage.tsx";
import { AGENTS, LESSONS, ME } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Memory page", () => {
  it("orders the views own agent, peers, critic, shared and sorts pinned lessons first", () => {
    const views = memoryViews(
      [
        {
          scope: "agent_private",
          ownerAgentId: "agent_alice",
          label: "Alice's agent",
          active: 2,
          pinned: 1,
        },
        { scope: "critic", ownerAgentId: null, label: "Critic", active: 1, pinned: 0 },
        { scope: "shared", ownerAgentId: null, label: "Shared", active: 1, pinned: 1 },
      ],
      { agents: AGENTS, me: ME },
    );
    expect(views.map((v) => [v.label, v.foreign])).toEqual([
      ["Alice's agent", false],
      ["Bob's agent", true],
      ["Critic", false],
      ["Shared lessons", false],
    ]);
    expect(sortLessons(LESSONS.slice(0, 2)).map((l) => l.id)).toEqual(["les_1", "les_2"]);
    expect(sortLessons([...LESSONS.slice(0, 2)].reverse()).map((l) => l.id)).toEqual([
      "les_1",
      "les_2",
    ]);
  });

  it("shows the own agent's lessons, searches, and switches to the critic and shared views", async () => {
    const user = userEvent.setup();
    renderApp("/memory");
    const views = await screen.findByTestId("memory-views");
    await waitFor(() => expect(within(views).getAllByRole("tab")).toHaveLength(4));
    expect(within(views).getByTestId("memory-view-agent-agent_alice")).toHaveTextContent(
      "2 · 1 pinned",
    );
    const lessons = await screen.findAllByTestId("lesson");
    expect(lessons).toHaveLength(2);
    expect(lessons[0]).toHaveAttribute("data-pinned", "true");
    await user.type(screen.getByTestId("memory-search"), "estimat");
    await waitFor(() => expect(screen.getAllByTestId("lesson")).toHaveLength(1));
    expect(screen.getByTestId("lesson")).toHaveTextContent("acceptance criteria");
    await user.clear(screen.getByTestId("memory-search"));
    await user.click(within(views).getByTestId("memory-view-critic"));
    await waitFor(() =>
      expect(screen.getByTestId("lessons")).toHaveAttribute("data-scope", "critic"),
    );
    await waitFor(() => expect(screen.getByTestId("lesson")).toHaveTextContent("Repeated finding"));
    await user.click(within(views).getByTestId("memory-view-shared"));
    await waitFor(() =>
      expect(screen.getByTestId("lessons")).toHaveAttribute("data-scope", "shared"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("lesson")).toHaveTextContent("Keep PRs under 400"),
    );
  });

  it("lists a peer's agent but says its private memory is not readable", async () => {
    const user = userEvent.setup();
    renderApp("/memory");
    const views = await screen.findByTestId("memory-views");
    await waitFor(() => expect(within(views).getAllByRole("tab")).toHaveLength(4));
    await user.click(within(views).getByTestId("memory-view-agent-agent_bob"));
    expect(await screen.findByTestId("memory-not-readable")).toHaveTextContent(
      "not readable by this install",
    );
    expect(screen.queryByTestId("error-banner")).not.toBeInTheDocument();
  });

  it("edits, pins and deletes a lesson through the daemon", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/memory", harness);
    const lessons = await screen.findAllByTestId("lesson");
    const second = lessons[1];
    if (!second) throw new Error("no lesson");
    expect(second).toHaveAttribute("data-lesson-id", "les_2");
    await user.click(within(second).getByTestId("lesson-edit"));
    const textInput = within(second).getByTestId("lesson-text-input");
    await user.clear(textInput);
    await user.type(textInput, "Ask for the acceptance criteria before estimating, every time.");
    await user.clear(within(second).getByTestId("lesson-tags-input"));
    await user.type(within(second).getByTestId("lesson-tags-input"), "estimates, briefs, process");
    await user.click(within(second).getByTestId("lesson-save"));
    await waitFor(() => expect(postedCalls(harness, "/memory/lessons/les_2")).toHaveLength(1));
    expect(postedCalls(harness, "/memory/lessons/les_2")[0]).toMatchObject({
      method: "PUT",
      body: {
        text: "Ask for the acceptance criteria before estimating, every time.",
        tags: ["estimates", "briefs", "process"],
      },
    });
    await waitFor(() =>
      expect(within(second).getByTestId("lesson-text")).toHaveTextContent("every time."),
    );
    await user.click(within(second).getByTestId("lesson-pin"));
    await waitFor(() => expect(postedCalls(harness, "/memory/lessons/les_2/pin")).toHaveLength(1));
    expect(postedCalls(harness, "/memory/lessons/les_2/pin")[0]?.body).toEqual({ pinned: true });
    await waitFor(() => expect(second).toHaveAttribute("data-pinned", "true"));
    await user.click(within(second).getByTestId("lesson-delete"));
    await user.click(within(second).getByTestId("lesson-delete-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("lesson")).toHaveLength(1));
    expect(postedCalls(harness, "/memory/lessons/les_2").some((c) => c.method === "DELETE")).toBe(
      true,
    );
    expect(harness.daemon.state.lessons.some((l) => l.id === "les_2")).toBe(false);
  });

  it("shows consolidation proposals and runs the job on demand", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/memory", harness);
    const section = await screen.findByTestId("consolidation");
    const proposal = await within(section).findByTestId("consolidation-proposal");
    expect(proposal).toHaveTextContent("Merge les_7 into les_1");
    expect(proposal).toHaveTextContent("1 merged, 1 contradiction, 1 retired");
    await user.click(within(section).getByTestId("consolidation-run"));
    await waitFor(() => expect(postedCalls(harness, "/memory/consolidation/run")).toHaveLength(1));
    expect(await screen.findByTestId("consolidation-note")).toHaveTextContent("nothing to merge");
    await waitFor(() =>
      expect(within(section).getAllByTestId("consolidation-proposal")).toHaveLength(2),
    );
  });

  it("degrades to a visible route-missing state on a daemon without memory routes", async () => {
    renderApp("/memory", createHarness({ missingRoutes: ["/memory"] }));
    // Both the lessons and the consolidation section say which route is missing: nothing
    // on the page disappears silently.
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("route-missing")
          .map((m) => m.dataset.route)
          .sort(),
      ).toEqual(["consolidation", "memory"]),
    );
    const lessons = screen
      .getAllByTestId("route-missing")
      .find((m) => m.dataset.route === "memory");
    expect(lessons).toHaveTextContent("Route not available on this daemon");
    expect(lessons).toHaveTextContent("GET /memory");
  });

  it("keeps the lessons and names the missing route when only consolidation is absent", async () => {
    renderApp("/memory", createHarness({ missingRoutes: ["/memory/consolidation"] }));
    const section = await screen.findByTestId("consolidation");
    const missing = await within(section).findByTestId("route-missing");
    expect(missing).toHaveAttribute("data-route", "consolidation");
    expect(missing).toHaveTextContent("GET /memory/consolidation");
    expect(within(section).queryByTestId("consolidation-run")).not.toBeInTheDocument();
    expect(await screen.findAllByTestId("lesson")).toHaveLength(2);
    expect(screen.getAllByTestId("route-missing")).toHaveLength(1);
  });
});
