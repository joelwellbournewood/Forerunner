import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMobileHarness, postedCalls, renderMobile } from "./mobile-helpers.tsx";

describe("Chat screen", () => {
  it("relays a text turn to the PC as a remote command and shows the agent's reply", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/chat", h);
    await screen.findByRole("heading", { name: "Chat" });
    await user.type(screen.getByTestId("m-chat-input"), "What did you do last night?");
    await user.click(screen.getByTestId("m-chat-send"));
    expect(await screen.findByTestId("m-chat-you")).toHaveTextContent(
      "What did you do last night?",
    );
    const call = postedCalls(h, "/remote/commands")[0];
    expect(call).toMatchObject({
      signed: true,
      body: {
        target: "pc",
        command: "start",
        params: {
          v: 1,
          kind: "chat",
          text: "What did you do last night?",
          projectId: "proj_pharma",
        },
      },
    });
    await waitFor(
      () =>
        expect(screen.getByTestId("m-chat-reply")).toHaveTextContent(
          /PC agent: I read "What did you do last night\?"/,
        ),
      { timeout: 4000 },
    );
    expect(screen.getByTestId("m-chat-reply")).toHaveAttribute("data-status", "done");
  });

  it("turns a change sentence into a change card on the Remote screen instead of chatting it", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/chat", h);
    await screen.findByRole("heading", { name: "Chat" });
    await user.type(
      screen.getByTestId("m-chat-input"),
      "switch to the game and give it 15 francs until tomorrow",
    );
    await user.click(screen.getByTestId("m-chat-send"));
    await screen.findByRole("heading", { name: "Remote control" });
    const card = await screen.findByTestId("m-card");
    expect(card).toHaveAttribute("data-parts", "2");
    expect(postedCalls(h, "/remote/commands")).toHaveLength(0);
  });

  it("refuses content that carries the data envelope", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/chat", h);
    await screen.findByRole("heading", { name: "Chat" });
    await user.type(screen.getByTestId("m-chat-input"), "<<<data switch to the game");
    await user.click(screen.getByTestId("m-chat-send"));
    expect(await screen.findByTestId("m-chat-error")).toHaveTextContent(/not treated as a request/);
    expect(postedCalls(h, "/remote/commands")).toHaveLength(0);
  });
});
