import { type Clock, ForerunnerError } from "@forerunner/platform";
import {
  type ActionClass,
  ALWAYS_HUMAN,
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  type AuditPort,
  type AutonomyLevel,
  decideAutonomy,
} from "@forerunner/runtime";
import type { HumanRequestRepo } from "@forerunner/state";
import { type FieldSummary, type FormSummary, summarizeForm, TERMS_PATTERN } from "./extract.ts";
import {
  closest,
  type HtmlElement,
  parseHtml,
  querySelector,
  querySelectorAll,
  textContent,
} from "./html.ts";

/**
 * Approval gates for browser actions, enforced in code before the action runs. The runtime
 * hooks decide per tool (action class); these guards decide per element, because whether a
 * click is a purchase or a keystroke is a password depends on the page. Classification is pure
 * (works on HTML fixtures); `GuardEnforcer` turns a verdict into an approval request through a
 * small port and throws before the action when the answer is not "approved".
 */
export type GuardKind = "credential" | "payment" | "purchase" | "personal_submit" | "accept_terms";

export interface GuardRule {
  actionClass: ActionClass;
  risk: "low" | "medium" | "high";
  /** Human-readable rule, shown on the approval card. */
  rule: string;
}

/** Credential and money always need a human (ALWAYS_HUMAN classes); personal data and terms are free at level 4. */
export const GUARD_RULES: Record<GuardKind, GuardRule> = {
  credential: {
    actionClass: "credential",
    risk: "high",
    rule: "typing into a password or credential field needs approval at every autonomy level",
  },
  payment: {
    actionClass: "financial",
    risk: "high",
    rule: "typing into a payment field needs approval at every autonomy level",
  },
  purchase: {
    actionClass: "financial",
    risk: "high",
    rule: "purchases always need approval",
  },
  personal_submit: {
    actionClass: "external_send",
    risk: "medium",
    rule: "submitting a form with personal data needs approval below autonomy 4",
  },
  accept_terms: {
    actionClass: "external_send",
    risk: "medium",
    rule: "accepting terms needs approval below autonomy 4",
  },
};

export interface ElementDescriptor {
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  /** Visible text of the element (buttons, links, labels), trimmed. */
  text?: string;
  value?: string;
  role?: string;
  checked?: boolean;
  href?: string;
  /** Text around the element (its label or parent), for checkboxes. */
  nearbyText?: string;
  form?: FormSummary;
}

export interface GuardVerdict {
  kinds: GuardKind[];
  needsApproval: boolean;
  /** Most severe class among the kinds (always-human first). */
  actionClass: ActionClass | "read";
  risk: "low" | "medium" | "high";
  reason: string;
}

const CREDENTIAL_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code"]);
const CREDENTIAL_PATTERN =
  /\b(pass(word|wd|code|phrase)?|pwd|otp|one[- ]?time|2fa|mfa|totp|verification code|auth(entication)? code|security code|secret|api[-_ ]?key|access token|private key)\b/i;
const PAYMENT_PATTERN =
  /\b(card[- ]?(number|no|num)|cardnumber|credit[- ]?card|debit[- ]?card|cc[-_ ]?(num|number|exp|csc|cvc|cvv)|cvc|cvv|csc|security code|iban|bic|swift|sort code|routing( number)?|account number|expir(y|ation)|exp(\.| )?date)\b/i;
const PURCHASE_PATTERN =
  /\b(buy( now)?|check ?out|place (your |the |my )?order|order now|pay( now| securely)?|make (a |the )?payment|purchase|complete (your |the |my )?(purchase|order|payment)|confirm (and |& )?pay|subscribe( now)?|start (my |your )?(trial|subscription)|upgrade (plan|now)|donate)\b/i;
