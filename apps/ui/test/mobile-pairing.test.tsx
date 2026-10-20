import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildPairingLink, parsePairingPayload } from "../src/mobile/pairing.ts";
import { HUMAN_J } from "./fake-state-service.ts";
import { createMobileHarness, renderMobile, SERVICE_URL } from "./mobile-helpers.tsx";

describe("pairing payloads", () => {
  it("accepts the fr:// link, a web link, the service's qr JSON and a bare code", () => {
    const link = buildPairingLink("https://state.example.test", "abcd-2345", "human_j");
    expect(link).toBe("fr://pair?u=https%3A%2F%2Fstate.example.test&c=ABCD2345&h=human_j");
    expect(parsePairingPayload(link)).toEqual({
      code: "ABCD2345",
      serviceUrl: "https://state.example.test",
      humanId: "human_j",
    });
    expect(
      parsePairingPayload("https://desk.example.test/pair?u=http://10.0.0.5:8788&c=QRST2345"),
    ).toEqual({
      code: "QRST2345",
      serviceUrl: "http://10.0.0.5:8788",
      humanId: null,
    });
    expect(
      parsePairingPayload('{"v":1,"code":"abcd2345","humanId":"h","url":"https://s.test/"}'),
    ).toEqual({
      code: "ABCD2345",
      serviceUrl: "https://s.test",
      humanId: "h",
    });
    expect(parsePairingPayload(" abcd 2345 ")).toEqual({
      code: "ABCD2345",
      serviceUrl: null,
      humanId: null,
    });
    expect(parsePairingPayload("fr://other?c=ABCD2345")).toBeNull();
    expect(parsePairingPayload("hello world")).toBeNull();
    expect(
      parsePairingPayload("fr://pair?u=javascript:alert(1)&c=ABCD2345")?.serviceUrl,
    ).toBeNull();
  });
});

describe("Pairing screen", () => {
  it("pairs with a typed code, stores the token in the secure store and lands on Home", async () => {
    const h = await createMobileHarness({ paired: false });
    const user = userEvent.setup();
    renderMobile("/", h);
    // Unpaired: redirected to the pairing screen; no scanner outside the shell.
    await screen.findByRole("heading", { name: "Pair this phone" });
    expect(screen.getByTestId("m-pair-no-scanner")).toBeInTheDocument();
    expect(screen.queryByTestId("m-nav")).toBeNull();
    const { code } = h.service.startPairing(HUMAN_J.id, "phone");
    expect(screen.getByTestId("m-pair-url")).toHaveValue(SERVICE_URL);
    await user.clear(screen.getByTestId("m-pair-code"));
    await user.type(screen.getByTestId("m-pair-code"), code.toLowerCase());
    await user.clear(screen.getByTestId("m-pair-name"));
    await user.type(screen.getByTestId("m-pair-name"), "J's Pixel");
    await user.click(screen.getByTestId("m-pair-submit"));
    await screen.findByRole("heading", { name: "Projects" });
    expect(screen.getByTestId("m-nav")).toBeInTheDocument();
    const device = h.service.state.devices[0];
    expect(device).toMatchObject({
      name: "J's Pixel",
      platform: "web",
      kind: "phone",
      ownerHumanId: HUMAN_J.id,
    });
    expect(device?.publicKey).toBe(await h.env.signer.publicKey());
    expect(await h.env.secure.get("session-token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The token never lands in plain storage, the fake's log or its recorded calls.
    const token = (await h.env.secure.get("session-token")) as string;
    const plain = h.env.storage.get("forerunner.mobile.test.session") ?? "";
    expect(plain).not.toContain(token);
    expect(
      JSON.stringify(h.service.state.log) + JSON.stringify(h.service.state.calls),
    ).not.toContain(token);
    expect(h.controller.state.session?.humanName).toBe("J");
  });

  it("shows the service's refusal for a wrong code and validates the inputs", async () => {
    const h = await createMobileHarness({ paired: false });
    const user = userEvent.setup();
    renderMobile("/pair", h);
    await screen.findByRole("heading", { name: "Pair this phone" });
    await user.type(screen.getByTestId("m-pair-code"), "abc");
    await user.click(screen.getByTestId("m-pair-submit"));
    expect(await screen.findByTestId("m-pair-error")).toHaveTextContent(/8 characters/);
    await user.clear(screen.getByTestId("m-pair-code"));
    await user.type(screen.getByTestId("m-pair-code"), "ZZZZ9999");
    await user.click(screen.getByTestId("m-pair-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("m-pair-error")).toHaveTextContent(/Pairing failed/),
    );
    expect(h.service.state.devices).toHaveLength(0);
  });

  it("pre-fills the code and URL from a scanned QR or a deep link", async () => {
    const link = buildPairingLink("http://state.test", "QRCD2345");
    const h = await createMobileHarness({
      paired: false,
      env: {
        scan: async () => link,
        deepLink: { current: async () => null, listen: () => () => {} },
      },
    });
    const user = userEvent.setup();
    renderMobile("/pair", h);
    await screen.findByRole("heading", { name: "Pair this phone" });
    await user.click(screen.getByTestId("m-pair-scan"));
    await waitFor(() => expect(screen.getByTestId("m-pair-code")).toHaveValue("QRCD2345"));
    expect(screen.getByTestId("m-pair-url")).toHaveValue("http://state.test");
    h.controller.offerPairing("fr://pair?u=http://other.test&c=DEEP2345");
    await waitFor(() => expect(screen.getByTestId("m-pair-code")).toHaveValue("DEEP2345"));
    expect(screen.getByTestId("m-pair-url")).toHaveValue("http://other.test");
  });
});
