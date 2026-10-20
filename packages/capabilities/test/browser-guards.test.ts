import { readFileSync } from "node:fs";
import { isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { AutoApprove, type AutonomyLevel, MemoryAudit } from "@forerunner/runtime";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import {
  approvalPortFromRuntime,
  classifyClick,
  classifySecretFill,
  classifySubmit,
  classifyTyping,
  describeFromHtml,
  FakeBrowserApprovals,
  GuardEnforcer,
  type GuardKind,
  guardVerdict,
  HumanRequestApprovalPort,
  isOneShot,
} from "../src/browser/guards.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "browser", name), "utf8");
const login = fixture("login.html");
const checkout = fixture("checkout.html");
const signup = fixture("signup.html");

const LEVELS: AutonomyLevel[] = [0, 1, 2, 3, 4];

describe("guard classification", () => {
  it("password and one-time-code fields are credential fields at every autonomy level", () => {
    expect(classifyTyping(describeFromHtml(login, "input[type=password]"))).toEqual(["credential"]);
    expect(classifyTyping(describeFromHtml(login, "#otp"))).toEqual(["credential"]);
    expect(classifyTyping(describeFromHtml(login, "#username"))).toEqual([]);
    for (const level of LEVELS) {
      const v = guardVerdict(["credential"], level);
      expect(v.needsApproval, `level ${level}`).toBe(true);
      expect(v.actionClass).toBe("credential");
      expect(v.risk).toBe("high");
    }
  });

  it("payment fields and purchase buttons always need approval", () => {
    expect(classifyTyping(describeFromHtml(checkout, "#cardnumber"))).toEqual(["payment"]);
    expect(classifyTyping(describeFromHtml(checkout, "#cvc"))).toEqual(["payment"]);
    expect(classifyTyping(describeFromHtml(checkout, "#expiry"))).toEqual(["payment"]);
    // the cardholder's name is personal data, not the payment instrument
    expect(classifyTyping(describeFromHtml(checkout, "#cardname"))).toEqual([]);
    expect(classifyTyping(describeFromHtml(checkout, "#code"))).toEqual([]);
    expect(classifyClick(describeFromHtml(checkout, "#place-order"))).toEqual(["purchase"]);
    expect(classifyClick(describeFromHtml(checkout, "#buy-now"))).toEqual(["purchase"]);
    expect(classifyClick(describeFromHtml(checkout, "#apply-coupon"))).toEqual([]);
    expect(classifyClick(describeFromHtml(checkout, "#continue"))).toEqual([]);
    for (const level of LEVELS) {
      expect(guardVerdict(["purchase"], level).needsApproval, `level ${level}`).toBe(true);
      expect(guardVerdict(["payment"], level).actionClass).toBe("financial");
    }
  });

  it("personal data submission and accepting terms need approval below autonomy 4 only", () => {
    const create = describeFromHtml(signup, "#create");
    expect(classifyClick(create)).toEqual(["personal_submit"]);
    expect(classifyClick(describeFromHtml(signup, "#terms"))).toEqual(["accept_terms"]);
    expect(classifyClick(describeFromHtml(signup, "#subscribe-topic"))).toEqual([]);
    const ticked = signup.replace('type="checkbox"', 'type="checkbox" checked');
    expect(classifyClick(describeFromHtml(ticked, "#create")).sort()).toEqual([
      "accept_terms",
      "personal_submit",
    ]);
    expect(classifyClick(describeFromHtml(ticked, "#terms"))).toEqual([]);
    expect(classifySubmit(describeFromHtml(signup, "#email").form)).toEqual(["personal_submit"]);
    for (const level of LEVELS) {
      const v = guardVerdict(["personal_submit", "accept_terms"], level);
      expect(v.needsApproval, `level ${level}`).toBe(level < 4);
      expect(v.actionClass).toBe("external_send");
    }
  });

  it("plain actions need nothing", () => {
    expect(classifyClick(describeFromHtml(login, "#search-button"))).toEqual([]);
    expect(classifyTyping(describeFromHtml(login, "input[name=q]"))).toEqual([]);
    const v = guardVerdict([], 0);
    expect(v.needsApproval).toBe(false);
    expect(v.kinds).toEqual([]);
  });

  it("orders kinds by severity and names every rule", () => {
    const v = guardVerdict(["personal_submit", "purchase", "credential"], 4);
    expect(v.kinds).toEqual(["credential", "purchase", "personal_submit"]);
    expect(v.reason).toContain("password");
    expect(v.reason).toContain("purchases always");
  });

  it("a secret fill is a credential action unless the tool's own gate already asked; the element's other kinds stay", () => {
    const password = describeFromHtml(login, "#password");
    expect(classifySecretFill(password, {})).toEqual(["credential"]);
    expect(classifySecretFill(password, { credentialApproved: true })).toEqual([]);
    // a plain text field still counts as a credential entry when the fill is not yet approved
    expect(classifySecretFill(describeFromHtml(login, "#username"), {})).toEqual(["credential"]);
    const card = describeFromHtml(checkout, "#cardnumber");
    expect(classifySecretFill(card, { credentialApproved: true })).toEqual(["payment"]);
    expect(classifySecretFill(card, { credentialApproved: true, submit: true })).toEqual([
      "payment",
      "purchase",
    ]);
    expect(classifySecretFill(password, { credentialApproved: true, submit: true })).toEqual([]);
  });

  it("credential, payment and purchase approvals are one-shot; personal data and terms are remembered", () => {
    expect(isOneShot(["credential"])).toBe(true);
    expect(isOneShot(["payment"])).toBe(true);
    expect(isOneShot(["purchase", "personal_submit"])).toBe(true);
    expect(isOneShot(["personal_submit", "accept_terms"])).toBe(false);
    expect(isOneShot([])).toBe(false);
  });

  it("finds fields by heuristics when autocomplete is missing", () => {
    const html =
      '<form><label>IBAN <input name="acct"></label><input placeholder="Verification code" name="x"><input name="street_address"></form>';
    expect(classifyTyping(describeFromHtml(html, "input[name=acct]"))).toEqual(["payment"]);
    expect(classifyTyping(describeFromHtml(html, "input[name=x]"))).toEqual(["credential"]);
    expect(classifySubmit(describeFromHtml(html, "input[name=acct]").form)).toEqual([
      "purchase",
      "personal_submit",
    ]);
  });
});

function enforcer(approvals: FakeBrowserApprovals, autonomy: AutonomyLevel = 2) {
  const audit = new MemoryAudit();
  const e = new GuardEnforcer({
    approvals,
    audit,
    clock: new SimulatedClock(),
    autonomy,
    identity: {
      sessionId: "s1",
      runId: "r1",
      agentId: "alice",
      humanId: "h1",
      tokenId: "t1",
    },
  });
  return { e, audit };
}

describe("GuardEnforcer", () => {
  const el = describeFromHtml(login, "#password");
  const url = "https://shop.example.test/login";

  it("throws approval_required before the action when the human denies, and audits it", async () => {
    const approvals = new FakeBrowserApprovals("denied");
    const { e, audit } = enforcer(approvals, 4);
    await expect(e.enforce("browser_type", ["credential"], el, url)).rejects.toSatisfy((err) =>
      isForerunnerError(err, "approval_required"),
    );
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]).toMatchObject({
      tool: "browser_type",
      actionClass: "credential",
      risk: "high",
      guards: ["credential"],
      url,
      runId: "r1",
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ allowed: false, tool: "browser_type" });
    expect(audit.entries[0]?.deniedReason).toContain("denied");
  });

  it("reports pending as approval_required with pending details", async () => {
    const { e } = enforcer(new FakeBrowserApprovals("pending"));
    const err = await e.enforce("browser_click", ["purchase"], el, url).catch((x) => x);
    expect(isForerunnerError(err, "approval_required")).toBe(true);
    expect(err.details.pending).toBe(true);
    expect(err.message).toContain("waiting for human approval");
  });

  it("spends a credential, payment or purchase approval on the action it was given for: the same action asks again", async () => {
    const approvals = new FakeBrowserApprovals("approved");
    const { e, audit } = enforcer(approvals, 4);
    const order = describeFromHtml(checkout, "#place-order");
    const checkoutUrl = "https://shop.example.test/checkout";
    const v = await e.enforce("browser_click", ["purchase"], order, checkoutUrl);
    expect(v.needsApproval).toBe(true);
    await e.enforce("browser_click", ["purchase"], order, checkoutUrl);
    expect(approvals.requests).toHaveLength(2);
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[1]).toMatchObject({ allowed: true, resultSummary: "approved by human" });
    await e.enforce("browser_type", ["credential"], el, url);
    await e.enforce("browser_type", ["credential"], el, url);
    expect(approvals.requests).toHaveLength(4);
    await e.enforce("browser_type", ["payment"], describeFromHtml(checkout, "#cvc"), checkoutUrl);
    await e.enforce("browser_type", ["payment"], describeFromHtml(checkout, "#cvc"), checkoutUrl);
    expect(approvals.requests).toHaveLength(6);
    // a purchase that also submits personal data is still one-shot
    await e.enforce("browser_click", ["purchase", "personal_submit"], order, checkoutUrl);
    await e.enforce("browser_click", ["purchase", "personal_submit"], order, checkoutUrl);
    expect(approvals.requests).toHaveLength(8);
    expect(e.approved.size).toBe(0);
  });

  it("remembers an approval for personal data or terms on the same element and host for the session", async () => {
    const approvals = new FakeBrowserApprovals("approved");
    const { e, audit } = enforcer(approvals, 2);
    const create = describeFromHtml(signup, "#create");
    const signupUrl = "https://shop.example.test/signup";
    const v = await e.enforce("browser_click", ["personal_submit"], create, signupUrl);
    expect(v.needsApproval).toBe(true);
    await e.enforce("browser_click", ["personal_submit"], create, signupUrl);
    expect(approvals.requests).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ allowed: true, resultSummary: "approved by human" });
    // a different element asks again
    await e.enforce(
      "browser_click",
      ["accept_terms"],
      describeFromHtml(signup, "#terms"),
      signupUrl,
    );
    expect(approvals.requests).toHaveLength(2);
    // and so does the same element on another host
    await e.enforce(
      "browser_click",
      ["personal_submit"],
      create,
      "https://other.example.test/signup",
    );
    expect(approvals.requests).toHaveLength(3);
  });

  it("never asks when the autonomy level frees the action", async () => {
    const approvals = new FakeBrowserApprovals("denied");
    const { e } = enforcer(approvals, 4);
    const kinds: GuardKind[] = ["personal_submit"];
    const v = await e.enforce("browser_click", kinds, el, url);
    expect(v.needsApproval).toBe(false);
    expect(approvals.requests).toHaveLength(0);
  });

  it("never lets the secret value onto the approval card", async () => {
    const approvals = new FakeBrowserApprovals("approved");
    const { e } = enforcer(approvals);
    await e.enforce("browser_fill_secret", ["credential"], { ...el, value: "hunter2hunter2" }, url);
    expect(JSON.stringify(approvals.requests[0])).not.toContain("hunter2hunter2");
  });

  it("adapts the runtime ApprovalPort", async () => {
    const port = new AutoApprove("denied");
    const { e } = enforcer(approvalPortFromRuntime(port) as FakeBrowserApprovals);
    await expect(e.enforce("browser_click", ["purchase"], el, url)).rejects.toSatisfy((err) =>
      isForerunnerError(err, "approval_required"),
    );
    expect(port.requests[0]?.tool).toBe("browser_click");
  });
});