const PURCHASE_ACTION_PATTERN = /checkout|purchase|order|payment|pay\b|billing|subscribe/i;
const EMAIL_PATTERN = /\be-?mail\b/i;
const PHONE_PATTERN = /\b(phone|tel(ephone)?|mobile|cell(phone)?)\b/i;
const ADDRESS_PATTERN =
  /\b(address|street|zip|postal( code)?|postcode|city|country|state|province|addr)\b/i;
const PERSONAL_AUTOCOMPLETE =
  /^(email|tel(-.*)?|street-address|address-line[123]|address-level[1-4]|postal-code|country(-name)?)$/i;

function haystack(
  el: Pick<ElementDescriptor, "name" | "id" | "label" | "placeholder" | "ariaLabel">,
): string {
  return [el.name, el.id, el.label, el.placeholder, el.ariaLabel]
    .filter(Boolean)
    .join(" ")
    .replace(/[_-]+/g, " ");
}

export function isCredentialField(f: FieldSummary | ElementDescriptor): boolean {
  if (f.tag !== "input" && f.tag !== "textarea") return false;
  if ((f.type ?? "").toLowerCase() === "password") return true;
  if (f.autocomplete && CREDENTIAL_AUTOCOMPLETE.has(f.autocomplete.toLowerCase())) return true;
  return CREDENTIAL_PATTERN.test(haystack(f));
}

/** `cc-name` and its parts hold the cardholder's name, not the instrument: personal data, not payment. */
const CC_NAME_AUTOCOMPLETE = /^cc-(name|given-name|additional-name|family-name)$/i;

export function isPaymentField(f: FieldSummary | ElementDescriptor): boolean {
  if (f.tag !== "input" && f.tag !== "select" && f.tag !== "textarea") return false;
  const ac = (f.autocomplete ?? "").toLowerCase();
  if (/^cc-/.test(ac)) return !CC_NAME_AUTOCOMPLETE.test(ac);
  return PAYMENT_PATTERN.test(haystack(f));
}

export type PersonalDataKind = "email" | "phone" | "address";

export function personalDataKind(f: FieldSummary | ElementDescriptor): PersonalDataKind | null {
  if (f.tag !== "input" && f.tag !== "textarea" && f.tag !== "select") return null;
  const type = (f.type ?? "").toLowerCase();
  const ac = (f.autocomplete ?? "").toLowerCase();
  if (type === "email" || ac === "email") return "email";
  if (type === "tel" || ac.startsWith("tel")) return "phone";
  if (PERSONAL_AUTOCOMPLETE.test(ac)) return "address";
  if (type === "password" || type === "checkbox" || type === "radio") return null;
  const h = haystack(f);
  if (EMAIL_PATTERN.test(h)) return "email";
  if (PHONE_PATTERN.test(h)) return "phone";
  if (ADDRESS_PATTERN.test(h)) return "address";
  return null;
}

export function isTermsCheckbox(f: FieldSummary | ElementDescriptor): boolean {
  if (f.tag !== "input" || (f.type ?? "").toLowerCase() !== "checkbox") return false;
  const near = "nearbyText" in f ? f.nearbyText : undefined;
  return TERMS_PATTERN.test(
    [haystack(f), near, "text" in f ? f.text : undefined].filter(Boolean).join(" "),
  );
}

/** Guards for typing into an element. */
export function classifyTyping(el: ElementDescriptor): GuardKind[] {
  const kinds: GuardKind[] = [];
  if (isCredentialField(el)) kinds.push("credential");
  if (isPaymentField(el)) kinds.push("payment");
  return kinds;
}

/**
 * Guards for typing a vault secret into an element. Typing a secret is a credential entry
 * whatever the field looks like. `credentialApproved` says the caller's own gate already had a
 * human approve this very fill (the runtime hooks do, before `execute`, because the
 * `browser_fill_secret` tool has the `credential` action class): then the session adds no
 * `credential` kind of its own, so one fill is one card. The element's other kinds (a payment
 * field, a purchase or personal data on submit) are never covered by that approval and stay.
 */
