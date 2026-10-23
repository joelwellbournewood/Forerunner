import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MobileController } from "../src/mobile/store.tsx";
import { PERSIST_MAX_BYTES } from "../src/mobile/uploads.ts";
import { createMobileHarness, postedCalls, renderMobile, until } from "./mobile-helpers.tsx";

/**
 * The Upload screen (spec R.5; ADR 0080): reachable from the nav, shows the service's size
 * cap, sends the picked file under the name the human gave as signed multipart to
 * `POST /projects/:id/uploads`, shows the progress and the project's uploads; a file over the
 * cap never leaves the phone; offline the file is queued and sent on reconnect, and a resend
 * after a lost answer makes no second copy (the clientId).
 */
const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("Upload screen", () => {
  it("is in the nav, shows the cap, and uploads a renamed file signed to the chosen project", async () => {
    const h = await createMobileHarness({ fake: { uploadMaxBytes: 2 * 1024 * 1024 } });
    const user = userEvent.setup();
    renderMobile("/", h);
    const nav = await screen.findByTestId("m-nav");
    await user.click(within(nav).getByRole("link", { name: "Upload" }));
    await screen.findByRole("heading", { name: "Upload" });
    await waitFor(() =>
      expect(screen.getByTestId("m-upload-cap")).toHaveTextContent("up to 2.0 MB each"),
    );
    await user.selectOptions(screen.getByTestId("m-upload-project"), "proj_game");
    const file = new File([bytesOf("%PDF-1.7 fake spec")], "spec draft.pdf", {
      type: "application/pdf",
    });
    await user.upload(screen.getByTestId("m-upload-file"), file);
    expect(screen.getByTestId("m-upload-kind")).toHaveValue("document");
    const name = screen.getByTestId("m-upload-name");
    expect(name).toHaveValue("spec draft.pdf");
    await user.clear(name);
    await user.type(name, "game-spec.pdf");
    await user.click(screen.getByTestId("m-upload-send"));

    await waitFor(() =>
      expect(screen.getByTestId("m-upload-progress")).toHaveAttribute("data-phase", "stored"),
    );
    const [call] = postedCalls(h, "/projects/proj_game/uploads");
    expect(call).toMatchObject({ signed: true, principal: "device" });
    const stored = h.service.state.uploads;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      projectIds: ["proj_game"],
      name: "game-spec.pdf",
      kind: "document",
      contentType: "application/pdf",
      sizeBytes: file.size,
    });
    expect(new TextDecoder().decode(stored[0]?.bytes)).toBe("%PDF-1.7 fake spec");
    expect(stored[0]?.clientId).toMatch(/^[A-Za-z0-9-]{8,}$/);
    const rows = await screen.findAllByTestId("m-upload-row");
    expect(rows[0]).toHaveTextContent("game-spec.pdf");
    // Nothing of the file is in the phone's storage once it is uploaded.
    expect(h.controller.uploads.size()).toBe(0);
  });

  it("takes a photo through the camera input as kind photo", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/upload", h);
    await screen.findByRole("heading", { name: "Upload" });
    const photo = screen.getByTestId("m-upload-photo");
    expect(photo).toHaveAttribute("accept", "image/*");
    expect(photo).toHaveAttribute("capture", "environment");
    await user.upload(
      photo,
      new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "IMG_1.jpg", { type: "image/jpeg" }),
    );
    expect(screen.getByTestId("m-upload-kind")).toHaveValue("photo");
    await user.click(screen.getByTestId("m-upload-send"));
    await until(() => h.service.state.uploads.length === 1, 3000, "upload");
    expect(h.service.state.uploads[0]).toMatchObject({
      projectIds: ["proj_pharma"],
      kind: "photo",
      name: "IMG_1.jpg",
      sizeBytes: 6,
    });
  });

  it("refuses a file over the service's cap before a byte leaves", async () => {
    const h = await createMobileHarness({ fake: { uploadMaxBytes: 1024 } });
    const user = userEvent.setup();
    renderMobile("/upload", h);
    await waitFor(() =>
      expect(screen.getByTestId("m-upload-cap")).toHaveTextContent("up to 1.0 KB each"),
    );
    await user.upload(
      screen.getByTestId("m-upload-file"),
      new File([new Uint8Array(4096)], "big.bin", { type: "application/octet-stream" }),
    );
    expect(screen.getByTestId("m-upload-too-large")).toHaveTextContent("the limit is 1.0 KB");
    expect(screen.getByTestId("m-upload-send")).toBeDisabled();
    // The controller refuses it too, whatever the screen does.
    await expect(
      h.controller.uploadFile("proj_pharma", {
        name: "big.bin",
        type: "application/octet-stream",
        bytes: new Uint8Array(4096),
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(postedCalls(h, /\/uploads$/)).toHaveLength(0);
    expect(h.service.state.uploads).toHaveLength(0);
  });

  it("queues the file offline and uploads it once on reconnect, even after a lost answer", async () => {
    const h = await createMobileHarness();
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    let mode: "online" | "offline" | "lose-answer" = "online";
    h.env.fetch = async (input, init) => {
      if (mode === "offline") throw new Error("offline");
      const res = await realFetch(input, init);
      // The service stored the file but the answer never reached the phone.
      if (mode === "lose-answer" && /\/uploads$/.test(input)) throw new Error("connection reset");
      return res;
    };
    h.controller = new MobileController(h.env);
    const user = userEvent.setup();
    renderMobile("/upload", h);
    await screen.findByRole("heading", { name: "Upload" });
    await until(() => h.controller.state.projectsLoaded, 3000, "projects");

    mode = "offline";
    await user.upload(
      screen.getByTestId("m-upload-file"),
      new File([bytesOf("meeting notes")], "notes.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByTestId("m-upload-send"));
    await waitFor(() =>
      expect(screen.getByTestId("m-upload-progress")).toHaveAttribute("data-phase", "queued"),
    );
    expect(h.controller.uploads.size()).toBe(1);
    // A small file is kept in browser storage: no memory-only warning.
    expect(screen.queryByTestId("m-upload-memory-only")).toBeNull();
    expect(h.controller.state.outboxPending).toBe(1);
    expect(await screen.findByTestId("m-sync")).toHaveTextContent("1 queued");
    expect(h.service.state.uploads).toHaveLength(0);

    // Back online, but the first answer is lost: the file stays queued, the service has it.
    mode = "lose-answer";
    await h.controller.flushOutbox();
    expect(h.service.state.uploads).toHaveLength(1);
    expect(h.controller.uploads.size()).toBe(1);
    // The resend under the same clientId returns the asset already made: still one copy.
    mode = "online";
    await h.controller.flushOutbox();
    expect(h.controller.uploads.size()).toBe(0);
    expect(h.controller.state.outboxPending).toBe(0);
    expect(h.service.state.uploads).toHaveLength(1);
    expect(h.service.state.uploads[0]).toMatchObject({ name: "notes.txt", kind: "document" });
    const sent = postedCalls(h, "/projects/proj_pharma/uploads");
    expect(sent).toHaveLength(2);
    expect(h.controller.state.notice).toMatch(/Uploaded 1 queued file/);
  });

  it("says so when a queued file is too large to keep on the phone and lives in memory only", async () => {
    const h = await createMobileHarness({ fake: { uploadMaxBytes: 4 * 1024 * 1024 } });
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    let offline = false;
    h.env.fetch = async (input, init) => {
      if (offline) throw new Error("offline");
      return realFetch(input, init);
    };
    h.controller = new MobileController(h.env);
    const user = userEvent.setup();
    renderMobile("/upload", h);
    await waitFor(() =>
      expect(screen.getByTestId("m-upload-cap")).toHaveTextContent("up to 4.0 MB each"),
    );
    offline = true;
    const big = new Uint8Array(PERSIST_MAX_BYTES + 512 * 1024).fill(7);
    await user.upload(
      screen.getByTestId("m-upload-file"),
      new File([big], "scan.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByTestId("m-upload-send"));
    await waitFor(() =>
      expect(screen.getByTestId("m-upload-progress")).toHaveAttribute("data-phase", "queued"),
    );
    expect(screen.getByTestId("m-upload-memory-only")).toHaveTextContent(
      "lost if the app closes",
    );
    expect(h.controller.state.notice).toMatch(/queued in memory only/);
    expect(h.controller.uploads.pending()[0]?.persisted).toBe(false);
    // Still sent once the phone is back, while the app stayed open.
    offline = false;
    await h.controller.flushOutbox();
    expect(h.service.state.uploads).toHaveLength(1);
    expect(h.service.state.uploads[0]?.sizeBytes).toBe(big.byteLength);
  });
});
