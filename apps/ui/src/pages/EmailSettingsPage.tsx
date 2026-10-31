import { EMAIL_MODES } from "@forerunner/runtime/daemon/api-types";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  type AgentView,
  type CommandResultJson,
  describeError,
  type EmailCommandRowView,
  type EmailMode,
  type EmailSentRowView,
  type EmailSettingsPatchBody,
  type EmailSettingsView,
} from "../api/client.ts";
import { CommandResult } from "../components/ChangeCardDialog.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { RouteMissing } from "../components/RouteMissing.tsx";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
} from "../components/ui.tsx";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

/**
 * Settings -> Capabilities -> Email (spec S.15, S.28, S.29, T.14; ADR 0066): per agent of the
 * signed-in human, the sending mode with its one-line meaning, the limits that stay on, the
 * allowlist where the mode needs it, the mailbox (credentials by reference), pause and resume,
 * the command toggle with its private marker, the command audit and the sent copies. The
 * mode is a high-risk change (spec Q "Confirmation by risk"): the picker runs the registry's
 * `email.mode.set` (the change card, a confirmation on a paired device, one change log row
 * with Undo, the same path chat and voice take), and a switch into full discretion repeats the
 * plain sentence of S.29 in that dialog. Every other field goes through the capability's own
 * routes, which audit it; the policy reads the row on the next send, so nothing here is
 * UI-only.
 */

export const MODE_LABELS: Record<EmailMode, string> = {
  off: "Off",
  read_only: "Read only",
  draft_only: "Draft only",
  allowlist: "Allowlist",
  full_discretion: "Full discretion",
};

export const MODE_MEANINGS: Record<EmailMode, string> = {
  off: "Reads nothing, sends nothing.",
  read_only: "Reads its own mailbox, sends nothing.",
  draft_only: "Reads its own mailbox; writes drafts that you send. Every email is approved by you.",
  allowlist:
    "Reads its own mailbox; sends freely to the approved addresses and domains. A new recipient needs your approval.",
  full_discretion:
    "Reads its own mailbox; sends to anyone, at its own judgment, without approval, inside the limits below.",
};

/** The plain sentence spec S.29 asks for: shown under the option and again in the confirmation. */
export const FULL_DISCRETION_WARNING =
  "With full discretion the agent can email strangers on your behalf: anyone it judges right, without asking you first. The daily and per-recipient caps, the blocked-content rules and the signature stay on.";

/** "ignored: no_marker" -> "no marker"; a handler error keeps its text. */
export function ignoredReason(row: Pick<EmailCommandRowView, "obeyed" | "deniedReason">) {
  if (row.obeyed || !row.deniedReason) return null;
  return row.deniedReason.replace(/^ignored:\s*/, "").replace(/_/g, " ");
}

/** The interpretation the handler recorded: kind and title or summary, or why there is none. */
export function interpretationOf(row: EmailCommandRowView): string {
  const interp = row.result.interpretation;
  if (interp && typeof interp === "object") {
    const i = interp as { kind?: unknown; title?: unknown; summary?: unknown };
    const kind = typeof i.kind === "string" ? i.kind : "";
    const text =
      typeof i.title === "string" && i.title.trim() !== ""
        ? i.title
        : typeof i.summary === "string"
          ? i.summary
          : "";
    return [kind, text].filter((p) => p !== "").join(": ") || "—";
  }
  return row.obeyed ? "—" : "not interpreted";
}

/** The outcome with the ids it produced; an ignored mail says so. */
export function resultOf(row: EmailCommandRowView): string {
  if (!row.obeyed) return row.deniedReason ?? "ignored";
  const r = row.result as { outcome?: unknown; taskId?: unknown; sessionId?: unknown };
  const parts = [typeof r.outcome === "string" ? r.outcome.replace(/_/g, " ") : "—"];
  if (typeof r.taskId === "string") parts.push(`task ${r.taskId}`);
  if (typeof r.sessionId === "string") parts.push(`session ${r.sessionId}`);
  return parts.join(" · ");
}