export function classifySecretFill(
  el: ElementDescriptor,
  opts: { submit?: boolean; credentialApproved?: boolean },
): GuardKind[] {
  const kinds = new Set<GuardKind>(opts.credentialApproved ? [] : ["credential"]);
  for (const k of classifyTyping(el)) {
    if (k === "credential" && opts.credentialApproved) continue;
    kinds.add(k);
  }
  if (opts.submit) for (const k of classifySubmit(el.form)) kinds.add(k);
  return [...kinds];
}

/** Guards for submitting a form (Enter in a field, or a submit button). */
export function classifySubmit(form: FormSummary | undefined): GuardKind[] {
  if (!form) return [];
  const kinds: GuardKind[] = [];
  const hasPayment = form.fields.some(isPaymentField);
  if (
    hasPayment ||
    PURCHASE_ACTION_PATTERN.test(form.action ?? "") ||
    form.buttons.some((b) => PURCHASE_PATTERN.test(b))
  )
    kinds.push("purchase");
  if (form.fields.some((f) => personalDataKind(f) !== null)) kinds.push("personal_submit");
  if (form.fields.some((f) => isTermsCheckbox(f) && f.checked !== false))
    kinds.push("accept_terms");
  return kinds;
}

function isSubmitControl(el: ElementDescriptor): boolean {
  const type = (el.type ?? "").toLowerCase();
  if (el.tag === "button") return type !== "button" && type !== "reset";
  if (el.tag === "input") return type === "submit" || type === "image";
  return false;
}

/** Guards for clicking an element. */
export function classifyClick(el: ElementDescriptor): GuardKind[] {
  const kinds = new Set<GuardKind>();
  const label = [el.text, el.value, el.ariaLabel, el.label].filter(Boolean).join(" ");
  if (PURCHASE_PATTERN.test(label)) kinds.add("purchase");
  if (isTermsCheckbox(el) && el.checked !== true) kinds.add("accept_terms");
  if (
    el.form &&
    (isSubmitControl(el) || (el.tag !== "input" && el.tag !== "select" && el.tag !== "textarea"))
  ) {
    for (const k of classifySubmit(el.form)) kinds.add(k);
  }
  if (
    el.form &&
    isSubmitControl(el) &&
    el.form.fields.some((f) => isTermsCheckbox(f) && f.checked !== false)
  )
    kinds.add("accept_terms");
  return [...kinds];
}

const SEVERITY: GuardKind[] = [
  "credential",
  "payment",
  "purchase",
  "accept_terms",
  "personal_submit",
];

/**
 * Approvals for always-human kinds (credential, payment, purchase) are spent by the one action
 * they were given for: a second identical click or keystroke asks again. Personal data and
 * terms are remembered per element and host for the session.
 */
export function isOneShot(kinds: readonly GuardKind[]): boolean {
  return kinds.some((k) => ALWAYS_HUMAN.has(GUARD_RULES[k].actionClass));
}

/** Decide in code whether the kinds need a human at this autonomy level. */
export function guardVerdict(kinds: readonly GuardKind[], autonomy: AutonomyLevel): GuardVerdict {
  if (!kinds.length) {
    return { kinds: [], needsApproval: false, actionClass: "read", risk: "low", reason: "" };
  }
  const sorted = [...new Set(kinds)].sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b));
  const top = sorted[0] as GuardKind;
  const rule = GUARD_RULES[top];
  const needsApproval = sorted.some(
    (k) => decideAutonomy(GUARD_RULES[k].actionClass, { level: autonomy }) !== "allow",
  );
  return {
    kinds: sorted,
    needsApproval,
    actionClass: rule.actionClass,
    risk: rule.risk,
    reason: sorted.map((k) => GUARD_RULES[k].rule).join("; "),
  };
}

// ---------------------------------------------------------------------------------------------
// Describing an element from an HTML fixture (no browser)
// ---------------------------------------------------------------------------------------------

