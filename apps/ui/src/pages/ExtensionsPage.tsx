import { type FormEvent, useMemo, useState } from "react";
import { Link } from "react-router";
import { describeError, type ExtensionView, type VoiceStatusView } from "../api/client.ts";
import {
  type AddExtensionInput,
  type CatalogEntryView,
  EXTENSION_KINDS,
  type ExtensionKind,
  type ExtensionPermissions,
  type ManagedPlace,
} from "../api/contracts.ts";
import { Dialog } from "../components/Dialog.tsx";
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
  Money,
  type Tone,
} from "../components/ui.tsx";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

export const KIND_LABELS: Record<ExtensionKind, string> = {
  connector: "Connectors and MCP servers",
  skill: "Skills",
  specialist: "Specialists",
  capability: "Capabilities",
  model_provider: "Model providers",
};

export function statusTone(status: ExtensionView["status"]): Tone {
  switch (status) {
    case "enabled":
      return "good";
    case "pending_approval":
      return "warn";
    case "error":
      return "bad";
    default:
      return "neutral";
  }
}

const PERMISSION_LABELS: Record<keyof ExtensionPermissions, string> = {
  tools: "tools",
  actionClasses: "action classes",
  domains: "domains",
  paths: "paths",
  secrets: "secrets",
  scopes: "scopes",
};

/** "2 tools · 1 domain · 1 secret" for a row; the details list every value. */
export function summarizePermissions(p: ExtensionPermissions): string {
  const parts = (Object.keys(PERMISSION_LABELS) as Array<keyof ExtensionPermissions>)
    .filter((k) => p[k].length > 0)
    .map((k) => `${p[k].length} ${PERMISSION_LABELS[k]}`);
  return parts.length === 0 ? "no permissions" : parts.join(" · ");
}

/** Where a row another screen owns is set (U-075), as the row's link says it. */
const MANAGED_LINKS: Record<ManagedPlace, { to: string; label: string }> = {
  email: { to: "/settings/capabilities/email", label: "set on the Email page" },
};

const VOICE_SIDES = ["stt", "tts"] as const;
const SIDE_LABELS: Record<(typeof VOICE_SIDES)[number], string> = { stt: "STT", tts: "TTS" };

/**
 * What the daemon's voice status says about one cloud `voice-*` row (spec O.4): in force for a
 * side (the pick is any provider the row stands for), preferred but not usable (the pick fell
 * back, with the registry's reason), or not in force with the reason the daemon gives (switched
 * off, no key or key not granted, another row preferred, an override). Which providers are in
 * force overall is shown in Settings -> Voice (U-023).
 */
export function voiceBadges(
  extension: Pick<ExtensionView, "id">,
  voice: VoiceStatusView | null,
): { tone: Tone; text: string }[] {
  if (!voice) return [];
  const out: { tone: Tone; text: string }[] = [];
  for (const side of VOICE_SIDES) {
    const preferred = voice.preferences[side];
    if (preferred?.extensionId !== extension.id) continue;
    const pick = voice[side];
    const inForce =
      pick !== null && (pick.name === preferred.name || preferred.providers.includes(pick.name));
    out.push(
      inForce
        ? { tone: "good", text: `in force for ${SIDE_LABELS[side]}` }
        : {
            tone: "warn",
            text: `preferred for ${SIDE_LABELS[side]}, not in force: ${pick?.reason ?? voice.reason}`,
          },
    );
  }
  for (const s of voice.preferences.skipped) {
    if (s.extensionId !== extension.id) continue;
    out.push({ tone: "warn", text: `not in force for ${SIDE_LABELS[s.side]}: ${s.reason}` });
  }
  return out;
}

