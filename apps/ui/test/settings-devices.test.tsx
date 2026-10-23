import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { qrModules, qrPath } from "../src/components/QrCode.tsx";
import { formatCountdown } from "../src/lib/clock.ts";
import { parsePairingPayload } from "../src/mobile/pairing.ts";
import {
  DevicesSection,
  formatPairingCode,
  isLoopbackUrl,
  splitDevices,
} from "../src/pages/DevicesSection.tsx";
import { DEVICES, PAIRING } from "./fixtures.ts";
import { createHarness, postedCalls, renderWith } from "./helpers.tsx";

const T0 = Date.parse("2026-10-23T09:00:00.000Z");

/** A stepped clock: the countdown reads it; tests move it with `set`. */
function steppedClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
}

type Stepped = ReturnType<typeof steppedClock>;

/** The section and the fake daemon share one stepped clock (the fake dates the expiry by it). */
function renderDevices(
  options: Parameters<typeof createHarness>[0] = {},
  clock: Stepped = steppedClock(),
) {
  const harness = createHarness({ now: clock.now, ...options });
  const utils = renderWith(<DevicesSection clock={clock} tickMs={10} pollMs={20} />, harness);
  return { ...utils, clock };
}

const activeRows = () =>
  screen.queryAllByTestId("device-row").filter((r) => r.dataset.revoked === "false");

