import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMobileHarness, renderMobile } from "./mobile-helpers.tsx";

describe("Settings screen", () => {
  it("shows the device, sync status, push stand-in and where the key and token live", async () => {
    const h = await createMobileHarness();
    renderMobile("/settings", h);
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect(screen.getByTestId("m-sync-status")).toHaveTextContent("polling"));
    expect(screen.getByTestId("m-human")).toHaveTextContent("J");
    expect(screen.getByTestId("m-device-id")).toHaveTextContent(/^dev_/);
    expect(screen.getByTestId("m-service-url")).toHaveTextContent("http://state.test");
    expect(screen.getByTestId("m-scopes")).toHaveTextContent(
      "read, write:inbox, write:queue, write:remote, write:approvals",
    );
    expect(screen.getByTestId("m-outbox")).toHaveTextContent("0");
    await waitFor(() =>
      expect(screen.getByTestId("m-push-mode")).toHaveTextContent(/polling — FCM not configured/),
    );
    expect(screen.getByTestId("m-secure-store")).toHaveTextContent(
      /memory storage \(insecure fallback/,
    );
    expect(screen.getByTestId("m-biometric")).toHaveTextContent(/simulated prompt/);
    // The token is never rendered anywhere on the page.
    const token = (await h.env.secure.get("session-token")) as string;
    expect(document.body.textContent ?? "").not.toContain(token);
  });

  it("renames the device locally and saves quiet hours", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/settings", h);
    await screen.findByRole("heading", { name: "Settings" });
    await user.clear(screen.getByTestId("m-device-name"));
    await user.type(screen.getByTestId("m-device-name"), "Pixel of J");
    await user.click(screen.getByTestId("m-device-name-save"));
    await waitFor(() => expect(h.controller.state.session?.deviceName).toBe("Pixel of J"));
    expect(h.env.storage.get("forerunner.mobile.test.session")).toContain("Pixel of J");
    await user.type(screen.getByTestId("m-quiet-from"), "22:00");
    await user.type(screen.getByTestId("m-quiet-to"), "07:00");
    await user.click(screen.getByTestId("m-quiet-save"));
    await waitFor(() =>
      expect(h.controller.state.quietHours).toEqual({ from: "22:00", to: "07:00" }),
    );
  });

  it("forgets the device: key and token gone, back to pairing; the desktop revokes the row", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/settings", h);
    await screen.findByRole("heading", { name: "Settings" });
    await user.click(screen.getByTestId("m-forget"));
    await user.click(screen.getByTestId("m-forget-confirm"));
    await screen.findByRole("heading", { name: "Pair this phone" });
    expect(await h.env.secure.get("session-token")).toBeNull();
    expect(h.env.storage.get("forerunner.mobile.test.session")).toBeNull();
    await expect(h.env.signer.sign(new Uint8Array([1]))).rejects.toThrow(/forgotten/);
    expect(h.service.state.devices[0]?.revoked).toBe(false);
  });

  it("a revoked device is dropped to pairing on its next request with a notice", async () => {
    const h = await createMobileHarness();
    renderMobile("/settings", h);
    await screen.findByRole("heading", { name: "Settings" });
    const device = h.service.state.devices[0];
    if (!device) throw new Error("not paired");
    await h.service.app.request(`http://state.test/devices/${device.id}/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.service.adminToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    await screen.findByRole("heading", { name: "Pair this phone" }, { timeout: 4000 });
    await waitFor(() => expect(h.controller.state.notice).toMatch(/revoked or its token expired/));
  });
});