function PermissionList({ permissions }: { permissions: ExtensionPermissions }) {
  const keys = (Object.keys(PERMISSION_LABELS) as Array<keyof ExtensionPermissions>).filter(
    (k) => permissions[k].length > 0,
  );
  if (keys.length === 0) return <p className="text-xs text-neutral-500">No permissions.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {keys.map((k) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500">{PERMISSION_LABELS[k]}</dt>
          <dd className="font-mono break-all">
            {k === "secrets"
              ? permissions[k].map((s) => `secret:${s}`).join(", ")
              : permissions[k].join(", ")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The change card of a grant (U-026): what the extension may do once granted, as the daemon
 * reviewed it: the step, the risk, the summary, every tool with its class and risk, and the
 * tools, action classes, domains, paths, secrets and scopes it is granted.
 */
function GrantCard({ extension }: { extension: ExtensionView }) {
  const e = extension;
  const review = e.review;
  const risk = review?.risk ?? "high";
  const permissions = e.pendingPermissions ?? review?.permissions ?? e.permissions;
  return (
    <div
      className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-700"
      data-testid="grant-card"
      data-risk={risk}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{e.name}</span>
        <Badge>{e.kind.replace("_", " ")}</Badge>
        {e.version ? <span className="text-xs text-neutral-500">v{e.version}</span> : null}
        <Badge tone={risk === "high" ? "bad" : risk === "medium" ? "warn" : "neutral"}>
          {risk} risk
        </Badge>
      </div>
      <p className="mt-1 text-xs" data-testid="grant-stage">
        {e.pendingStage === "discovery"
          ? "Step 1 of 2: start it once so it lists its tools, with the secrets it names. Nothing is granted yet; you confirm the grant next."
          : "Grant: from now on your agents may use what is listed below."}
      </p>
      {review && review.summary.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {review.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
      {review && review.tools.length > 0 ? (
        <ul className="mt-1 text-xs" data-testid="grant-tools">
          {review.tools.map((t) => (
            <li key={t.bridgedName} className="font-mono">
              {t.bridgedName}{" "}
              <span className="font-sans text-neutral-500">
                ({t.actionClass}, {t.risk} risk)
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2" data-testid="grant-permissions">
        <PermissionList permissions={permissions} />
      </div>
    </div>
  );
}

/**
 * The panel's confirmation of a grant (U-026, ADR 0096). Add on a built-in catalog entry opens
 * it with the change card; Confirm sends a device answer (this PC is a paired device, ADR 0030)
 * that the daemon checks like any high-risk change, and grants it with no Inbox card. After a
 * discovery step the card is shown again with the tools found, for the grant. Cancel on an Add
 * takes the row back, so nothing is added; opened from a row's Approve it only closes.
 */
function ConfirmGrantDialog({
  extension,
  fromAdd,
  onUpdated,
  onDone,
  onClose,
}: {
  extension: ExtensionView;
  /** Opened by Add: Cancel (or closing the dialog) takes the row back. */
  fromAdd: boolean;
  onUpdated: (view: ExtensionView) => void;
  onDone: (view: ExtensionView) => void;
  onClose: (removed: boolean) => void;
}) {
  const client = useClient();
  const desktopDeviceId = useUiState((s) => s.me?.desktopDeviceId ?? null);
  const [current, setCurrent] = useState(extension);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // A high-risk change is confirmed on a paired device; without `/me`'s id the daemon
      // answers with this PC's own row, as for a change card.
      const next = await client.approveExtension(current.id, {
        answer: "device",
        ...(desktopDeviceId ? { deviceId: desktopDeviceId } : {}),
      });
      if (next.status === "pending_approval") {
        setCurrent(next);
        onUpdated(next);
      } else onDone(next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    if (!fromAdd) {
      onClose(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.denyExtension(current.id);
      onClose(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => void cancel()}
      title={`Add ${current.name}?`}
      testId="grant-dialog"
      wide
    >
      <div className="space-y-3 text-sm">
        <GrantCard extension={current} />
        <p
          className="text-xs text-neutral-600 dark:text-neutral-400"
          data-testid="grant-needs-device"
        >
          High risk: granting a capability is confirmed in the app on a paired device, and this PC
          counts as one. Nothing is granted until you confirm
          {fromAdd ? "; Cancel adds nothing" : ""}.
        </p>
        {error ? <ErrorBanner message={error} testId="grant-error" /> : null}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => void confirm()}
            disabled={busy}
            data-testid="grant-confirm"
          >
            {current.pendingStage === "discovery"
              ? "Start it once on this device"
              : "Confirm on this device"}
          </Button>
          <Button onClick={() => void cancel()} disabled={busy} data-testid="grant-cancel">
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ExtensionRow({
  extension,
  voice,
  onChange,
  onRemoved,
  onApprove,
}: {
  extension: ExtensionView;
  /** The daemon's voice status, for the `voice-*` rows' "in force" badges. */
  voice: VoiceStatusView | null;
  onChange: (next: ExtensionView) => void;
  onRemoved: (id: string) => void;
  /** Approve opens the confirmation with the change card (U-026). */
  onApprove: (extension: ExtensionView) => void;
}) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const e = extension;
  const pending = e.status === "pending_approval";
  const voiceState = voiceBadges(e, voice);
  // Set on another screen (U-075): no switch and no Remove here, a pointer there instead.
  const managed = e.managedIn ? MANAGED_LINKS[e.managedIn] : null;

  const run = async (action: () => Promise<ExtensionView | undefined>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) onChange(next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
      data-testid="extension"
      data-extension-id={e.id}
      data-kind={e.kind}
      data-status={e.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{e.name}</span>
        {e.version ? <span className="text-xs text-neutral-500">v{e.version}</span> : null}
        <Badge tone={statusTone(e.status)} testId="extension-status">
          {e.status.replace("_", " ")}
        </Badge>
        {e.kind === "connector" ? (
          <Badge tone={e.connected ? "good" : "neutral"}>
            {e.connected ? "connected" : "not connected"}
          </Badge>
        ) : null}
        {voiceState.map((b) => (
          <Badge key={b.text} tone={b.tone} testId="extension-voice">
            {b.text}
          </Badge>
        ))}
        <span className="text-xs text-neutral-500" title="Spend attributed to this extension">
          cost <Money value={e.cost} />
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {managed ? (
            <Link
              to={managed.to}
              className="text-xs text-blue-700 hover:underline dark:text-blue-300"
              data-testid="extension-managed"
            >
              {managed.label}
            </Link>
          ) : pending ? (
            <>
              <Button
                variant="primary"
                onClick={() => onApprove(e)}
                disabled={busy}
                data-testid="extension-approve"
              >
                Approve
              </Button>
              <Button
                onClick={() =>
                  void run(async () => {
                    await client.denyExtension(e.id);
                    onRemoved(e.id);
                    return undefined;
                  })
                }
                disabled={busy}
                data-testid="extension-deny"
              >
                Deny
              </Button>
            </>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={e.enabled}
              aria-label={`${e.enabled ? "Disable" : "Enable"} ${e.name}`}
              onClick={() => void run(() => client.toggleExtension(e.id, !e.enabled))}
              disabled={busy}
              data-testid="extension-toggle"
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${
                e.enabled
                  ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200"
                  : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {e.enabled ? "On" : "Off"}
            </button>
          )}
          {managed ? null : confirmRemove ? (
            <>
              <Button
                variant="danger"
                onClick={() =>
                  void run(async () => {
                    await client.removeExtension(e.id);
                    onRemoved(e.id);
                    return undefined;
                  })
                }
                disabled={busy}
                data-testid="extension-remove-confirm"
              >
                Confirm remove
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
              data-testid="extension-remove"
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-neutral-600 dark:text-neutral-400">{e.description}</p>
      {e.error ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{e.error}</p> : null}
      {pending && e.review ? (
        <div
          className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950"
          data-testid="extension-review"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium" data-testid="extension-stage">
              {e.pendingStage === "discovery"
                ? "Waiting for you to allow discovery (the connector starts once, with the secrets it names)"
                : "Waiting for your approval of the grant"}
            </span>
            <Badge
              tone={
                e.review.risk === "high" ? "bad" : e.review.risk === "medium" ? "warn" : "neutral"
              }
            >
              {e.review.risk} risk
            </Badge>
            {e.confirmIn === "panel" ? (
              <span
                className="text-neutral-600 dark:text-neutral-400"
                data-testid="extension-confirm-here"
              >
                confirmed here with Approve, not in the inbox
              </span>
            ) : (
              <Link to="/inbox" className="text-blue-700 hover:underline dark:text-blue-300">
                also in the inbox
              </Link>
            )}
          </div>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {e.review.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {e.review.tools.length > 0 ? (
            <ul className="mt-1 text-xs">
              {e.review.tools.map((t) => (
                <li key={t.bridgedName} className="font-mono">
                  {t.bridgedName}{" "}
                  <span className="font-sans text-neutral-500">
                    ({t.actionClass}, {t.risk} risk)
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs">Permissions requested:</p>
          <PermissionList permissions={e.pendingPermissions ?? e.review.permissions} />
        </div>
      ) : null}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-neutral-500" data-testid="extension-permissions">
          Permissions: {summarizePermissions(e.permissions)}
        </summary>
        <div className="mt-1">
          <PermissionList permissions={e.permissions} />
          <p className="mt-1 text-neutral-500">
            {e.source ? `source ${e.source} · ` : ""}installed {formatDateTime(e.installedAt)}
          </p>
        </div>
      </details>
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} testId="extension-error" />
        </div>
      ) : null}
    </li>
  );
}

function AddExtensionDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (view: ExtensionView) => void;
}) {
  const client = useClient();
  const catalog = useAsync(
    (signal) => (open ? client.extensionCatalog(signal) : Promise.resolve(null)),
    [client, open],
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog.data?.entries ?? []).filter(
      (e: CatalogEntryView) =>
        (kind === "all" || e.kind === kind) &&
        (!q || `${e.name} ${e.description} ${e.tags.join(" ")}`.toLowerCase().includes(q)),
    );
  }, [catalog.data, query, kind]);

  const add = async (body: AddExtensionInput, key: string) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const view = await client.addExtension(body);
      onAdded(view);
      setUrl("");
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const addUrl = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) void add({ url: url.trim() }, "url");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an extension"
      testId="add-extension-dialog"
      wide
    >
      <div className="space-y-3">
        <form onSubmit={addUrl} className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Field
              label="From a URL (MCP server)"
              hint="Started for discovery only after your yes in the Inbox, then reviewed there again for the grant."
            >
              <input
                className={INPUT_CLASS}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.test/mcp"
                data-testid="add-url"
              />
            </Field>
          </div>
          <Button
            type="submit"
            disabled={busy !== null || !url.trim()}
            data-testid="add-url-submit"
          >
            Add from URL
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">From the catalog</h3>
          <input
            className={`${INPUT_CLASS} w-48`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search the catalog"
            data-testid="catalog-search"
          />
          <select
            className={`${INPUT_CLASS} w-auto`}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Filter by kind"
            data-testid="catalog-kind"
          >
            <option value="all">all kinds</option>
            {EXTENSION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          {catalog.data?.remoteUrl ? (
            <span className="text-xs text-neutral-500">from {catalog.data.remoteUrl}</span>
          ) : null}
        </div>
        {catalog.loading && !catalog.data ? <Loading what="catalog" /> : null}
        {catalog.error ? <ErrorBanner message={catalog.error} onRetry={catalog.reload} /> : null}
        <ul className="max-h-80 space-y-1 overflow-auto" data-testid="catalog">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800"
              data-testid="catalog-entry"
              data-catalog-id={e.id}
            >
              <span className="font-medium">{e.name}</span>
              <Badge>{e.kind.replace("_", " ")}</Badge>
              {e.version ? <span className="text-xs text-neutral-500">v{e.version}</span> : null}
              <span className="w-full text-xs text-neutral-600 md:w-auto md:flex-1 dark:text-neutral-400">
                {e.description}
              </span>
              <span className="text-xs text-neutral-500">
                {summarizePermissions(e.permissions)}
              </span>
              <Button
                variant="primary"
                onClick={() => void add({ catalogId: e.id, confirmIn: "panel" }, e.id)}
                disabled={busy !== null}
                data-testid="catalog-add"
              >
                {busy === e.id ? "Adding…" : "Add"}
              </Button>
            </li>
          ))}
          {catalog.data && entries.length === 0 ? (
            <li className="text-sm text-neutral-500">Nothing matches.</li>
          ) : null}
        </ul>
        {error ? <ErrorBanner message={error} /> : null}
      </div>
    </Dialog>
  );
}

/**
 * Extensions panel (spec K.6, L.5): every connector, MCP server, skill, specialist, capability
 * and model provider with status, permissions, cost, version, toggle, remove, and add from the
 * catalog or a URL. Connectors and permission widenings wait for the human's approval (202);
 * the list reloads on every `extension.changed` frame from the daemon. Each cloud `voice-*`
 * row says whether it is the one in force, or why not, following every change in the list;
 * local voice and the providers in force are in Settings -> Voice, and the model provider in
 * the setup (U-023: one place for each thing).
 */
export function ExtensionsPage() {
  const client = useClient();
  const version = useUiState((s) => s.extensionsVersion);
  const extensions = useAsync((signal) => client.extensions(undefined, signal), [client, version]);
  const voice = useAsync((signal) => client.voiceStatus(signal), [client, version]);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("all");
  /** The grant being confirmed in the panel (U-026), and whether Add opened it. */
  const [confirming, setConfirming] = useState<{
    extension: ExtensionView;
    fromAdd: boolean;
  } | null>(null);

  const upsert = (next: ExtensionView) => {
    extensions.setData((prev) => {
      const rows = prev ?? [];
      return rows.some((e) => e.id === next.id)
        ? rows.map((e) => (e.id === next.id ? next : e))
        : [...rows, next];
    });
    // A toggle may change which voice provider the next session uses.
    voice.reload();
  };
  const drop = (id: string) => {
    extensions.setData((prev) => (prev ?? []).filter((e) => e.id !== id));
    // Removing a voice row changes which provider the next session uses, as a toggle does.
    voice.reload();
  };

  const rows = extensions.data ?? [];
  const pending = rows.filter((e) => e.status === "pending_approval").length;
  const grouped = EXTENSION_KINDS.filter((k) => kindFilter === "all" || k === kindFilter).map(
    (k) => ({
      kind: k,
      rows: rows.filter((e) => e.kind === k),
    }),
  );

  return (
    <section aria-labelledby="extensions-title" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 id="extensions-title" className="text-xl font-semibold">
          Extensions
        </h1>
        <Badge testId="extensions-count">
          {rows.filter((e) => e.enabled).length} of {rows.length} enabled
        </Badge>
        {pending > 0 ? (
          <Badge tone="warn" testId="extensions-pending">
            {pending} waiting for your approval
          </Badge>
        ) : null}
        <select
          className={`${INPUT_CLASS} ml-auto w-auto`}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          aria-label="Show kind"
          data-testid="extensions-kind"
        >
          <option value="all">all kinds</option>
          {EXTENSION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={() => setAddOpen(true)} data-testid="add-extension">
          Add
        </Button>
      </div>
      {notice ? (
        <output
          className="block rounded border border-blue-200 p-2 text-sm dark:border-blue-900"
          data-testid="extensions-notice"
        >
          {notice}
        </output>
      ) : null}
      {extensions.loading && !extensions.data ? <Loading what="extensions" /> : null}
      {extensions.error && !extensions.data ? (
        <ErrorBanner message={extensions.error} onRetry={extensions.reload} />
      ) : null}
      {grouped.map((g) => (
        <div key={g.kind} data-testid={`extensions-group-${g.kind}`}>
          <h2 className="font-semibold">{KIND_LABELS[g.kind]}</h2>
          {g.kind === "capability" ? (
            <p
              className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
              data-testid="extensions-voice-pointer"
            >
              Local voice is installed and chosen in{" "}
              <Link to="/settings" className="text-blue-700 hover:underline dark:text-blue-300">
                Settings → Voice
              </Link>
              , which also shows the voice providers in force. A cloud voice capability here
              (voice-deepgram, voice-cartesia, voice-elevenlabs) is used instead while it is on; it
              needs its key.
            </p>
          ) : null}
          {g.kind === "model_provider" ? (
            <p
              className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
              data-testid="extensions-model-pointer"
            >
              The model provider and its API key or subscription token are set in Settings (the
              setup); nothing here changes them.
            </p>
          ) : null}
          {g.rows.length === 0 ? (
            g.kind === "model_provider" ? null : (
              <p className="text-xs text-neutral-500">None installed.</p>
            )
          ) : (
            <ul className="mt-1 space-y-2">
              {g.rows.map((e) => (
                <ExtensionRow
                  key={e.id}
                  extension={e}
                  voice={voice.data}
                  onChange={upsert}
                  onRemoved={drop}
                  onApprove={(view) => setConfirming({ extension: view, fromAdd: false })}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
      <AddExtensionDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(view) => {
          upsert(view);
          // A built-in entry added here is confirmed here, with its change card (U-026).
          if (view.status === "pending_approval" && view.confirmIn === "panel") {
            setNotice(null);
            setConfirming({ extension: view, fromAdd: true });
            return;
          }
          setNotice(
            view.status === "pending_approval"
              ? `${view.name} was added and waits for your approval: review its permissions below or in the inbox.`
              : `${view.name} was added and is enabled.`,
          );
        }}
      />
      {confirming ? (
        <ConfirmGrantDialog
          key={confirming.extension.id}
          extension={confirming.extension}
          fromAdd={confirming.fromAdd}
          onUpdated={upsert}
          onDone={(view) => {
            upsert(view);
            setConfirming(null);
            setNotice(`${view.name} is added and enabled.`);
          }}
          onClose={(removed) => {
            const name = confirming.extension.name;
            setConfirming(null);
            if (removed) {
              drop(confirming.extension.id);
              setNotice(`Cancelled: ${name} was not added.`);
            }
          }}
        />
      ) : null}
    </section>
  );
}