describe("Settings -> Devices (spec R.2)", () => {
  it("helpers: the code reads in two groups, the countdown never goes below zero, revoked rows are split off", () => {
    expect(formatPairingCode("K7QX2MPA")).toBe("K7QX-2MPA");
    expect(formatCountdown(PAIRING.expiresAt, T0)).toBe("10:00");
    expect(formatCountdown(PAIRING.expiresAt, T0 + 9 * 60_000 + 59_500)).toBe("0:01");
    expect(formatCountdown(PAIRING.expiresAt, T0 + 11 * 60_000)).toBe("0:00");
    const { active, revoked } = splitDevices(DEVICES);
    expect(active.map((d) => d.id)).toEqual(["dev_phone", "dev_desktop"]);
    expect(revoked.map((d) => d.id)).toEqual(["dev_web"]);
    // The QR path draws exactly the dark modules of the encoded link.
    const modules = qrModules(PAIRING.link);
    const dark = modules.flat().filter(Boolean).length;
    const drawn = [...qrPath(modules).matchAll(/h(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(drawn).toBe(dark);
  });

  it("starts a pairing: the QR of the fr:// link, the typed code, the service and the expiry counting down", async () => {
    const user = userEvent.setup();
    const r = renderDevices();
    const { daemon, clock } = r;
    await screen.findAllByTestId("device-row");
    expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("pairing-start"));
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAccessibleName("QR code of the pairing link");
    const encoded = encode(PAIRING.link, { ecc: "M", border: 4 });
    expect(Number(qr.dataset.modules)).toBe(encoded.size);
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(qrPath(encoded.data));
    // What the QR carries is what the phone's pairing screen parses.
    const link = screen.getByTestId("pairing-link").textContent ?? "";
    expect(link).toBe(PAIRING.link);
    expect(parsePairingPayload(link)).toEqual({
      code: PAIRING.code,
      serviceUrl: PAIRING.serviceUrl,
      humanId: PAIRING.humanId,
    });
    expect(screen.getByTestId("pairing-code")).toHaveTextContent("K7QX-2MPA");
    expect(screen.getByTestId("pairing-service")).toHaveTextContent(PAIRING.serviceUrl);
    expect(screen.getByTestId("pairing-countdown")).toHaveTextContent("in 10:00");
    expect(postedCalls(r, "/devices/pairing")).toEqual([
      { method: "POST", path: "/devices/pairing", body: { kind: "phone" } },
    ]);
    // A second pairing cannot be started while one is shown.
    expect(screen.getByTestId("pairing-start")).toBeDisabled();

    act(() => clock.set("2026-10-23T09:09:30.000Z"));
    await waitFor(() =>
      expect(screen.getByTestId("pairing-countdown")).toHaveTextContent("in 0:30"),
    );

    act(() => clock.set("2026-10-23T09:10:00.000Z"));
    expect(await screen.findByTestId("pairing-expired")).toBeInTheDocument();
    expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pairing-code")).not.toBeInTheDocument();

    // A new code is one click away; it expires ten minutes from now.
    await user.click(screen.getByTestId("pairing-restart"));
    expect(await screen.findByTestId("qr-code")).toBeInTheDocument();
    expect(screen.getByTestId("pairing-countdown")).toHaveTextContent("in 10:00");
    expect(daemon.state.pairings).toBe(2);
    expect(postedCalls(r, "/devices/pairing")).toHaveLength(2);

    await user.click(screen.getByTestId("pairing-done"));
    expect(screen.queryByTestId("pairing-panel")).not.toBeInTheDocument();
  });

  it("lists the devices with name, kind, paired at and last seen; this device is marked and has no revoke", async () => {
    renderDevices();
    await screen.findAllByTestId("device-row");
    const rows = activeRows();
    expect(rows.map((r) => r.dataset.device)).toEqual(["dev_phone", "dev_desktop"]);
    const [phone, desktop] = rows as [HTMLElement, HTMLElement];
    expect(phone).toHaveTextContent("Alice's Pixel");
    expect(phone).toHaveTextContent("Phone · android");
    expect(phone).toHaveTextContent("20 min ago");
    expect(within(phone).queryByTestId("device-current")).not.toBeInTheDocument();
    expect(within(phone).getByTestId("device-revoke")).toBeInTheDocument();
    expect(within(desktop).getByTestId("device-current")).toHaveTextContent("this device");
    expect(within(desktop).queryByTestId("device-revoke")).not.toBeInTheDocument();
    expect(desktop).toHaveTextContent("Desktop · linux");
    const revoked = screen.getByTestId("devices-revoked");
    expect(revoked).toHaveTextContent("Revoked (1)");
    expect(within(revoked).getByTestId("device-row")).toHaveTextContent("web of human_alice");
    expect(within(revoked).queryByTestId("device-revoke")).not.toBeInTheDocument();
  });

  it("revokes after a confirmation: the route is called, the device leaves the list at once", async () => {
    const user = userEvent.setup();
    const harness = renderDevices();
    await screen.findAllByTestId("device-row");
    const phone = activeRows().find((r) => r.dataset.device === "dev_phone") as HTMLElement;

    // Cancel first: nothing is sent.
    await user.click(within(phone).getByTestId("device-revoke"));
    const dialog = await screen.findByTestId("revoke-dialog");
    expect(dialog).toHaveTextContent("Revoke Alice's Pixel?");
    expect(dialog).toHaveTextContent("immediate");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("revoke-dialog")).not.toBeInTheDocument();
    expect(postedCalls(harness, "/devices/dev_phone/revoke")).toHaveLength(0);

    await user.click(within(phone).getByTestId("device-revoke"));
    await user.click(
      within(await screen.findByTestId("revoke-dialog")).getByTestId("revoke-confirm"),
    );
    await waitFor(() => expect(screen.queryByTestId("revoke-dialog")).not.toBeInTheDocument());
    expect(postedCalls(harness, "/devices/dev_phone/revoke")).toEqual([
      { method: "POST", path: "/devices/dev_phone/revoke", body: {} },
    ]);
    await waitFor(() => expect(activeRows().map((r) => r.dataset.device)).toEqual(["dev_desktop"]));
    expect(screen.getByTestId("devices-note")).toHaveTextContent(
      "Alice's Pixel is revoked; 1 session ended.",
    );
    expect(screen.getByTestId("devices-revoked")).toHaveTextContent("Revoked (2)");
  });

  it("keeps the device and shows the daemon's error when the revocation fails", async () => {
    const user = userEvent.setup();
    const harness = renderDevices({
      failing: {
        "/devices/dev_phone/revoke": {
          status: 503,
          code: "unavailable",
          message: "state service unreachable: fetch failed",
        },
      },
    });
    await screen.findAllByTestId("device-row");
    const phone = activeRows().find((r) => r.dataset.device === "dev_phone") as HTMLElement;
    await user.click(within(phone).getByTestId("device-revoke"));
    const dialog = await screen.findByTestId("revoke-dialog");
    await user.click(within(dialog).getByTestId("revoke-confirm"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("state service unreachable");
    expect(activeRows().map((r) => r.dataset.device)).toEqual(["dev_phone", "dev_desktop"]);
    expect(harness.daemon.state.devices.find((d) => d.id === "dev_phone")?.revoked).toBe(false);
  });

  it("shows the route-missing state on a daemon without the device routes (ADR 0037)", async () => {
    renderDevices({ missingRoutes: ["/devices"] });
    const missing = await screen.findByTestId("route-missing");
    expect(missing).toHaveAttribute("data-route", "devices");
    expect(missing).toHaveTextContent("GET /devices");
    expect(screen.queryByTestId("pairing-start")).not.toBeInTheDocument();
    expect(screen.queryByTestId("device-row")).not.toBeInTheDocument();
  });

  it("names the pairing route when only it is missing, and keeps the list", async () => {
    const user = userEvent.setup();
    renderDevices({ missingRoutes: ["/devices/pairing"] });
    await screen.findAllByTestId("device-row");
    await user.click(screen.getByTestId("pairing-start"));
    const missing = await within(await screen.findByTestId("pairing-error")).findByTestId(
      "route-missing",
    );
    expect(missing).toHaveTextContent("POST /devices/pairing");
    expect(activeRows()).toHaveLength(2);
  });

  it("without a state service: pairing is off with what to configure, and a forced start shows the 503", async () => {
    renderDevices({ pairingAvailable: false });
    await screen.findAllByTestId("device-row");
    expect(screen.getByTestId("pairing-off")).toHaveTextContent("FORERUNNER_STATE_API_URL");
    expect(screen.getByTestId("pairing-start")).toBeDisabled();

    const user = userEvent.setup();
    renderDevices({
      failing: {
        "/devices/pairing": {
          status: 503,
          code: "unavailable",
          message: "the state service admin token is not in the vault",
        },
      },
    });
    const starts = await screen.findAllByTestId("pairing-start");
    await user.click(starts[1] as HTMLElement);
    const error = await screen.findByTestId("pairing-error");
    expect(error).toHaveTextContent("admin token is not in the vault");
    expect(within(error).getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
  it("lists the phone and closes the pairing on its own once the phone completes it", async () => {
    const user = userEvent.setup();
    const r = renderDevices();
    await screen.findAllByTestId("device-row");
    await user.click(screen.getByTestId("pairing-start"));
    expect(await screen.findByTestId("qr-code")).toBeInTheDocument();
    // The phone completes the pairing at the service; the daemon's list now has it.
    r.daemon.state.devices.unshift({
      id: "dev_tablet",
      name: "Alice's tablet",
      platform: "android",
      kind: "phone",
      pairedAt: "2026-10-23T09:02:00.000Z",
      lastSeen: "2026-10-23T09:02:00.000Z",
      revoked: false,
      revokedAt: null,
      current: false,
      version: 1,
    });
    await waitFor(() => expect(screen.queryByTestId("pairing-panel")).not.toBeInTheDocument());
    expect(screen.getByTestId("devices-note")).toHaveTextContent(
      "Alice's tablet is paired and listed below.",
    );
    expect(activeRows().map((row) => row.dataset.device)).toContain("dev_tablet");
    // Nothing was clicked after the start: the list was re-read while the code was live.
    expect(postedCalls(r, "/devices/pairing")).toHaveLength(1);
  });

  it("warns that a phone cannot reach a loopback service URL in the QR", async () => {
    expect(isLoopbackUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8787/")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8787")).toBe(true);
    expect(isLoopbackUrl("https://state.example.test")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.20:8787")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);

    const user = userEvent.setup();
    renderDevices({ pairing: { serviceUrl: "http://localhost:8787" } });
    await screen.findAllByTestId("device-row");
    await user.click(screen.getByTestId("pairing-start"));
    expect(await screen.findByTestId("pairing-loopback")).toHaveTextContent(
      "FORERUNNER_STATE_API_URL",
    );
  });

  it("says so when the daemon revoked in the shared store because the service failed", async () => {
    const user = userEvent.setup();
    renderDevices({ revokeServiceError: "state service unreachable: fetch failed" });
    await screen.findAllByTestId("device-row");
    const phone = activeRows().find((row) => row.dataset.device === "dev_phone") as HTMLElement;
    await user.click(within(phone).getByTestId("device-revoke"));
    await user.click(
      within(await screen.findByTestId("revoke-dialog")).getByTestId("revoke-confirm"),
    );
    expect(await screen.findByTestId("devices-note")).toHaveTextContent(
      "Alice's Pixel is revoked in the shared store (the state service failed: state service unreachable: fetch failed); its next request is refused.",
    );
    await waitFor(() =>
      expect(activeRows().map((row) => row.dataset.device)).toEqual(["dev_desktop"]),
    );
  });
});
