import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMobileHarness, renderMobile } from "./mobile-helpers.tsx";

describe("Home screen", () => {
  it("lists every project with its waiting-on-you count and the active one in the header", async () => {
    const h = await createMobileHarness();
    renderMobile("/", h);
    await screen.findByRole("heading", { name: "Projects" });
    const cards = await screen.findAllByTestId("m-project-card");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute("data-project-id", "proj_pharma");
    expect(cards[0]).toHaveAttribute("data-active", "true");
    expect(screen.getAllByTestId("m-waiting").map((b) => b.textContent)).toEqual([
      "2 waiting on you",
      "0 waiting on you",
      "1 waiting on you",
    ]);
    expect(screen.getByTestId("m-active-project")).toHaveTextContent("PharmaWatch");
    expect(screen.getByTestId("m-inbox-badge")).toHaveTextContent("1");
    expect(screen.getByTestId("m-blocking-banner")).toHaveTextContent(/1 request blocks work/);
    expect(cards[0]).toHaveTextContent("CHF 10.00 of CHF 50.00");
  });

  it("tapping a project makes it the active one, persisted per install", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/", h);
    const names = await screen.findAllByTestId("m-project-name");
    await user.click(names[2] as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("m-active-project")).toHaveTextContent("Space game"),
    );
    expect(h.env.storage.get("forerunner.mobile.test.activeProject")).toBe("proj_game");
    await user.click(screen.getAllByTestId("m-project-remote")[1] as HTMLElement);
    await screen.findByRole("heading", { name: "Remote control" });
    expect(screen.getByTestId("m-remote-active")).toHaveTextContent("Supplement site");
  });

  it("shows the sync badge as polling (live stream off in tests) and reacts to the feed", async () => {
    const h = await createMobileHarness();
    renderMobile("/", h);
    await screen.findAllByTestId("m-project-card");
    await waitFor(() => expect(screen.getByTestId("m-sync")).toHaveTextContent("polling"));
  });
});
