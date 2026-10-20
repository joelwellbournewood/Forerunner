import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMobileHarness, postedCalls, renderMobile } from "./mobile-helpers.tsx";

describe("Inbox screen", () => {
  it("lists approvals first (blocking, then newest) and posts a signed option answer", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findByRole("heading", { name: "Inbox" });
    const requests = await screen.findAllByTestId("m-request");
    expect(requests.map((r) => r.getAttribute("data-request-id"))).toEqual([
      "req_merge",
      "req_cap",
      "req_name",
    ]);
    expect(requests[0]).toHaveAttribute("data-blocking", "true");
    expect(screen.getByTestId("m-blocking-count")).toHaveTextContent("1 blocking");
    await user.click(within(requests[0] as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(2));
    const call = postedCalls(h, "/requests/req_merge/answer")[0];
    expect(call).toMatchObject({
      signed: true,
      biometric: false,
      body: { version: 1, answer: "Approve" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("m-blocking-count")).toHaveTextContent("0 blocking"),
    );
    expect(screen.queryByTestId("m-inbox-badge")).toBeNull();
  });

  it("asks for biometrics on a high-risk request; confirm sends the flag, cancel sends nothing", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    const requests = await screen.findAllByTestId("m-request");
    const high = requests[1] as HTMLElement;
    expect(high).toHaveAttribute("data-risk", "high");
    expect(within(high).getByTestId("m-request-high")).toHaveTextContent(/fingerprint or face/);
    expect(within(high).getByTestId("m-request-card")).toHaveTextContent("From CHF 150 to CHF 250");
    await user.click(within(high).getByRole("button", { name: "Confirm" }));
    const dialog = await screen.findByTestId("m-biometric-dialog");
    expect(dialog).toHaveTextContent(/Simulated biometric prompt/);
    await user.click(screen.getByTestId("m-biometric-cancel"));
    await waitFor(() =>
      expect(within(high).getByTestId("m-request-error")).toHaveTextContent(
        /biometric confirmation/,
      ),
    );
    expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(0);
    await user.click(within(high).getByRole("button", { name: "Confirm" }));
    await screen.findByTestId("m-biometric-dialog");
    await user.click(screen.getByTestId("m-biometric-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(2));
    const call = postedCalls(h, "/requests/req_cap/answer")[0];
    expect(call).toMatchObject({
      signed: true,
      biometric: true,
      body: { version: 1, answer: "Confirm" },
    });
    expect(h.service.state.requests.find((r) => r.id === "req_cap")?.status).toBe("answered");
  });

  it("sends a free-text answer and marks a message read with a signed receipt", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    const requests = await screen.findAllByTestId("m-request");
    const decision = requests[2] as HTMLElement;
    await user.type(within(decision).getByTestId("m-free-text"), "Call it Harbour");
    await user.click(within(decision).getByTestId("m-send-free-text"));
    await waitFor(() => expect(postedCalls(h, "/requests/req_name/answer")).toHaveLength(1));
    expect(postedCalls(h, "/requests/req_name/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Call it Harbour",
    });
    const messages = screen.getAllByTestId("m-message");
    expect(messages[0]).toHaveAttribute("data-read", "false");
    await user.click(screen.getByTestId("m-mark-read"));
    await waitFor(() =>
      expect(screen.getAllByTestId("m-message")[0]).toHaveAttribute("data-read", "true"),
    );
    expect(postedCalls(h, "/messages/msg_handoff/receipt")[0]).toMatchObject({
      signed: true,
      body: { state: "read" },
    });
  });

  it("reloads when the live change feed reports a new request, with an in-app notice", async () => {
    const h = await createMobileHarness({ env: { live: true } });
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    await h.service.app.request("http://state.test/__test/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.service.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "req_new",
        why: "Deploy to staging?",
        blocking: true,
        risk: "medium",
      }),
    });
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(4), {
      timeout: 3000,
    });
    expect(screen.getAllByTestId("m-request")[0]).toHaveAttribute("data-request-id", "req_new");
    await waitFor(() =>
      expect(screen.getByTestId("m-push-notice")).toHaveTextContent(/Approval needed/),
    );
  });
});
