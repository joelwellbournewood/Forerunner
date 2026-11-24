import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * l4-chat-final, run L4 (L4h-left-4; design section 5 rule 6: no raw states, no type names). The
 * Inbox's Updates list showed the stored message type as a word under the lapse Update: "... ask
 * again if you still want it.\n\nwarning\nAlice · just now" (the review of l4-selftasks-carried,
 * walk E). The tone is a colour dot named in words for a screen reader, as the session log does.
 */
describe("l4-chat-final, run L4: an Update says no raw type (L4h-left-4)", () => {
  it("a warning Update shows its sentence and a named dot, never the word 'warning'", async () => {
    const harness = createHarness();
    const first = harness.daemon.state.messages[0];
    if (!first) throw new Error("fixture changed");
    first.type = "warning";
    first.body =
      "The change you asked for was not made: the monthly cap (CHF 150.00 to CHF 400.00). Its card closed after 10 minutes without your yes; ask again if you still want it.";
    renderApp("/inbox", harness);
    const message = (await screen.findAllByTestId("message"))[0] as HTMLElement;
    expect(message).toHaveTextContent(
      "The change you asked for was not made: the monthly cap (CHF 150.00 to CHF 400.00).",
    );
    expect(message.textContent ?? "").not.toMatch(/\bwarning\b/i);
    const dot = within(message).getByTestId("message-tone");
    expect(dot).toHaveAccessibleName("Worth a look");
    expect(dot).toHaveTextContent("");
  });
});
