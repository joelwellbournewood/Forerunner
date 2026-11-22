import { describe, expect, it } from "vitest";
import { world } from "./helpers.ts";

/**
 * fixup-l4-cred-engine (review of L4-creds-8; design §3.6, §3.9: the chat's start says what the
 * Start dialog says): a start the dialog refuses is refused with the dialog's sentence first,
 * then the one-wait rule (S-10) says when the person's kept session goes on. Before, a refused
 * key's start in chat answered 'Your session of 10:00 goes on by itself once its Claude
 * credential is back.' (no step to take) while the dialog said 'Nothing can run until you save
 * a new API key in Settings.' with Start off.
 */
const REFUSED = "Nothing can run until you save a new API key in Settings.";
const GOES_ON = "Your session of 10:00 goes on by itself at 15:40.";

describe("l4-cred-engine, run L4: chat's start refuses with the dialog's sentence before the one-wait rule", () => {
  it("both ports answer: the dialog's refusal is said, at the read-back and at the yes, and nothing starts", async () => {
    const w = await world();
    w.ports.startBlocked = async () => REFUSED;
    w.ports.startWaits = async () => GOES_ON;
    await expect(w.executor.plan({ name: "session.start", params: {} }, w.ctx())).rejects.toThrow(
      REFUSED,
    );
    const r = await w.executor.execute({
      name: "session.start",
      params: {},
      ctx: w.ctx({ source: "ui" }),
    });
    expect(r).toMatchObject({ status: "refused" });
    expect(JSON.stringify(r)).toContain(REFUSED);
    expect(JSON.stringify(r)).not.toContain("goes on by itself");
    expect(w.ports.starts).toHaveLength(0);
    await w.store.close();
  });

  it("nothing refuses the start: the kept session's sentence is said with no read-back, and nothing starts", async () => {
    const w = await world();
    w.ports.startBlocked = async () => null;
    w.ports.startWaits = async () => GOES_ON;
    await expect(w.executor.plan({ name: "session.start", params: {} }, w.ctx())).rejects.toThrow(
      GOES_ON,
    );
    expect(w.ports.starts).toHaveLength(0);
    await w.store.close();
  });
});
