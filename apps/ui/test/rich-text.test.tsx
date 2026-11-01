import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RichText } from "../src/components/RichText.tsx";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * Model text shows as formatting, never as raw markdown (design §3.7, §3.9, §5 rule 6). The live
 * run of 2026-11-01: both chat answers showed raw `**…**`, and session lines read "**Summary**:".
 * A safe subset is rendered (bold, italics, inline code, bullet and numbered lists, line breaks);
 * raw HTML is never rendered.
 */
const REPLY = [
  "**Summary**: the plan has *4 tasks*; __Publish__ waits on _your_ answers.",
  "- Build the quote page",
  "- Test the pick logic",
  "1. Answer the questions",
  "2. Press Approve and start",
  "Run `node --check app.js` to check it. <img src=x onerror=alert(1)>",
].join("\n");

describe("model text in the chat and the session log", () => {
  it("a chat reply with markdown shows bold, italics, lists and code, and no asterisks", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.nextChatReply = REPLY;
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "what is the plan?");
    await user.click(screen.getByTestId("chat-send"));
    const agent = await screen.findByTestId("chat-agent");
    await waitFor(() => expect(agent).toHaveAttribute("data-streaming", "false"));
    // What the person reads: the words without the markers.
    expect(agent.textContent).not.toMatch(/\*\*|__|(^|\s)\*\w/);
    expect(agent).toHaveTextContent(
      "Summary: the plan has 4 tasks; Publish waits on your answers.",
    );
    expect(within(agent).getByText("Summary").tagName).toBe("STRONG");
    expect(within(agent).getByText("Publish").tagName).toBe("STRONG");
    expect(within(agent).getByText("4 tasks").tagName).toBe("EM");
    expect(within(agent).getByText("your").tagName).toBe("EM");
    const bullets = within(agent).getAllByRole("list");
    expect(bullets).toHaveLength(2);
    expect(
      within(bullets[0] as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Build the quote page", "Test the pick logic"]);
    expect(bullets[1]?.tagName).toBe("OL");
    expect(within(agent).getByText("node --check app.js").tagName).toBe("CODE");
    // Raw HTML is text, never an element.
    expect(agent.querySelector("img")).toBeNull();
    expect(agent).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("a session line with a specialist's markdown reads as text with the heading in bold", async () => {
    const harness = createHarness();
    harness.daemon.state.events.push({
      id: "ev_md",
      sessionId: "sess_1",
      seq: 6,
      type: "task.finished",
      text: "Finished task: done (CHF 0.07). **Summary**: wrote index.html and *style.css*.",
      payload: {},
      cost: { usdMicro: 0, chfMicro: 0 },
      at: "2026-10-19T19:10:00.000Z",
      level: "info",
    });
    renderApp("/sessions/sess_1", harness);
    const rows = await screen.findAllByTestId("event-row");
    const row = rows.find((r) => r.getAttribute("data-seq") === "6") as HTMLElement;
    expect(row).toBeDefined();
    expect(row.textContent).not.toContain("**");
    expect(row).toHaveTextContent(
      "Finished task: done (CHF 0.07). Summary: wrote index.html and style.css.",
    );
    expect(within(row).getByText("Summary").tagName).toBe("STRONG");
  });

  it("plain text comes out as it went in; snake_case, 2 * 3 * 4 and a lone asterisk stay", () => {
    const plain = "Two lines\nof plain text: read_file and 2 * 3 * 4, a * star.";
    const { container } = render(<RichText text={plain} testId="rt" />);
    expect(container.querySelector("[data-testid=rt]")?.textContent).toBe(plain);
    expect(container.querySelector("strong, em, code, ul, ol")).toBeNull();
  });

  it("a heading is a bold line and a rule goes; a link shows its text and address", () => {
    const { container } = render(
      <RichText
        text={"## What I did\n---\nSee [the guide](https://example.test/guide)."}
        testId="rt"
      />,
    );
    const box = container.querySelector("[data-testid=rt]") as HTMLElement;
    expect(box.textContent).toBe("What I did\nSee the guide (https://example.test/guide).");
    expect(within(box).getByText("What I did").tagName).toBe("STRONG");
    expect(box.querySelector("a")).toBeNull();
  });
});
