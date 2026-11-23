import { screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatClock, formatTime, setPersonZone } from "../src/lib/time.ts";
import { renderApp } from "./helpers.tsx";

/**
 * l4-cred-screens, run L4 (L4-creds-20, live check 4's LC-C26): the session page and the
 * Sessions row wrote times in the computer's zone beside the daemon's sentences in the person's
 * zone (GET /me's `timezone`). With the computer on UTC and the person in Zurich, every clock on
 * the screen is Zurich's. The fake's person is in Europe/Zurich; sess_1 started at 19:00 UTC on
 * 19 Oct 2026 (21:00 in Zurich, summer time).
 */
const TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
  setPersonZone(null);
});

describe("l4-cred-screens, run L4: times in the person's zone (L4-creds-20)", () => {
  it("formatClock says the person's day across midnight", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    // 23:30 UTC on the 17th is 00:30 on the 18th in Zurich: another day there.
    expect(formatClock("2026-11-17T23:30:00Z", now, "Europe/Zurich")).toBe("18 Nov, 00:30");
    expect(formatClock("2026-11-17T10:19:00Z", now, "Europe/Zurich")).toBe("11:19");
    expect(formatTime("2026-11-17T10:19:00Z", "Europe/Zurich")).toBe("11:19");
    // An unknown name keeps the computer's zone.
    expect(formatTime("2026-11-17T10:19:00Z", "Mars/Olympus")).toBe("10:19");
  });

  it("the session page's header and log rows, and the Sessions row, read the person's clock", async () => {
    renderApp("/sessions/sess_1");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Atlas · session at 21:00",
      ),
    );
    const rows = await screen.findAllByTestId("event-row");
    // No row reads the computer's 19:xx beside the daemon's sentences in Zurich's time.
    for (const row of rows) expect(row.textContent ?? "").not.toMatch(/\b19:\d\d\b/);
  });

  it("the Sessions list's row reads the person's clock", async () => {
    renderApp("/projects/proj_atlas/sessions");
    const lines = await screen.findAllByTestId("session-row-line");
    const first = lines[0] as HTMLElement;
    await waitFor(() => expect(within(first).getByText(/21:00/)).toBeInTheDocument());
    expect(first.textContent).not.toMatch(/\b19:00\b/);
  });
});
