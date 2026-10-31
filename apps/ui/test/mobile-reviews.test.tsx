import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HumanRequestView } from "../src/api/state-client.ts";
import { MobileController } from "../src/mobile/store.tsx";
import { createMobileHarness, postedCalls, renderMobile } from "./mobile-helpers.tsx";

/**
 * The Reviews screen (spec R.5; ADR 0080): reachable from the nav; the project's critic
 * reviews with their PR and findings; a comment goes to `POST /reviews/:id/comment`; approve
 * and reject go to `/reviews/:id/approve|reject`, signed, answering the task's open approval
 * request at its version; a high-risk request asks the biometric prompt first and the flag
 * is inside the signature (ADR 0045), a cancelled prompt sends nothing.
 */
const HIGH_DEPLOY: HumanRequestView = {
  id: "req_deploy",
  projectId: "proj_pharma",
  projectName: "PharmaWatch",
  taskId: "task_2",
  sessionId: null,
  kind: "approval",
  why: "Merge the deploy pipeline PR? It deploys to production.",
  steps: [],
  options: ["Approve", "Reject"],
  blocking: true,
  risk: "high",
  changeCard: null,
  status: "open",
  answer: null,
  createdAt: "2026-10-20T05:45:00.000Z",
  version: 3,
};

const reviewCard = (id: string) =>
  screen.getAllByTestId("m-review").find((el) => el.getAttribute("data-review-id") === id) as
    | HTMLElement
    | undefined;