/** One entry per line, trimmed, empty lines dropped. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

const asInt = (value: string, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

/**
 * The dialog of a mode change: the registry's card (old -> new, high risk), the S.29 sentence
 * repeated when full discretion is picked, then the device confirmation, the sentence with
 * Undo, a cancellation or the daemon's refusal (`CommandResult`, the component every button
 * that runs a command uses). Nothing is written until the daemon answers `done`.
 */
function ModeChangeDialog({
  agent,
  mode,
  result,
  busy,
  error,
  onConfirm,
  onUndo,
  onClose,
}: {
  agent: AgentView;
  mode: EmailMode;
  result: CommandResultJson | null;
  busy: boolean;
  error: string | null;
  onConfirm: (answer: "yes" | "no") => void;
  onUndo: (changeLogId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Change the email mode of ${agent.name}`}
      testId="email-mode-dialog"
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Runs the <code>email.mode.set</code> command, the same one chat and voice use. A change of
          the email mode is high risk: it is confirmed on a paired device and written to the change
          log with Undo.
        </p>
        {mode === "full_discretion" ? (
          <p
            className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            data-testid="full-discretion-confirm-text"
          >
            {FULL_DISCRETION_WARNING}
          </p>
        ) : null}
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {MODE_LABELS[mode]}: {MODE_MEANINGS[mode]} You can pause email from the tray at any time,
          and every sent email is logged with a copy here.
        </p>
        {error ? <ErrorBanner message={error} /> : null}
        {result ? (
          <CommandResult
            result={result}
            busy={busy}
            onConfirm={onConfirm}
            onUndo={onUndo}
            onDismiss={onClose}
          />
        ) : (
          <Loading what="the change card" />
        )}
      </div>
    </Dialog>
  );
}

function ModePicker({
  agent,
  config,
  onChanged,
}: {
  agent: AgentView;
  config: EmailSettingsView;
  /** The daemon changed the row (a done change, an undo): re-read the settings. */
  onChanged: () => void;
}) {
  const client = useClient();
  // This PC's own device row as the daemon names it on `/me` (ADR 0030): the paired device a
  // high-risk change is confirmed on; the daemon checks the row, not this screen.
  const desktopDeviceId = useUiState((s) => s.me?.desktopDeviceId ?? null);
  const current = config.settings.mode;
  const [picked, setPicked] = useState<EmailMode>(current);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CommandResultJson | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setPicked(current), [current]);

  const run = async (action: () => Promise<CommandResultJson>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      setResult(r);
      if (r.status === "done" || r.status === "partial") {
        // The registry's sentence is the record (it says when commands went off with a
        // change to off, ADR 0081); the row changed under the forms, so they re-read it.
        setNote(r.sentence ?? null);
        onChanged();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  // A mode change is the registry's `email.mode.set` (spec Q: high risk), never a raw PUT:
  // the daemon shows the card, the device confirms, the change log gets its row.
  const apply = () => {
    if (picked === current) return;
    setResult(null);
    setOpen(true);
    void run(() =>
      client.executeCommands({
        commands: [{ name: "email.mode.set", params: { mode: picked, agent: agent.id } }],
        wordsUsed: `Settings: email mode of ${agent.name} to ${MODE_LABELS[picked]}`,
        source: "ui",
      }),
    );
  };
  const confirm = (answer: "yes" | "no") => {
    if (result?.status !== "pending" || !result.pendingId) return;
    const pendingId = result.pendingId;
    if (answer === "no") {
      void run(() => client.confirmCommand(pendingId, { answer: "no" }));
      return;
    }
    void run(() =>
      result.decision === "needs_device"
        ? client.confirmCommand(pendingId, {
            answer: "device",
            ...(desktopDeviceId ? { deviceId: desktopDeviceId } : {}),
          })
        : client.confirmCommand(pendingId, { answer: "tap" }),
    );
  };
  const undo = (changeLogId: string) => void run(() => client.undoChange(changeLogId));
  const close = () => {
    setOpen(false);
    setResult(null);
    setPicked(current);
  };

  return (
    <fieldset className="space-y-2" data-testid="email-mode-picker">
      <legend className="font-medium">Mode</legend>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        What the agent may do with its own mailbox. Current:{" "}
        <Badge tone={current === "off" ? "neutral" : "info"} testId="email-mode-current">
          {MODE_LABELS[current]}
        </Badge>
      </p>
      {EMAIL_MODES.map((mode) => (
        <label
          key={mode}
          className="flex items-start gap-2 text-sm"
          data-testid="email-mode-option"
          data-mode={mode}
        >
          <input
            type="radio"
            name={`email-mode-${agent.id}`}
            value={mode}
            checked={picked === mode}
            onChange={() => setPicked(mode)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{MODE_LABELS[mode]}</span>
            <span className="text-neutral-600 dark:text-neutral-400"> — {MODE_MEANINGS[mode]}</span>
            {mode === "full_discretion" ? (
              <span
                className="mt-1 block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                data-testid="full-discretion-warning"
              >
                {FULL_DISCRETION_WARNING}
              </span>
            ) : null}
          </span>
        </label>
      ))}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={apply}
          disabled={busy || picked === current}
          data-testid="email-mode-apply"
        >
          Apply mode
        </Button>
        <span className="text-xs text-neutral-500">
          Shows the change card; confirmed on a paired device.
        </span>
        {note ? (
          <output
            className="text-xs text-neutral-600 dark:text-neutral-400"
            data-testid="email-mode-note"
          >
            {note}
          </output>
        ) : null}
      </div>
      {open ? (
        <ModeChangeDialog
          agent={agent}
          mode={picked}
          result={result}
          busy={busy}
          error={error}
          onConfirm={confirm}
          onUndo={undo}
          onClose={close}
        />
      ) : null}
    </fieldset>
  );
}

function PauseControl({
  agent,
  config,
  onSaved,
}: {
  agent: AgentView;
  config: EmailSettingsView;
  onSaved: (paused: boolean) => void;
}) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = config.settings.paused;
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = paused ? await client.resumeEmail(agent.id) : await client.pauseEmail(agent.id);
      onSaved(next.paused);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="email-pause-control">
      <Badge tone={paused ? "warn" : "good"} testId="email-paused">
        {paused ? "paused: every send is held" : "sending active"}
      </Badge>
      <Button
        variant={paused ? "primary" : "secondary"}
        onClick={() => void toggle()}
        disabled={busy}
        data-testid="email-pause"
      >
        {paused ? "Resume email" : "Pause email"}
      </Button>
      <span className="text-xs text-neutral-500">
        The same switch as the tray's one click. Sends held while paused stay in the log as queued;
        they are not resent on resume.
      </span>
      {error ? <ErrorBanner message={error} /> : null}
    </div>
  );
}

/** A small form over a slice of the settings; `submit` builds the PUT body from the fields. */
function useSave(agentId: string, onSaved: (next: EmailSettingsView) => void) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (body: EmailSettingsPatchBody) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await client.updateEmailSettings(agentId, body));
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, save };
}

function LimitsForm({
  agent,
  config,
  onSaved,
}: {
  agent: AgentView;
  config: EmailSettingsView;
  onSaved: (next: EmailSettingsView) => void;
}) {
  const s = config.settings;
  const { busy, error, saved, save } = useSave(agent.id, onSaved);
  const [dailySendCap, setDailySendCap] = useState(String(s.dailySendCap));
  const [perRecipient, setPerRecipient] = useState(String(s.perRecipientDailyCap));
  const [signatureOn, setSignatureOn] = useState(s.signature.enabled);
  const [signatureText, setSignatureText] = useState(s.signature.text);
  const [digest, setDigest] = useState(s.dailyDigest);
  const [addresses, setAddresses] = useState(s.allowlist.addresses.join("\n"));
  const [domains, setDomains] = useState(s.allowlist.domains.join("\n"));
  const showAllowlist = s.mode === "allowlist";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      settings: {
        dailySendCap: asInt(dailySendCap, s.dailySendCap),
        perRecipientDailyCap: asInt(perRecipient, s.perRecipientDailyCap),
        signature: { enabled: signatureOn, text: signatureText.trim() || s.signature.text },
        dailyDigest: digest,
        ...(showAllowlist
          ? { allowlist: { addresses: parseLines(addresses), domains: parseLines(domains) } }
          : {}),
      },
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2" data-testid="email-limits">
      <h4 className="font-medium">Limits that stay on in every sending mode</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Daily send cap" hint="Emails per day, every recipient counted (default 20).">
          <input
            className={INPUT_CLASS}
            type="number"
            min={0}
            step={1}
            value={dailySendCap}
            onChange={(e) => setDailySendCap(e.target.value)}
            data-testid="limit-daily"
          />
        </Field>
        <Field label="Per-recipient cap" hint="Emails to one address per day (default 5).">
          <input
            className={INPUT_CLASS}
            type="number"
            min={0}
            step={1}
            value={perRecipient}
            onChange={(e) => setPerRecipient(e.target.value)}
            data-testid="limit-recipient"
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={signatureOn}
          onChange={(e) => setSignatureOn(e.target.checked)}
          data-testid="signature-enabled"
        />
        Signature says it is an AI agent acting for you (on by default)
      </label>
      <Field label="Signature text" hint="{agent} and {human} are filled in at send time.">
        <textarea
          className={INPUT_CLASS}
          rows={2}
          value={signatureText}
          onChange={(e) => setSignatureText(e.target.value)}
          data-testid="signature-text"
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={digest}
          onChange={(e) => setDigest(e.target.checked)}
          data-testid="daily-digest"
        />
        Daily digest of what was sent
      </label>
      {showAllowlist ? (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="email-allowlist">
          <Field label="Approved addresses" hint="One per line. New recipients need your approval.">
            <textarea
              className={INPUT_CLASS}
              rows={3}
              value={addresses}
              onChange={(e) => setAddresses(e.target.value)}
              data-testid="allowlist-addresses"
            />
          </Field>
          <Field label="Approved domains" hint="One per line, e.g. partner.test or *.partner.test.">
            <textarea
              className={INPUT_CLASS}
              rows={3}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              data-testid="allowlist-domains"
            />
          </Field>
        </div>
      ) : null}
      <p className="text-xs text-neutral-500">
        Always on and not adjustable here: blocked content (credentials, private memory, other
        people's personal data, financial commitments, legal agreements), no paid sign-ups or terms
        without your approval, inbound mail treated as data.
      </p>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy} data-testid="limits-save">
          Save limits
        </Button>
        {saved ? (
          <output className="text-xs text-neutral-600" data-testid="limits-saved">
            Saved.
          </output>
        ) : null}
      </div>
    </form>
  );
}

function MailboxForm({
  agent,
  config,
  onSaved,
}: {
  agent: AgentView;
  config: EmailSettingsView;
  onSaved: (next: EmailSettingsView) => void;
}) {
  const m = config.settings.mailbox;
  const { busy, error, saved, save } = useSave(agent.id, onSaved);
  const [address, setAddress] = useState(m?.address ?? "");
  const [imapHost, setImapHost] = useState(m?.imap?.host ?? "");
  const [imapPort, setImapPort] = useState(String(m?.imap?.port ?? 993));
  const [imapUser, setImapUser] = useState(m?.imap?.user ?? "");
  const [imapRef, setImapRef] = useState(m?.imap?.passwordRef ?? "");
  const [smtpHost, setSmtpHost] = useState(m?.smtp?.host ?? "");
  const [smtpPort, setSmtpPort] = useState(String(m?.smtp?.port ?? 587));
  const [smtpUser, setSmtpUser] = useState(m?.smtp?.user ?? "");
  const [smtpRef, setSmtpRef] = useState(m?.smtp?.passwordRef ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = address.trim();
    void save({
      settings: {
        mailbox:
          trimmed === ""
            ? null
            : {
                address: trimmed,
                // The daemon replaces the mailbox whole (`mergeEmailConfig`), so the stored
                // values this form has no field for (TLS, the folders) are carried as they
                // are; otherwise a save of one field would reset them to the schema's defaults.
                imap:
                  imapHost.trim() === ""
                    ? null
                    : {
                        ...(m?.imap ?? {}),
                        host: imapHost.trim(),
                        port: asInt(imapPort, 993),
                        user: imapUser.trim(),
                        passwordRef: imapRef.trim(),
                      },
                smtp:
                  smtpHost.trim() === ""
                    ? null
                    : {
                        ...(m?.smtp ?? {}),
                        host: smtpHost.trim(),
                        port: asInt(smtpPort, 587),
                        user: smtpUser.trim(),
                        passwordRef: smtpRef.trim(),
                      },
              },
      },
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2" data-testid="email-mailbox">
      <h4 className="font-medium">Mailbox</h4>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        The agent's own address, never your personal inbox. Passwords are named by reference to the
        vault (<code>secret:&lt;name&gt;</code>), never typed here: the daemon refuses a value, and
        the names of the install's own credentials (API keys, tokens) are refused too.
        {m === null ? " No mailbox is configured yet; the mode does nothing until one is." : ""}
      </p>
      <Field label="Address">
        <input
          className={INPUT_CLASS}
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="alice@your-domain.example"
          data-testid="mailbox-address"
        />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1 rounded border border-neutral-200 p-2 dark:border-neutral-800">
          <p className="text-xs font-medium">IMAP (reading)</p>
          <input
            className={INPUT_CLASS}
            value={imapHost}
            onChange={(e) => setImapHost(e.target.value)}
            placeholder="host"
            aria-label="IMAP host"
            data-testid="imap-host"
          />
          <input
            className={INPUT_CLASS}
            type="number"
            value={imapPort}
            onChange={(e) => setImapPort(e.target.value)}
            aria-label="IMAP port"
          />
          <input
            className={INPUT_CLASS}
            value={imapUser}
            onChange={(e) => setImapUser(e.target.value)}
            placeholder="user"
            aria-label="IMAP user"
            data-testid="imap-user"
          />
          <input
            className={INPUT_CLASS}
            value={imapRef}
            onChange={(e) => setImapRef(e.target.value)}
            placeholder="secret:agent_imap_password"
            aria-label="IMAP password reference"
            data-testid="imap-ref"
          />
        </div>
        <div className="space-y-1 rounded border border-neutral-200 p-2 dark:border-neutral-800">
          <p className="text-xs font-medium">SMTP (sending)</p>
          <input
            className={INPUT_CLASS}
            value={smtpHost}
            onChange={(e) => setSmtpHost(e.target.value)}
            placeholder="host"
            aria-label="SMTP host"
            data-testid="smtp-host"
          />
          <input
            className={INPUT_CLASS}
            type="number"
            value={smtpPort}
            onChange={(e) => setSmtpPort(e.target.value)}
            aria-label="SMTP port"
          />
          <input
            className={INPUT_CLASS}
            value={smtpUser}
            onChange={(e) => setSmtpUser(e.target.value)}
            placeholder="user"
            aria-label="SMTP user"
            data-testid="smtp-user"
          />
          <input
            className={INPUT_CLASS}
            value={smtpRef}
            onChange={(e) => setSmtpRef(e.target.value)}
            placeholder="secret:agent_smtp_password"
            aria-label="SMTP password reference"
            data-testid="smtp-ref"
          />
        </div>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy} data-testid="mailbox-save">
          Save mailbox
        </Button>
        {saved ? (
          <output className="text-xs text-neutral-600" data-testid="mailbox-saved">
            Saved.
          </output>
        ) : null}
      </div>
    </form>
  );
}

function CommandsForm({
  agent,
  config,
  onSaved,
}: {
  agent: AgentView;
  config: EmailSettingsView;
  onSaved: (next: EmailSettingsView) => void;
}) {
  const client = useClient();
  const c = config.commands;
  const { busy, error, saved, save } = useSave(agent.id, onSaved);
  const [enabled, setEnabled] = useState(c.enabled);
  // The stored toggle can change under the form (a mode change to off turns commands off,
  // ADR 0081): the box follows it so it never shows commands on that are off.
  useEffect(() => setEnabled(c.enabled), [c.enabled]);
  const [humanAddress, setHumanAddress] = useState(c.registeredHumanAddress ?? "");
  const [dailyTaskCap, setDailyTaskCap] = useState(String(c.dailyTaskCap));
  const [autonomy, setAutonomy] = useState(String(c.autonomyLevel));
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      commands: {
        enabled,
        registeredHumanAddress: humanAddress.trim() === "" ? null : humanAddress.trim(),
        dailyTaskCap: asInt(dailyTaskCap, c.dailyTaskCap),
        autonomyLevel: Math.min(4, asInt(autonomy, c.autonomyLevel)),
      },
    });
  };
  const rotate = async () => {
    if (rotating) return;
    setRotating(true);
    setRotateError(null);
    try {
      const { marker } = await client.rotateEmailMarker(agent.id);
      onSaved({ ...config, commands: { ...config.commands, marker } });
    } catch (err) {
      setRotateError(describeError(err));
    } finally {
      setRotating(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2" data-testid="email-commands-settings">
      <h4 className="font-medium">Email commands (tasks by email, run in the cloud)</h4>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        A separate switch from the sending mode. Only mail from your registered address with the
        private marker in the subject, verified by DKIM and SPF, is obeyed; everything else is data
        and lands in the audit below.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="commands-enabled"
        />
        Obey commands emailed by me
      </label>
      <Field label="My address (the one whose mail is obeyed)">
        <input
          className={INPUT_CLASS}
          type="email"
          value={humanAddress}
          onChange={(e) => setHumanAddress(e.target.value)}
          data-testid="commands-human-address"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Private marker</span>
        <code
          className="rounded bg-neutral-100 px-1 dark:bg-neutral-800"
          data-testid="email-marker"
        >
          {c.marker}
        </code>
        <Button
          variant="secondary"
          onClick={() => void rotate()}
          disabled={rotating}
          data-testid="marker-rotate"
        >
          Rotate marker
        </Button>
        <span className="text-xs text-neutral-500">
          Put it in the subject of a command. Rotating stops the old one at once.
        </span>
        {rotateError ? <ErrorBanner message={rotateError} /> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Daily task cap" hint="Tasks started by email per day (default 10).">
          <input
            className={INPUT_CLASS}
            type="number"
            min={0}
            step={1}
            value={dailyTaskCap}
            onChange={(e) => setDailyTaskCap(e.target.value)}
            data-testid="commands-task-cap"
          />
        </Field>
        <Field label="Autonomy level for emailed tasks" hint="0 to 4 (default 2).">
          <input
            className={INPUT_CLASS}
            type="number"
            min={0}
            max={4}
            step={1}
            value={autonomy}
            onChange={(e) => setAutonomy(e.target.value)}
            data-testid="commands-autonomy"
          />
        </Field>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy} data-testid="commands-save">
          Save commands
        </Button>
        {saved ? (
          <output className="text-xs text-neutral-600" data-testid="commands-saved">
            Saved.
          </output>
        ) : null}
      </div>
    </form>
  );
}

function CommandAudit({ agent }: { agent: AgentView }) {
  const client = useClient();
  const commands = useAsync(
    (signal) => client.emailCommands(agent.id, { limit: 50 }, signal),
    [client, agent.id],
  );
  const rows = commands.data?.rows ?? [];
  return (
    <section className="space-y-1" data-testid="email-command-audit">
      <div className="flex items-baseline gap-2">
        <h4 className="font-medium">Command audit</h4>
        <span className="text-xs text-neutral-500">
          Every email command, its interpretation and its result, newest first.
        </span>
        <Button variant="ghost" onClick={commands.reload} className="ml-auto">
          Refresh
        </Button>
      </div>
      {commands.loading && !commands.data ? <Loading what="the command audit" /> : null}
      {commands.routeMissing ? (
        <RouteMissing route="emailCommands" what="the command audit" />
      ) : commands.error ? (
        <ErrorBanner message={commands.error} onRetry={commands.reload} />
      ) : null}
      {commands.data && rows.length === 0 ? (
        <EmptyState testId="email-command-empty">No email commands in the last 30 days.</EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1 pr-2">When</th>
              <th className="py-1 pr-2">From</th>
              <th className="py-1 pr-2">Subject</th>
              <th className="py-1 pr-2">Interpretation</th>
              <th className="py-1 pr-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const from = typeof row.email.from === "string" ? row.email.from : "—";
              const subject = typeof row.email.subject === "string" ? row.email.subject : "—";
              const reason = ignoredReason(row);
              return (
                <tr
                  key={row.id}
                  className="border-t border-neutral-100 align-top dark:border-neutral-800"
                  data-testid="email-command-row"
                  data-obeyed={String(row.obeyed)}
                >
                  <td className="py-1 pr-2 whitespace-nowrap">{formatDateTime(row.occurredAt)}</td>
                  <td className="py-1 pr-2 font-mono text-xs break-all" data-testid="command-from">
                    {from}
                  </td>
                  <td className="py-1 pr-2">{subject}</td>
                  <td className="py-1 pr-2" data-testid="command-interpretation">
                    {interpretationOf(row)}
                  </td>
                  <td className="py-1 pr-2" data-testid="command-result">
                    {row.obeyed ? (
                      <>
                        <Badge tone="good">obeyed</Badge> {resultOf(row)}
                      </>
                    ) : (
                      <>
                        <Badge tone="warn">ignored</Badge> {reason}
                      </>
                    )}
                    {row.sessionId ? (
                      <>
                        {" "}
                        <Link
                          to={`/sessions/${row.sessionId}`}
                          className="text-blue-700 hover:underline dark:text-blue-300"
                        >
                          session
                        </Link>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function SentLog({ agent }: { agent: AgentView }) {
  const client = useClient();
  const sent = useAsync(
    (signal) => client.emailSent(agent.id, { limit: 50 }, signal),
    [client, agent.id],
  );
  const rows: EmailSentRowView[] = sent.data?.rows ?? [];
  return (
    <section className="space-y-1" data-testid="email-sent">
      <div className="flex items-baseline gap-2">
        <h4 className="font-medium">Sent copies</h4>
        <span className="text-xs text-neutral-500">
          Every email sent, newest first, the last seven days.
        </span>
        <Button variant="ghost" onClick={sent.reload} className="ml-auto">
          Refresh
        </Button>
      </div>
      {sent.loading && !sent.data ? <Loading what="the sent copies" /> : null}
      {sent.routeMissing ? (
        <RouteMissing route="emailSent" what="the sent copies" />
      ) : sent.error ? (
        <ErrorBanner message={sent.error} onRetry={sent.reload} />
      ) : null}
      {sent.data && rows.length === 0 ? (
        <EmptyState testId="email-sent-empty">Nothing sent in the last seven days.</EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-neutral-100 p-2 dark:border-neutral-800"
              data-testid="email-sent-row"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-neutral-500">{formatDateTime(row.sentAt)}</span>
                <Badge>{row.kind}</Badge>
                <Badge tone={row.toHuman ? "neutral" : "info"}>
                  {row.toHuman ? "to you" : "to others"}
                </Badge>
                <span className="font-mono text-xs break-all">{row.to.join(", ")}</span>
              </div>
              <div className="font-medium">{row.subject}</div>
              <details>
                <summary className="cursor-pointer text-xs text-neutral-500">Copy as sent</summary>
                <pre className="mt-1 whitespace-pre-wrap text-xs">{row.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AgentEmailCard({ agent }: { agent: AgentView }) {
  const client = useClient();
  const settings = useAsync((signal) => client.emailSettings(agent.id, signal), [client, agent.id]);
  const config = settings.data;
  const replace = (next: EmailSettingsView) => settings.setData(() => next);

  return (
    <section
      className="space-y-4 rounded border border-neutral-200 p-3 dark:border-neutral-800"
      aria-labelledby={`email-agent-${agent.id}`}
      data-testid="email-agent"
      data-agent-id={agent.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`email-agent-${agent.id}`} className="font-semibold">
          {agent.name}
        </h3>
        <Badge>{agent.kind}</Badge>
        {config ? (
          <>
            <Badge tone={config.settings.mode === "off" ? "neutral" : "info"} testId="email-mode">
              {MODE_LABELS[config.settings.mode]}
            </Badge>
            <span className="text-xs text-neutral-500" data-testid="email-address">
              {config.settings.mailbox ? config.settings.mailbox.address : "no mailbox configured"}
            </span>
          </>
        ) : null}
      </div>
      {settings.loading && !config ? <Loading what={`email settings of ${agent.name}`} /> : null}
      {settings.routeMissing ? (
        <RouteMissing route="emailSettings" what={`the email settings of ${agent.name}`} />
      ) : settings.error ? (
        <ErrorBanner message={settings.error} onRetry={settings.reload} />
      ) : null}
      {config ? (
        <>
          <PauseControl
            agent={agent}
            config={config}
            onSaved={(paused) => replace({ ...config, settings: { ...config.settings, paused } })}
          />
          <ModePicker agent={agent} config={config} onChanged={settings.reload} />
          <LimitsForm
            key={`limits-${config.settings.mode}`}
            agent={agent}
            config={config}
            onSaved={replace}
          />
          <MailboxForm agent={agent} config={config} onSaved={replace} />
          <CommandsForm agent={agent} config={config} onSaved={replace} />
          <CommandAudit agent={agent} />
          <SentLog agent={agent} />
        </>
      ) : null}
    </section>
  );
}

/**
 * Settings -> Capabilities -> Email: one card per principal agent of the signed-in human. Email
 * is set here and nowhere else (U-075). The daemon reads the principal agent's mailbox only (the
 * email tools, the notifier's email channel, email commands), so the critic gets no card: a
 * mailbox set for it would be read by nothing.
 */
export function EmailSettingsPage() {
  const me = useUiState((s) => s.me);
  const agents = useUiState((s) => s.agents);
  const mine = me ? agents.filter((a) => a.ownerHumanId === me.id && a.kind === "principal") : [];

  return (
    <section aria-labelledby="email-settings-title" className="space-y-5">
      <nav className="text-xs text-neutral-500" aria-label="Breadcrumb">
        <Link to="/settings" className="hover:underline">
          Settings
        </Link>{" "}
        › Capabilities › Email
      </nav>
      <h1 id="email-settings-title" className="text-xl font-semibold">
        Email
      </h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="email-intro">
        Each agent can get its own mailbox, never your personal inbox. Pick a mode per agent: a mode
        change shows its change card and is confirmed on a paired device, like every other high-risk
        change. The limits below stay on in every sending mode, every change is audited, and the
        policy applies the new setting to the very next email.
      </p>
      {mine.length > 0 ? (
        <p className="text-xs text-neutral-500" data-testid="email-principal-only">
          Email is used by your agent ({mine.map((a) => a.name).join(", ")}) only; the critic
          reviews work and has no mailbox.
        </p>
      ) : null}
      {!me ? <Loading what="your agents" /> : null}
      {me && mine.length === 0 ? (
        <EmptyState testId="email-no-agents">
          No agent of yours is listed by this daemon.
        </EmptyState>
      ) : null}
      {mine.map((agent) => (
        <AgentEmailCard key={agent.id} agent={agent} />
      ))}
    </section>
  );
}