function collapse(s: string | undefined): string | undefined {
  const t = s?.replace(/[\s ]+/g, " ").trim();
  return t ? t : undefined;
}

export function describeHtmlElement(root: HtmlElement, el: HtmlElement): ElementDescriptor {
  const d: ElementDescriptor = { tag: el.tag };
  const type = el.attrs.type ?? (el.tag === "input" ? "text" : undefined);
  if (type) d.type = type.toLowerCase();
  if (el.attrs.name) d.name = el.attrs.name;
  if (el.attrs.id) d.id = el.attrs.id;
  if (el.attrs.autocomplete) d.autocomplete = el.attrs.autocomplete.toLowerCase();
  if (el.attrs.placeholder) d.placeholder = collapse(el.attrs.placeholder);
  if (el.attrs["aria-label"]) d.ariaLabel = collapse(el.attrs["aria-label"]);
  if (el.attrs.value) d.value = collapse(el.attrs.value);
  if (el.attrs.role) d.role = el.attrs.role.toLowerCase();
  if (el.attrs.href) d.href = el.attrs.href;
  const text = collapse(textContent(el));
  if (text) d.text = text;
  if (d.type === "checkbox" || d.type === "radio") d.checked = "checked" in el.attrs;
  let label: string | undefined;
  if (el.attrs.id) {
    const lab = querySelectorAll(root, "label").find((l) => l.attrs.for === el.attrs.id);
    if (lab) label = collapse(textContent(lab));
  }
  const wrap = closest(el, "label");
  if (!label && wrap) label = collapse(textContent(wrap));
  if (label) d.label = label;
  const near = wrap ?? el.parent;
  const nearby =
    near && near.tag !== "#document" ? collapse(textContent(near))?.slice(0, 300) : undefined;
  if (nearby) d.nearbyText = nearby;
  const form = closest(el, "form");
  if (form) {
    const all = querySelectorAll(root, "form");
    d.form = summarizeForm(root, form, Math.max(0, all.indexOf(form)));
  } else if (el.attrs.form) {
    const owner = querySelector(root, `form[id="${el.attrs.form}"]`);
    if (owner)
      d.form = summarizeForm(
        root,
        owner,
        Math.max(0, querySelectorAll(root, "form").indexOf(owner)),
      );
  }
  return d;
}

/** Describe the first element matching `selector` in an HTML string. Throws `not_found`. */
export function describeFromHtml(html: string, selector: string): ElementDescriptor {
  const root = parseHtml(html);
  const el = querySelector(root, selector);
  if (!el) {
    throw new ForerunnerError("not_found", `no element matches ${selector}`, {
      details: { selector },
    });
  }
  return describeHtmlElement(root, el);
}

// ---------------------------------------------------------------------------------------------
// Approval port and enforcement
// ---------------------------------------------------------------------------------------------

export interface BrowserApprovalRequest extends ApprovalRequest {
  guards: GuardKind[];
  url: string;
  element: ElementDescriptor;
}

export type BrowserApprovalAnswer = ApprovalOutcome;

/** The one place a browser action asks a human. Production: HumanRequestRepo; tests: a fake. */
export interface BrowserApprovalPort {
  ask(request: BrowserApprovalRequest): Promise<BrowserApprovalAnswer>;
}

export interface BrowserIdentity {
  sessionId: string;
  runId: string;
  agentId: string;
  humanId: string;
  projectId?: string;
  taskId?: string;
  tokenId?: string;
}

export interface GuardEnforcerDeps {
  approvals: BrowserApprovalPort;
  audit: AuditPort;
  clock: Clock;
  autonomy: AutonomyLevel;
  identity: BrowserIdentity;
}