describe("Reviews screen", () => {
  it("is in the nav and lists the project's reviews with the PR and the critic's findings", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/", h);
    const nav = await screen.findByTestId("m-nav");
    await user.click(within(nav).getByRole("link", { name: "Reviews" }));
    await screen.findByRole("heading", { name: "Reviews" });
    await waitFor(() => expect(screen.getAllByTestId("m-review")).toHaveLength(2));
    const parser = reviewCard("rev_parser");
    if (!parser) throw new Error("no parser review");
    expect(parser).toHaveTextContent("Feed parser");
    expect(parser).toHaveTextContent("grade 82");
    expect(within(parser).getByTestId("m-review-pr")).toHaveAttribute(
      "href",
      "https://git.example.test/pharmawatch/pull/12",
    );
    const findings = within(parser).getAllByTestId("m-finding");
    expect(findings.map((f) => f.getAttribute("data-severity"))).toEqual(["minor", "major"]);
    expect(findings[1]).toHaveTextContent("Network errors are swallowed without a retry.");
    expect(findings[1]).toHaveTextContent("Needed: Retry twice, then report.");
    // The merge request on the same task waits on the human: the card says so.
    expect(within(parser).getByTestId("m-review-waiting")).toHaveTextContent(
      "Merge the feed parser PR?",
    );
    await user.selectOptions(screen.getByTestId("m-reviews-project"), "proj_game");
    await waitFor(() => expect(screen.getAllByTestId("m-review")).toHaveLength(1));
    expect(reviewCard("rev_game")).toHaveTextContent("Trading loop");
  });

  it("sends a comment to the responsible agent, signed", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/reviews", h);
    await waitFor(() => expect(reviewCard("rev_parser")).toBeDefined());
    const card = reviewCard("rev_parser") as HTMLElement;
    await user.type(within(card).getByTestId("m-review-comment"), "Use the recorded EMA feed.");
    await user.click(within(card).getByTestId("m-review-send-comment"));
    expect(await within(card).findByTestId("m-review-outcome")).toHaveTextContent(
      "Comment sent to the agent.",
    );
    expect(postedCalls(h, "/reviews/rev_parser/comment")).toEqual([
      expect.objectContaining({
        signed: true,
        biometric: false,
        body: { body: "Use the recorded EMA feed." },
      }),
    ]);
    expect(h.service.state.reviewMessages).toEqual([
      { reviewId: "rev_parser", kind: "comment", body: "Use the recorded EMA feed." },
    ]);
  });

  it("approves with a comment and answers the task's open approval at its version", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/reviews", h);
    await waitFor(() =>
      expect(within(reviewCard("rev_parser") as HTMLElement).getByTestId("m-review-waiting")),
    );
    const card = reviewCard("rev_parser") as HTMLElement;
    expect(within(card).queryByTestId("m-review-high")).toBeNull();
    await user.type(within(card).getByTestId("m-review-comment"), "Fine, add the fixture next.");
    await user.click(within(card).getByTestId("m-review-approve"));
    await waitFor(() =>
      expect(screen.getByTestId("m-review-outcome")).toHaveTextContent(
        "Approved; the waiting session continues.",
      ),
    );
    expect(postedCalls(h, "/reviews/rev_parser/approve")).toEqual([
      expect.objectContaining({
        signed: true,
        biometric: false,
        body: { body: "Fine, add the fixture next.", requestVersion: 1 },
      }),
    ]);
    // U-027: answered with the card's own Approve button, as a click in the Inbox would (the
    // former `{ decision, comment, reviewId }` object was read as no answer); the comment goes
    // to the agent with the verdict.
    expect(h.service.state.requests.find((r) => r.id === "req_merge")).toMatchObject({
      status: "answered",
      answer: "Approve",
    });
    expect(h.service.state.reviewMessages).toContainEqual({
      reviewId: "rev_parser",
      kind: "approve",
      body: "Fine, add the fixture next.",
    });
    expect(screen.queryByTestId("m-biometric-dialog")).toBeNull();
  });

  it("a high-risk verdict asks the biometric prompt first; cancel sends nothing, confirm signs the flag", async () => {
    const h = await createMobileHarness();
    h.service.state.requests.unshift(structuredClone(HIGH_DEPLOY));
    const user = userEvent.setup();
    renderMobile("/reviews", h);
    await waitFor(() =>
      expect(within(reviewCard("rev_deploy") as HTMLElement).getByTestId("m-review-high")),
    );
    const card = reviewCard("rev_deploy") as HTMLElement;
    expect(card).toHaveTextContent("revise");

    await user.click(within(card).getByTestId("m-review-reject"));
    const dialog = await screen.findByTestId("m-biometric-dialog");
    expect(dialog).toHaveTextContent("Reject: Deploy pipeline");
    await user.click(screen.getByTestId("m-biometric-cancel"));
    expect(await within(card).findByTestId("m-review-error")).toHaveTextContent(
      "needs a biometric confirmation",
    );
    expect(postedCalls(h, "/reviews/rev_deploy/reject")).toHaveLength(0);

    await user.type(
      within(card).getByTestId("m-review-comment"),
      "No production deploy without a gate.",
    );
    await user.click(within(card).getByTestId("m-review-reject"));
    await screen.findByTestId("m-biometric-dialog");
    await user.click(screen.getByTestId("m-biometric-confirm"));
    await waitFor(() =>
      expect(within(card).getByTestId("m-review-outcome")).toHaveTextContent("Rejected"),
    );
    expect(postedCalls(h, "/reviews/rev_deploy/reject")).toEqual([
      expect.objectContaining({
        signed: true,
        biometric: true,
        body: { body: "No production deploy without a gate.", requestVersion: 3 },
      }),
    ]);
    expect(h.service.state.requests.find((r) => r.id === "req_deploy")).toMatchObject({
      status: "answered",
      answer: "Reject",
    });
  });

  it("reads the inbox afresh: a high-risk approval filed after the screen loaded still asks the prompt", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/reviews", h);
    await waitFor(() => expect(reviewCard("rev_deploy")).toBeDefined());
    const card = reviewCard("rev_deploy") as HTMLElement;
    expect(within(card).queryByTestId("m-review-high")).toBeNull();
    // The critic's approval lands after the phone's last inbox load.
    h.service.state.requests.unshift(structuredClone(HIGH_DEPLOY));
    await user.click(within(card).getByTestId("m-review-approve"));
    await screen.findByTestId("m-biometric-dialog");
    expect(postedCalls(h, "/reviews/rev_deploy/approve")).toHaveLength(0);
    await user.click(screen.getByTestId("m-biometric-confirm"));
    await waitFor(() =>
      expect(within(card).getByTestId("m-review-outcome")).toHaveTextContent("Approved"),
    );
    expect(postedCalls(h, "/reviews/rev_deploy/approve")).toEqual([
      expect.objectContaining({ signed: true, biometric: true, body: { requestVersion: 3 } }),
    ]);
    expect(h.service.state.requests.find((r) => r.id === "req_deploy")?.status).toBe("answered");
  });

  it("a biometric_required answer for a request the phone could not see prompts and resends once", async () => {
    const h = await createMobileHarness();
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    let inboxDown = false;
    h.env.fetch = async (input, init) => {
      if (inboxDown && /\/inbox/.test(String(input))) throw new Error("inbox unreachable");
      return realFetch(input, init);
    };
    h.controller = new MobileController(h.env);
    const user = userEvent.setup();
    renderMobile("/reviews", h);
    await waitFor(() => expect(reviewCard("rev_deploy")).toBeDefined());
    inboxDown = true;
    h.service.state.requests.unshift(structuredClone(HIGH_DEPLOY));
    const card = reviewCard("rev_deploy") as HTMLElement;
    await user.click(within(card).getByTestId("m-review-reject"));
    // The first post went without the flag and was refused; the prompt runs, then one resend.
    await screen.findByTestId("m-biometric-dialog");
    expect(postedCalls(h, "/reviews/rev_deploy/reject")).toEqual([
      expect.objectContaining({ biometric: false }),
    ]);
    await user.click(screen.getByTestId("m-biometric-confirm"));
    await waitFor(() =>
      expect(within(card).getByTestId("m-review-outcome")).toHaveTextContent("Rejected"),
    );
    expect(postedCalls(h, "/reviews/rev_deploy/reject").map((c) => c.biometric)).toEqual([
      false,
      true,
    ]);
    expect(h.service.state.requests.find((r) => r.id === "req_deploy")).toMatchObject({
      status: "answered",
      answer: "Reject",
    });
    // The refused first post told the agent nothing; the resend did, once.
    expect(h.service.state.reviewMessages.filter((m) => m.reviewId === "rev_deploy")).toEqual([
      { reviewId: "rev_deploy", kind: "reject", body: "" },
    ]);
  });

  it("the service refuses a high-risk verdict without the biometric flag", async () => {
    const h = await createMobileHarness();
    h.service.state.requests.unshift(structuredClone(HIGH_DEPLOY));
    await h.controller.bootstrap();
    await expect(
      h.controller.api.reviewVerdict("rev_deploy", "approve", { requestVersion: 3 }),
    ).rejects.toMatchObject({ code: "biometric_required", status: 403 });
    expect(h.service.state.requests.find((r) => r.id === "req_deploy")?.status).toBe("open");
    h.controller.close();
  });
});
