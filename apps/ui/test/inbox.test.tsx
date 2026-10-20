import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { sortMessages, sortRequests } from "../src/pages/InboxPage.tsx";
import { MESSAGES, REQUESTS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Inbox", () => {
  it("sorts blocking requests first, then newest; unread messages first", () => {
    expect(sortRequests(REQUESTS).map((r) => r.id)).toEqual(["req_1", "req_2"]);
    expect(sortMessages(MESSAGES).map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });

  it("renders requests blocking first with their options and context", async () => {
    renderApp("/inbox");
    const requests = await screen.findAllByTestId("request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveAttribute("data-blocking", "true");
    expect(requests[0]).toHaveAttribute("data-request-id", "req_1");
    expect(requests[1]).toHaveAttribute("data-blocking", "false");
    const first = within(requests[0] as HTMLElement);
    expect(first.getByText(/Deploy the search preview/)).toBeInTheDocument();
    expect(first.getAllByTestId("option").map((b) => b.textContent)).toEqual([
      "Approve",
      "Reject",
      "Ask me later",
    ]);
    expect(first.getByText("medium risk")).toBeInTheDocument();
    expect(screen.getByTestId("blocking-count")).toHaveTextContent("1 blocking");
  });

  it("posts the chosen option with the request version and drops the request from the list", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const requests = await screen.findAllByTestId("request");
    await user.click(within(requests[0] as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(postedCalls(harness, "/requests/req_1/answer")).toHaveLength(1));
    expect(postedCalls(harness, "/requests/req_1/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Approve",
    });
    await waitFor(() => expect(screen.getAllByTestId("request")).toHaveLength(1));
    expect(screen.getByTestId("blocking-count")).toHaveTextContent("0 blocking");
    expect(screen.queryByTestId("inbox-badge")).not.toBeInTheDocument();
  });

  it("sends a free-text answer", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const requests = await screen.findAllByTestId("request");
    const second = within(requests[1] as HTMLElement);
    await user.type(second.getByTestId("free-text"), "Use dates, please");
    await user.click(second.getByTestId("send-free-text"));
    await waitFor(() => expect(postedCalls(harness, "/requests/req_2/answer")).toHaveLength(1));
    expect(postedCalls(harness, "/requests/req_2/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Use dates, please",
    });
  });

  it("marks a message read", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/inbox", harness);
    const messages = await screen.findAllByTestId("message");
    expect(messages[0]).toHaveAttribute("data-read", "false");
    await user.click(within(messages[0] as HTMLElement).getByTestId("mark-read"));
    await waitFor(() => expect(postedCalls(harness, "/messages/msg_1/read")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getAllByTestId("message")[0]).toHaveAttribute("data-read", "true"),
    );
  });
});