function elementSignature(el: ElementDescriptor): string {
  return [el.tag, el.type, el.name, el.id, el.autocomplete, el.text?.slice(0, 40)]
    .map((x) => x ?? "")
    .join("|");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Strip the form text and long fields before an element goes on an approval card. */
export function elementForCard(el: ElementDescriptor): ElementDescriptor {
  const out: ElementDescriptor = { ...el };
  if (out.text && out.text.length > 120) out.text = `${out.text.slice(0, 120)}…`;
  if (out.nearbyText && out.nearbyText.length > 160)
    out.nearbyText = `${out.nearbyText.slice(0, 160)}…`;
  out.value = undefined;
  if (out.form) out.form = { ...out.form, text: out.form.text.slice(0, 200) };
  return out;
}

/**
 * Per-session enforcement: asks through the port before the action, writes an audit row for
 * every ask, and throws `approval_required` when the human said no or has not answered yet.
 * An approval for a credential, payment or purchase action is spent by that action (the port
 * hands an answered "yes" out once; nothing is cached here), so the same click asks again. An
 * approval for personal data or terms is remembered for the same element on the same host.
 */
export class GuardEnforcer {
  /** Remembered approvals: non-one-shot kinds only. */
  readonly approved = new Set<string>();

  constructor(private readonly deps: GuardEnforcerDeps) {}

  get autonomy(): AutonomyLevel {
    return this.deps.autonomy;
  }

  /** Returns the verdict after the gate passed; throws before the action otherwise. */
  async enforce(
    tool: string,
    kinds: readonly GuardKind[],
    element: ElementDescriptor,
    url: string,
  ): Promise<GuardVerdict> {
    const verdict = guardVerdict(kinds, this.deps.autonomy);
    if (!verdict.needsApproval) return verdict;
    const key = `${verdict.kinds.join("+")}:${hostOf(url)}:${elementSignature(element)}`;
    if (this.approved.has(key)) return verdict;
    const id = this.deps.identity;
    const card = elementForCard(element);
    const answer = await this.deps.approvals.ask({
      sessionId: id.sessionId,
      runId: id.runId,
      agentId: id.agentId,
      humanId: id.humanId,
      projectId: id.projectId,
      taskId: id.taskId,
      tool,
      actionClass: verdict.actionClass,
      risk: verdict.risk,
      why: `${verdict.reason} (autonomy level ${this.deps.autonomy}) on ${hostOf(url)}`,
      input: { url, element: card },
      guards: verdict.kinds,
      url,
      element: card,
    });
    const summary = `${verdict.kinds.join("+")} on ${url} (${elementSignature(element)})`;
    if (answer === "approved") {
      if (!isOneShot(verdict.kinds)) this.approved.add(key);
      await this.deps.audit.append({
        sessionId: id.sessionId,
        runId: id.runId,
        agentId: id.agentId,
        humanId: id.humanId,
        tool,
        inputSummary: summary,
        resultSummary: "approved by human",
        allowed: true,
        costUsdMicro: 0,
        occurredAt: this.deps.clock.nowIso(),
        tokenId: id.tokenId ?? "",
      });
      return verdict;
    }
    const pending = answer === "pending";
    await this.deps.audit.append({
      sessionId: id.sessionId,
      runId: id.runId,
      agentId: id.agentId,
      humanId: id.humanId,
      tool,
      inputSummary: summary,
      resultSummary: pending ? "pending human approval" : "denied by human",
      allowed: false,
      deniedReason: `approval_required: ${pending ? "pending" : "denied"}`,
      costUsdMicro: 0,
      occurredAt: this.deps.clock.nowIso(),
      tokenId: id.tokenId ?? "",
    });
    throw new ForerunnerError(
      "approval_required",
      pending
        ? `waiting for human approval before ${tool}: ${verdict.reason}`
        : `human denied ${tool}: ${verdict.reason}`,
      { details: { tool, guards: verdict.kinds, url, pending, element: card } },
    );
  }
}

/** Use the runtime's ApprovalPort (StateApprovals in production) as the browser's port. */
export function approvalPortFromRuntime(port: ApprovalPort): BrowserApprovalPort {
  return {
    ask: (req) => port.request(req),
  };
}

interface BrowserChangeCard {
  key?: string;
  /** Set when the "yes" was handed out to the action it was given for; a spent card never approves again. */
  consumedAt?: string;
}

/**
 * Production port backed by HumanRequestRepo: one open request per distinct guarded action
 * in a session; an open one keeps the action pending. An answered "yes" approves exactly once
 * and is marked spent (`change_card.consumedAt`, durable across a daemon restart), so the next
 * identical action opens a new request; an answered "no" keeps denying the same action.
 */
export class HumanRequestApprovalPort implements BrowserApprovalPort {
  constructor(
    private readonly requests: HumanRequestRepo,
    private readonly clock: Pick<Clock, "nowIso">,
  ) {}

  async ask(req: BrowserApprovalRequest): Promise<BrowserApprovalAnswer> {
    const key = `browser:${req.tool}:${req.guards.join("+")}:${req.url}:${elementSignature(req.element)}`;
    const existing = await this.requests.list(
      { session_id: req.sessionId, kind: "approval" },
      { orderBy: [{ column: "created_at", direction: "desc" }] },
    );
    const same = existing.find((r) => (r.change_card as BrowserChangeCard | null)?.key === key);
    if (same) {
      if (same.status === "open") return "pending";
      if (same.status === "answered") {
        if (!isYes(same.answer)) return "denied";
        const card = same.change_card as BrowserChangeCard | null;
        if (!card?.consumedAt) {
          try {
            await this.requests.update(same.id, same.version, {
              change_card: {
                ...(same.change_card ?? {}),
                consumedAt: this.clock.nowIso(),
              },
            });
            return "approved";
          } catch (e) {
            // the row moved under us (another consumer took the "yes"): ask afresh below
            if (!(e instanceof ForerunnerError && e.code === "version_conflict")) throw e;
          }
        }
      }
    }
    await this.requests.insert({
      human_id: req.humanId,
      project_id: req.projectId ?? null,
      task_id: req.taskId ?? null,
      session_id: req.sessionId,
      kind: "approval",
      why: req.why,
      steps: [
        `Tool: ${req.tool}`,
        `Page: ${req.url}`,
        `Guards: ${req.guards.join(", ")}`,
        `Element: ${elementSignature(req.element)}`,
      ],
      options: ["yes", "no"],
      blocking: true,
      risk: req.risk,
      change_card: {
        key,
        tool: req.tool,
        actionClass: req.actionClass,
        guards: req.guards,
        url: req.url,
        input: JSON.parse(JSON.stringify(req.input ?? null)),
      },
      author_agent: req.agentId,
    });
    return "pending";
  }
}

export function isYes(answer: unknown): boolean {
  if (typeof answer === "boolean") return answer;
  if (typeof answer === "string")
    return /^(y|yes|ok|approve|approved|ja|oui|sí|si|confirm|confirmed)$/i.test(answer.trim());
  if (answer && typeof answer === "object")
    return isYes(
      (answer as { choice?: unknown; answer?: unknown }).choice ??
        (answer as { answer?: unknown }).answer,
    );
  return false;
}

/** Test double: a fixed answer or a function of the request; records every ask. */
export class FakeBrowserApprovals implements BrowserApprovalPort {
  readonly requests: BrowserApprovalRequest[] = [];
  constructor(
    private readonly answer:
      | BrowserApprovalAnswer
      | ((
          req: BrowserApprovalRequest,
        ) => BrowserApprovalAnswer | Promise<BrowserApprovalAnswer>) = "approved",
  ) {}
  async ask(req: BrowserApprovalRequest): Promise<BrowserApprovalAnswer> {
    this.requests.push(req);
    return typeof this.answer === "function" ? this.answer(req) : this.answer;
  }
}