describe("HumanRequestApprovalPort", () => {
  it("opens one blocking human request per action and follows the answer", async () => {
    const clock = new SimulatedClock();
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
      locale: "en",
    });
    const agent = await store.agent.insert({
      name: "Alice",
      owner_human_id: human.id,
      model_config: {},
      memory_location: "l",
      status: "active",
      kind: "principal",
    });
    const project = await store.project.insert({
      name: "Sample",
      goal: "g",
      repos: [],
      stage: "s",
      status: "active",
      budget_usd_micro: 1,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    });
    const session = await store.session.insert({
      agent_id: agent.id,
      project_id: project.id,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 0,
      status: "running",
      runner: "pc",
      handoff: {},
      summary: "",
    });
    const port = new HumanRequestApprovalPort(store.humanRequest, clock);
    const req = {
      sessionId: session.id,
      runId: "r1",
      agentId: agent.id,
      humanId: human.id,
      tool: "browser_click",
      actionClass: "financial",
      risk: "high" as const,
      why: "purchase",
      input: { url: "https://shop.example.test/checkout" },
      guards: ["purchase"] as GuardKind[],
      url: "https://shop.example.test/checkout",
      element: { tag: "button", text: "Place order" },
    };
    expect(await port.ask(req)).toBe("pending");
    expect(await port.ask(req)).toBe("pending");
    const open = await store.humanRequest.open({ humanId: human.id });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "approval", blocking: true, risk: "high" });
    expect(open[0]?.steps).toContain("Guards: purchase");
    const row = open[0];
    if (!row) throw new Error("no request");
    await store.humanRequest.answer(row.id, row.version, "yes", human.id);
    expect(await port.ask(req)).toBe("approved");
    // the "yes" is spent: the next identical purchase opens a new request instead of reusing it
    expect(await port.ask(req)).toBe("pending");
    const again = await store.humanRequest.open({ humanId: human.id });
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(row.id);
    const spent = await store.humanRequest.mustGet(row.id);
    expect(spent.status).toBe("answered");
    expect((spent.change_card as { consumedAt?: string }).consumedAt).toBeTruthy();
    expect(await port.ask(req)).toBe("pending");
    expect(await store.humanRequest.open({ humanId: human.id })).toHaveLength(1);
    const second = again[0];
    if (!second) throw new Error("no request");
    await store.humanRequest.answer(second.id, second.version, "yes", human.id);
    expect(await port.ask(req)).toBe("approved");
    expect(await port.ask(req)).toBe("pending");

    const other = { ...req, element: { tag: "button", text: "Buy now" } };
    expect(await port.ask(other)).toBe("pending");
    const target = (await store.humanRequest.open({ humanId: human.id })).find((r) =>
      r.steps.includes("Element: button|||||Buy now"),
    );
    if (!target) throw new Error("no request");
    await store.humanRequest.answer(target.id, target.version, "no", human.id);
    // a "no" is not spent: the same action stays denied without a new card
    expect(await port.ask(other)).toBe("denied");
    expect(await port.ask(other)).toBe("denied");
    await store.close();
  });
});
