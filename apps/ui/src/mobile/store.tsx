import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ShellInjection } from "../api/config.ts";
import {
  createStateClient,
  describeStateError,
  type FetchLike,
  type HumanRequestView,
  type InboxView,
  type MessageView,
  newClientId,
  type PlanCommand,
  type ProjectCard,
  type RemoteChatEnvelope,
  type RemoteCommandView,
  type RemotePlanEnvelope,
  type RemoteVoiceEnvelope,
  type ReviewVerdictResult,
  type ReviewView,
  StateApiError,
  type StateClient,
  type UploadFile,
  type UploadView,
  verbForPlan,
} from "../api/state-client.ts";
import {
  type BiometricAssertion,
  type BiometricPort,
  BiometricRefusedError,
  type DeviceSigner,
  failureText,
  type SignOptions,
  simulatedBiometric,
  TicketBook,
  WebCryptoSigner,
} from "../api/state-signing.ts";
import {
  type StateStreamSubscription,
  type SyncMode,
  subscribeStateEvents,
} from "../api/state-sse.ts";
import {
  NO_KEYRING_REASON,
  noKeyringBridge,
  type PreparedAnswer,
  type RunnerKeyBridge,
  secureStoreRunnerKeys,
} from "../lib/runner-unlock.ts";
import {
  buildPlanCard,
  type CardContext,
  chfPerUsdFrom,
  inversePlan,
  type MobileChangeCard,
} from "./change-card.ts";
import { type ChangeEntry, ChangeLog } from "./change-log.ts";
import { LocalOutbox } from "./outbox.ts";
import { type PairingPayload, parsePairingPayload } from "./pairing.ts";
import {
  noticeFor,
  PollingPush,
  type PushNotice,
  type PushPort,
  type PushStatus,
  type QuietHours,
} from "./push.ts";
import {
  inTauriShell,
  ShellSigner,
  scanQr,
  shellBiometric,
  shellDeepLink,
  shellPush,
  shellSecureStore,
} from "./shell-bridge.ts";
import {
  browserSecureStore,
  type MobileStorage,
  mobileKey,
  mobileStorage,
  readJson,
  type SecureStore,
  writeJson,
} from "./storage.ts";
import { deviceTimezone, localParts } from "./time.ts";
import { UploadQueue } from "./uploads.ts";
import {
  encodeTurn,
  type RecordedTurn,
  type Speaker,
  type VoiceRecorder,
  webRecorder,
  webSpeaker,
} from "./voice.ts";

/**
 * The phone's state and actions (spec R). One controller owns the state-service client, the
 * change feed, the offline outbox and the change log; screens read the state through
 * `useMobile()` and call actions. Everything the phone persists is listed in `storage.ts`;
 * the token lives in the secure store only and never enters this state object.
 */
export type Stage = "loading" | "unpaired" | "paired";

export interface MobileSessionInfo {
  baseUrl: string;
  deviceId: string;
  humanId: string;
  humanName: string | null;
  scopes: string[];
  expiresAt: string;
  deviceName: string;
  pairedAt: string;
  /** The human's monthly hard cap in CHF micro, from `/me` when the service sends it; null = unknown. */
  monthlyCapChfMicro?: number | null;
}

export interface BiometricPrompt {
  reason: string;
  resolve: (ok: boolean) => void;
}

export interface MobileState {
  stage: Stage;
  session: MobileSessionInfo | null;
  projects: ProjectCard[];
  projectsLoaded: boolean;
  activeProjectId: string | null;
  inbox: InboxView | null;
  blockingCount: number;
  syncMode: SyncMode;
  lastHeartbeatAt: string | null;
  /** The last problem worth a banner; null when fine. */
  notice: string | null;
  outboxPending: number;
  notices: PushNotice[];
  push: PushStatus | null;
  biometricAvailable: boolean;
  /** A simulated biometric prompt waiting for the human (web and tests only). */
  biometricPrompt: BiometricPrompt | null;
  /** Bumped whenever the change log changes, so screens re-render. */
  changeLogVersion: number;
  quietHours: QuietHours;
  /** Pairing details a deep link or scan pre-filled. */
  pendingPairing: PairingPayload | null;
  secureStoreKind: SecureStore["kind"];
  inShell: boolean;
  shellVersion: string | null;
  /** The cloud runner auto-unlock window this phone set with an answer (ADR 0068), or null. */
  unlockWindowUntil: string | null;
}

export type MobileAction =
  | { type: "patch"; patch: Partial<MobileState> }
  | { type: "projects"; projects: ProjectCard[] }
  | { type: "project.upsert"; project: ProjectCard }
  | { type: "inbox"; inbox: InboxView }
  | { type: "notice.push"; notice: PushNotice }
  | { type: "changeLog.bump" };

export interface MobileStore {
  getState(): MobileState;
  subscribe(listener: () => void): () => void;
  dispatch(action: MobileAction): void;
}

export function initialMobileState(partial: Partial<MobileState> = {}): MobileState {
  return {
    stage: "loading",
    session: null,
    projects: [],
    projectsLoaded: false,
    activeProjectId: null,
    inbox: null,
    blockingCount: 0,
    syncMode: "closed",
    lastHeartbeatAt: null,
    notice: null,
    outboxPending: 0,
    notices: [],
    push: null,
    biometricAvailable: false,
    biometricPrompt: null,
    changeLogVersion: 0,
    quietHours: { from: null, to: null },
    pendingPairing: null,
    secureStoreKind: "memory",
    inShell: false,
    shellVersion: null,
    unlockWindowUntil: null,
    ...partial,
  };
}

export function reduceMobile(state: MobileState, action: MobileAction): MobileState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.patch };
    case "projects": {
      const projects = action.projects;
      let activeProjectId = state.activeProjectId;
      if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
        activeProjectId = projects.find((p) => p.active)?.id ?? projects[0]?.id ?? null;
      }
      return { ...state, projects, projectsLoaded: true, activeProjectId };
    }
    case "project.upsert": {
      const exists = state.projects.some((p) => p.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
          : [...state.projects, action.project],
      };
    }
    case "inbox":
      return { ...state, inbox: action.inbox, blockingCount: action.inbox.blockingCount };
    case "notice.push":
      return { ...state, notices: [action.notice, ...state.notices].slice(0, 20) };
    case "changeLog.bump":
      return { ...state, changeLogVersion: state.changeLogVersion + 1 };
    default:
      return state;
  }
}

export function createMobileStore(initial: MobileState): MobileStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const next = reduceMobile(state, action);
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
  };
}

/** Everything the controller depends on; the shell or a test fills it. */
export interface MobileEnv {
  installId: string | null;
  platform: string | null;
  shellVersion: string | null;
  inShell: boolean;
  /** The service URL the shell was given (deep link, build config); the pairing screen can edit it. */
  defaultStateUrl: string | null;
  defaultDeviceName: string;
  signer: DeviceSigner;
  secure: SecureStore;
  storage: MobileStorage;
  /** A platform port, or "prompt" for the visible simulated dialog the provider renders. */
  biometric: BiometricPort | "prompt";
  /** How long a high-risk answer waits for the prompt before it counts as refused (60 s). */
  biometricTimeoutMs?: number;
  push: PushPort;
  /**
   * Where the cloud runner's vault key is (spec S.12, ADR 0068): the shell's Keystore-wrapped
   * secure store on Android; without a keyring the unlock card is read-only. Defaults from
   * `inShell` and `secure` when omitted.
   */
  runnerKeys?: RunnerKeyBridge;
  fetch?: FetchLike;
  now: () => number;
  timezone: string;
  scan: (() => Promise<string | null>) | null;
  deepLink: {
    current(): Promise<string | null>;
    listen(cb: (url: string) => void): () => void;
  } | null;
  /**
   * Push-to-talk capture (ADR 0080); absent or null when this page cannot record, and the
   * Chat screen relays the typed line instead.
   */
  recorder?: VoiceRecorder | null;
  /** Speaks the PC's reply to a voice turn; absent or null = shown only. */
  speaker?: Speaker | null;
  /** Stream options passed through to the change feed. */
  live?: boolean;
  pollIntervalMs?: number;
  retryLiveMs?: number;
}

const SESSION_KEY = "session";
const TOKEN_KEY = "session-token";
const ACTIVE_KEY = "activeProject";
const QUIET_KEY = "quietHours";
const CHANGES_KEY = "changes";
const OUTBOX_KEY = "outbox";
const UNLOCK_WINDOW_KEY = "runnerUnlockWindow";
/**
 * A biometric prompt that has not answered by then is a refusal: long enough to touch the
 * sensor and confirm, and well inside the emulator smoke's 180 s wait for the refusal.
 */
export const BIOMETRIC_TIMEOUT_MS = 60_000;
const UPLOADS_KEY = "uploads";

let webSigner: Promise<WebCryptoSigner> | null = null;
/** One ticket book for the page: the simulated prompt issues, the lazily made signer redeems. */
const webTickets = new TicketBook();

/** The env for a real page load: the Tauri shell when present, else WebCrypto and browser storage. */
export function envFromGlobals(injection: ShellInjection | undefined): MobileEnv {
  const shell = inTauriShell();
  const signer: DeviceSigner = shell
    ? new ShellSigner()
    : {
        kind: "webcrypto",
        tickets: webTickets,
        publicKey: () => webCryptoSigner().then((s) => s.publicKey()),
        sign: (m: Uint8Array, o?: SignOptions) => webCryptoSigner().then((s) => s.sign(m, o)),
        forget: async () => {
          const s = await webCryptoSigner();
          await s.forget();
          webSigner = null;
        },
      };
  return {
    installId: injection?.installId ?? null,
    platform: injection?.platform ?? null,
    shellVersion: injection?.shellVersion ?? null,
    inShell: shell,
    defaultStateUrl: injection?.stateUrl ?? null,
    defaultDeviceName: injection?.deviceName ?? (shell ? "Android phone" : "Web browser"),
    signer,
    secure: shell ? shellSecureStore : browserSecureStore(),
    storage: mobileStorage(),
    biometric: shell ? shellBiometric : "prompt",
    push: shell ? shellPush : new PollingPush(),
    runnerKeys: shell
      ? secureStoreRunnerKeys(shellSecureStore)
      : noKeyringBridge(NO_KEYRING_REASON),
    now: () => Date.now(),
    timezone: deviceTimezone(),
    scan: shell ? scanQr : null,
    deepLink: shell ? shellDeepLink : null,
    // The shell has no microphone command yet (ADR 0080): there the typed line is relayed.
    recorder: shell ? null : webRecorder(),
    speaker: webSpeaker(),
  };
}

function webCryptoSigner(): Promise<WebCryptoSigner> {
  if (!webSigner) webSigner = WebCryptoSigner.generate({ tickets: webTickets });
  return webSigner;
}

export interface SendPlanInput {
  words: string;
  plan: PlanCommand[];
  source: ChangeEntry["source"];
  /** The card the human confirmed (built by `planCard`); rebuilt when absent. */
  card?: MobileChangeCard;
  undoOf?: string;
}

export interface SendPlanResult {
  entry: ChangeEntry;
  queued: boolean;
}

export class MobileController {
  readonly store: MobileStore;
  readonly changeLog: ChangeLog;
  readonly outbox: LocalOutbox;
  readonly uploads: UploadQueue;
  readonly biometric: BiometricPort;
  readonly runnerKeys: RunnerKeyBridge;
  private client: StateClient;
  private stream: StateStreamSubscription | null = null;
  private inboxReload: ReturnType<typeof setTimeout> | null = null;
  private stopDeepLink: (() => void) | null = null;
  private closed = false;
  private losingAuth = false;

  constructor(readonly env: MobileEnv) {
    const installId = env.installId;
    this.store = createMobileStore(
      initialMobileState({
        activeProjectId: env.storage.get(mobileKey(installId, ACTIVE_KEY)),
        quietHours: readJson<QuietHours>(env.storage, mobileKey(installId, QUIET_KEY), {
          from: null,
          to: null,
        }),
        secureStoreKind: env.secure.kind,
        inShell: env.inShell,
        shellVersion: env.shellVersion,
        unlockWindowUntil: env.storage.get(mobileKey(installId, UNLOCK_WINDOW_KEY)),
      }),
    );
    this.runnerKeys =
      env.runnerKeys ??
      (env.inShell ? secureStoreRunnerKeys(env.secure) : noKeyringBridge(NO_KEYRING_REASON));
    this.changeLog = new ChangeLog(env.storage, mobileKey(installId, CHANGES_KEY));
    this.outbox = new LocalOutbox(env.storage, mobileKey(installId, OUTBOX_KEY));
    this.uploads = new UploadQueue(env.storage, mobileKey(installId, UPLOADS_KEY));
    if (env.biometric === "prompt") {
      const tickets = env.signer.tickets;
      if (!tickets) {
        throw new Error("the simulated biometric prompt needs a signer that issues tickets");
      }
      this.biometric = simulatedBiometric(
        (reason) =>
          new Promise<boolean>((resolve) => {
            this.store.dispatch({
              type: "patch",
              patch: {
                biometricPrompt: {
                  reason,
                  resolve: (ok) => {
                    this.store.dispatch({ type: "patch", patch: { biometricPrompt: null } });
                    resolve(ok);
                  },
                },
              },
            });
          }),
        { tickets, now: env.now },
      );
    } else {
      this.biometric = env.biometric;
    }
    this.client = createStateClient(
      { baseUrl: env.defaultStateUrl ?? "http://127.0.0.1:8788", token: null },
      env.signer,
      { fetch: env.fetch, now: env.now },
    );
    this.store.dispatch({ type: "patch", patch: { outboxPending: this.pendingCount() } });
  }

  /** Queued actions plus queued uploads: what the header's "n queued" counts. */
  pendingCount(): number {
    return this.outbox.size() + this.uploads.size();
  }

  get state(): MobileState {
    return this.store.getState();
  }

  /** The client for the current session (tests inspect it); never exposes the token. */
  get api(): StateClient {
    return this.client;
  }

  private patch(patch: Partial<MobileState>): void {
    this.store.dispatch({ type: "patch", patch });
  }

  private bumpChanges(): void {
    this.store.dispatch({ type: "changeLog.bump" });
  }

  private note(notice: string | null): void {
    this.patch({ notice });
  }

  // ---------------------------------------------------------------------------------
  // Lifecycle

  async bootstrap(): Promise<void> {
    // React StrictMode mounts twice in development: a closed controller may be reopened.
    this.closed = false;
    const saved = readJson<MobileSessionInfo | null>(
      this.env.storage,
      mobileKey(this.env.installId, SESSION_KEY),
      null,
    );
    let token: string | null = null;
    try {
      token = await this.env.secure.get(TOKEN_KEY);
    } catch {
      token = null;
    }
    void this.env.push
      .status()
      .then((push) => this.patch({ push }))
      .catch(() => {});
    void this.biometric
      .available()
      .then((ok) => this.patch({ biometricAvailable: ok }))
      .catch(() => {});
    if (this.env.deepLink) {
      const current = await this.env.deepLink.current().catch(() => null);
      if (current) this.offerPairing(current);
      this.stopDeepLink = this.env.deepLink.listen((url) => this.offerPairing(url));
    }
    if (saved && token) {
      this.client = createStateClient({ baseUrl: saved.baseUrl, token }, this.env.signer, {
        fetch: this.env.fetch,
        now: this.env.now,
      });
      this.patch({ stage: "paired", session: saved });
      await this.refresh();
      if (this.state.stage === "paired") {
        this.startStream();
        await this.flushOutbox();
      }
      return;
    }
    this.patch({ stage: "unpaired" });
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
    this.stream = null;
    this.stopDeepLink?.();
    if (this.inboxReload) clearTimeout(this.inboxReload);
  }

  /** A scanned QR or an `fr://pair` link: remembered for the pairing screen. */
  offerPairing(text: string): PairingPayload | null {
    const payload = parsePairingPayload(text);
    if (payload) this.patch({ pendingPairing: payload });
    return payload;
  }

  async scanPairing(): Promise<PairingPayload | null> {
    if (!this.env.scan) return null;
    const text = await this.env.scan();
    return text ? this.offerPairing(text) : null;
  }

  // ---------------------------------------------------------------------------------
  // Pairing

  async pair(input: { serviceUrl: string; code: string; deviceName: string }): Promise<void> {
    const baseUrl = input.serviceUrl.trim().replace(/\/$/, "");
    const anonymous = createStateClient({ baseUrl, token: null }, this.env.signer, {
      fetch: this.env.fetch,
      now: this.env.now,
    });
    const result = await anonymous.completePairing({
      code: input.code,
      name: input.deviceName,
      platform: this.env.platform ?? (this.env.inShell ? "android" : "web"),
    });
    const session: MobileSessionInfo = {
      baseUrl,
      deviceId: result.deviceId,
      humanId: result.humanId,
      humanName: null,
      scopes: result.scopes,
      expiresAt: result.expiresAt,
      deviceName: input.deviceName,
      pairedAt: new Date(this.env.now()).toISOString(),
    };
    await this.env.secure.set(TOKEN_KEY, result.token);
    writeJson(this.env.storage, mobileKey(this.env.installId, SESSION_KEY), session);
    this.client = anonymous.withToken(result.token);
    this.patch({ stage: "paired", session, pendingPairing: null, notice: null });
    await this.refresh();
    if (this.state.stage === "paired") {
      this.startStream();
      // Actions queued before an auth loss (spec R.3) go out now, under the new device.
      await this.flushOutbox();
    }
  }

  /**
   * Forget key and token here, and drop the queued actions and the change log with them;
   * the desktop revokes the device row (Settings → Devices). This is the only path that
   * clears the queue: an auth loss (`lostAuth`) keeps it for the next pairing.
   */
  async forgetDevice(): Promise<void> {
    await this.dropIdentity();
    this.outbox.clear();
    this.uploads.clear();
    this.changeLog.clear();
    this.patch({ outboxPending: 0, notice: null });
    this.bumpChanges();
  }

  /**
   * The service refused the token (revoked, or expired after 30 days): the token, the
   * session record and the key go (the service refuses a reused public key at pairing),
   * but the queued actions and the change log stay and the notice says so; `pair` flushes
   * the queue once the phone is paired again.
   */
  async lostAuth(): Promise<void> {
    if (this.losingAuth) return;
    this.losingAuth = true;
    try {
      await this.dropIdentity();
      const queued = this.pendingCount();
      const kept =
        queued === 0
          ? ""
          : ` ${queued} queued action${queued === 1 ? " is" : "s are"} kept and will be sent after pairing.`;
      this.patch({
        outboxPending: queued,
        notice: `This device was revoked or its token expired. Pair again from the desktop.${kept}`,
      });
    } finally {
      this.losingAuth = false;
    }
  }

  private async dropIdentity(): Promise<void> {
    this.stream?.close();
    this.stream = null;
    try {
      await this.env.secure.remove(TOKEN_KEY);
    } catch {
      // nothing to remove
    }
    this.env.storage.remove(mobileKey(this.env.installId, SESSION_KEY));
    await this.env.signer.forget().catch(() => {});
    this.client = this.client.withToken(null);
    this.patch({
      stage: "unpaired",
      session: null,
      projects: [],
      projectsLoaded: false,
      inbox: null,
      blockingCount: 0,
      syncMode: "closed",
    });
  }

  setDeviceName(name: string): void {
    const session = this.state.session;
    if (!session) return;
    const next = { ...session, deviceName: name.trim().slice(0, 120) || session.deviceName };
    writeJson(this.env.storage, mobileKey(this.env.installId, SESSION_KEY), next);
    this.patch({ session: next });
  }

  setQuietHours(quiet: QuietHours): void {
    writeJson(this.env.storage, mobileKey(this.env.installId, QUIET_KEY), quiet);
    this.patch({ quietHours: quiet });
  }

  // ---------------------------------------------------------------------------------
  // Reads

  async refresh(): Promise<void> {
    if (this.state.stage !== "paired") return;
    try {
      const me = await this.client.me();
      const session = this.state.session;
      if (session) {
        const humanName = me.humanName !== undefined ? (me.humanName ?? null) : session.humanName;
        const monthlyCapChfMicro = me.monthlyCap?.chfMicro ?? null;
        if (
          humanName !== session.humanName ||
          monthlyCapChfMicro !== (session.monthlyCapChfMicro ?? null)
        ) {
          const next = { ...session, humanName, monthlyCapChfMicro };
          writeJson(this.env.storage, mobileKey(this.env.installId, SESSION_KEY), next);
          this.patch({ session: next });
        }
      }
    } catch (error) {
      if (this.handleAuthLoss(error)) return;
      this.note(describeStateError(error));
    }
    await Promise.all([this.loadProjects(), this.loadInbox()]);
  }

  private handleAuthLoss(error: unknown): boolean {
    if (error instanceof StateApiError && error.status === 401 && error.code === "unauthorized") {
      if (this.state.stage === "paired" && !this.losingAuth) void this.lostAuth();
      return true;
    }
    return false;
  }

  async loadProjects(): Promise<void> {
    try {
      const projects = await this.client.projects();
      this.store.dispatch({ type: "projects", projects });
      this.online();
    } catch (error) {
      if (!this.handleAuthLoss(error)) this.failed(error);
    }
  }

  /** True when the inbox loaded; false when the service could not be reached. */
  async loadInbox(): Promise<boolean> {
    const humanId = this.state.session?.humanId;
    if (!humanId) return false;
    try {
      const inbox = await this.client.inbox(humanId);
      this.store.dispatch({ type: "inbox", inbox });
      this.online();
      return true;
    } catch (error) {
      if (!this.handleAuthLoss(error)) this.failed(error);
      return false;
    }
  }

  private online(): void {
    if (this.state.notice?.startsWith("State service not reachable")) this.note(null);
  }

  private failed(error: unknown): void {
    // An "Offline: ... queued" notice says more than the generic line; keep it until a flush.
    if (this.state.notice?.startsWith("Offline:")) return;
    this.note(describeStateError(error));
  }

  setActiveProject(id: string | null): void {
    const key = mobileKey(this.env.installId, ACTIVE_KEY);
    if (id) this.env.storage.set(key, id);
    else this.env.storage.remove(key);
    this.patch({ activeProjectId: id });
  }

  // ---------------------------------------------------------------------------------
  // Realtime

  private startStream(): void {
    this.stream?.close();
    this.stream = subscribeStateEvents(
      this.client,
      {
        onEvent: (event) => this.onStreamEvent(event),
        onMode: (mode) => this.patch({ syncMode: mode }),
      },
      {
        poll: async () => {
          const ok = await this.loadInbox();
          if (!ok) throw new Error("state service unreachable");
          await this.flushOutbox();
          await this.trackPendingCommands();
        },
        live: this.env.live,
        pollIntervalMs: this.env.pollIntervalMs,
        retryLiveMs: this.env.retryLiveMs,
      },
    );
  }

  private onStreamEvent(
    event: Parameters<Parameters<typeof subscribeStateEvents>[1]["onEvent"]>[0],
  ): void {
    if (this.closed) return;
    if (event.event === "heartbeat") {
      this.patch({ lastHeartbeatAt: event.data.at });
      return;
    }
    if (event.event === "ready") {
      void this.flushOutbox();
      return;
    }
    if (event.event === "resync") {
      void this.refresh();
      return;
    }
    if (event.event !== "changed") return;
    const change = event.data;
    const notice = noticeFor(change.type, change.payload, change.at);
    if (notice) {
      const p = localParts(this.env.now(), this.env.timezone);
      if (this.env.push.notify(notice, this.state.quietHours, p.hour * 60 + p.minute)) {
        this.store.dispatch({ type: "notice.push", notice });
      }
    }
    switch (change.type) {
      case "human_request.changed":
      case "message.changed":
        this.scheduleInboxReload();
        break;
      case "project.changed":
        if (change.payload.id) {
          void this.client
            .project(change.payload.id)
            .then((project) => this.store.dispatch({ type: "project.upsert", project }))
            .catch(() => {});
        }
        break;
      case "remote_command.changed":
        if (change.payload.id) void this.trackCommand(change.payload.id);
        break;
      case "session.changed":
      case "session.event":
        break;
      default:
        break;
    }
  }

  private scheduleInboxReload(): void {
    if (this.inboxReload) return;
    this.inboxReload = setTimeout(() => {
      this.inboxReload = null;
      void this.loadInbox();
    }, 50);
  }

  /** Without the live feed, pending changes are polled until the PC reports an outcome. */
  async trackPendingCommands(): Promise<void> {
    const pending = this.changeLog
      .all()
      .filter((e) => e.remoteCommandId && (e.status === "sent" || e.status === "picked_up"));
    for (const entry of pending.slice(0, 10)) {
      if (entry.remoteCommandId) await this.trackCommand(entry.remoteCommandId);
    }
  }

  /** Pull one command's status into the change log (after an event or a poll). */
  async trackCommand(remoteCommandId: string): Promise<RemoteCommandView | null> {
    try {
      const row = await this.client.remoteCommand(remoteCommandId);
      const entry = this.changeLog.applyRemoteStatus(row.id, row.status, row.result);
      if (entry) this.bumpChanges();
      return row;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------
  // Writes

  /**
   * The biometric step of a high-risk answer. Whatever the port does other than resolve a
   * ticketed assertion in time is a refusal (`biometric_required`, with the platform's reason
   * when there is one): null, a rejection of any shape, a malformed outcome, or a prompt that
   * does not settle within `biometricTimeoutMs` (an emulator without enrolment, a shell call
   * that never answers). A late success is dropped; its unused ticket expires in the shell.
   * Both ends of the step go to the console (never a ticket), which the emulator smoke
   * forwards as `webview:` lines, so a run shows whether the prompt was asked and how it ended.
   */
  private async assertHighRisk(reason: string): Promise<BiometricAssertion> {
    const limitMs = this.env.biometricTimeoutMs ?? BIOMETRIC_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let outcome: BiometricAssertion | null = null;
    let why: string | null = null;
    console.info(`forerunner: high-risk answer: asking the biometric prompt (${limitMs} ms limit)`);
    try {
      outcome = await Promise.race([
        Promise.resolve().then(() => this.biometric.assert(reason)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new BiometricRefusedError(
                  `the prompt did not answer within ${
                    limitMs < 1000 ? `${limitMs} ms` : `${Math.round(limitMs / 1000)} s`
                  }`,
                ),
              ),
            limitMs,
          );
        }),
      ]);
    } catch (error) {
      why = failureText(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome?.asserted === true && typeof outcome.ticket === "string" && outcome.ticket) {
      console.info("forerunner: high-risk answer: the biometric prompt passed");
      return outcome;
    }
    // A simulated prompt still open (the bound ran out while it waited for the human) closes
    // with the refusal: a dialog asking to confirm next to "refused" would be a lie, and a tap
    // on it would only mint a ticket nothing redeems.
    this.state.biometricPrompt?.resolve(false);
    console.warn(
      `forerunner: high-risk answer refused on the phone: ${(why ?? "the prompt returned no ticketed assertion").slice(0, 200)}`,
    );
    throw new StateApiError(
      "biometric_required",
      "this needs a biometric confirmation on the phone",
      403,
      why ? { reason: why.slice(0, 200) } : {},
    );
  }

  static isHighRisk(request: HumanRequestView): boolean {
    const card = request.changeCard;
    const cardRisk =
      card && typeof card === "object" && !Array.isArray(card)
        ? ((card as { risk?: unknown; impact?: { risk?: unknown } }).risk ??
          (card as { impact?: { risk?: unknown } }).impact?.risk)
        : undefined;
    return request.risk === "high" || cardRisk === "high";
  }

  /** Answer a request; high risk asks the biometric port first and never goes to the outbox. */
  async answerRequest(request: HumanRequestView, answer: unknown): Promise<{ queued: boolean }> {
    const high = MobileController.isHighRisk(request);
    const biometric = high
      ? await this.assertHighRisk(`Confirm: ${request.why.slice(0, 80)}`)
      : null;
    try {
      await this.client.answerRequest(
        request.id,
        { version: request.version, answer },
        { biometric },
      );
      await this.loadInbox();
      return { queued: false };
    } catch (error) {
      if (!high && error instanceof StateApiError && error.code === "ui.network") {
        this.outbox.enqueue({
          clientId: newClientId(),
          kind: "request.answer",
          payload: { id: request.id, version: request.version, answer },
          createdAt: new Date(this.env.now()).toISOString(),
          label: `answer to "${request.why.slice(0, 40)}"`,
        });
        this.patch({ outboxPending: this.pendingCount(), syncMode: "offline" });
        this.note("Offline: your answer is queued and will be sent when the phone reconnects.");
        return { queued: true };
      }
      throw error;
    }
  }

  /**
   * Answer a cloud runner unlock (spec S.12, ADR 0068): the request is high risk, so the
   * biometric prompt runs first and the answer never waits in the outbox; the window the answer
   * carries is recorded on this phone only once the service accepted it.
   */
  async answerUnlock(request: HumanRequestView, prepared: PreparedAnswer): Promise<void> {
    const r = await this.answerRequest(request, prepared.value);
    if (r.queued || prepared.window === undefined) return;
    const key = mobileKey(this.env.installId, UNLOCK_WINDOW_KEY);
    if (prepared.window) this.env.storage.set(key, prepared.window);
    else this.env.storage.remove(key);
    this.patch({ unlockWindowUntil: prepared.window });
  }

  async markRead(message: MessageView): Promise<void> {
    try {
      await this.client.receipt(message.id, "read");
      await this.loadInbox();
    } catch (error) {
      if (error instanceof StateApiError && error.code === "ui.network") {
        this.outbox.enqueue({
          clientId: newClientId(),
          kind: "message.receipt",
          payload: { id: message.id, state: "read" },
          createdAt: new Date(this.env.now()).toISOString(),
          label: "read receipt",
        });
        this.patch({ outboxPending: this.pendingCount(), syncMode: "offline" });
        return;
      }
      throw error;
    }
  }

  /**
   * What the preview card knows: the projects' budgets, the human's monthly cap when `/me`
   * carried one (else unknown, never a guessed constant) and the day's CHF rate as the
   * service's project money pairs imply it.
   */
  cardContext(): CardContext {
    return {
      timezone: this.env.timezone,
      now: this.env.now(),
      activeProjectId: this.state.activeProjectId,
      projects: this.state.projects.map((p) => ({
        id: p.id,
        name: p.name,
        budgetChfMicro: p.budget.chfMicro,
      })),
      monthlyCeilingChfMicro: this.state.session?.monthlyCapChfMicro ?? null,
      chfPerUsd: chfPerUsdFrom(this.state.projects.flatMap((p) => [p.budget, p.spend])),
    };
  }

  /** The one card for a plan, before the human confirms it. */
  planCard(plan: PlanCommand[]): MobileChangeCard {
    return buildPlanCard(plan, this.cardContext());
  }

  /** Send a confirmed plan as ONE remote command for the PC (ADR 0032) and log it. */
  async sendPlan(input: SendPlanInput): Promise<SendPlanResult> {
    const ctx = this.cardContext();
    const card = input.card ?? buildPlanCard(input.plan, ctx);
    const clientId = newClientId();
    const envelope: RemotePlanEnvelope = {
      v: 1,
      kind: "plan",
      plan: input.plan,
      wordsUsed: input.words,
      card: JSON.parse(JSON.stringify(card)) as Record<string, unknown>,
      clientId,
      confirmedAt: new Date(this.env.now()).toISOString(),
      ...(input.undoOf ? { undoOf: input.undoOf } : {}),
    };
    const body = { target: "pc" as const, command: verbForPlan(input.plan), params: envelope };
    const entry: ChangeEntry = {
      id: clientId,
      at: envelope.confirmedAt,
      wordsUsed: input.words,
      source: input.source,
      plan: input.plan,
      card,
      remoteCommandId: null,
      status: "sent",
      result: null,
      undoPlan: input.undoOf ? null : inversePlan(input.plan, card, ctx),
      undoneBy: null,
      undoOf: input.undoOf ?? null,
    };
    let queued = false;
    try {
      const row = await this.client.sendRemote(body);
      entry.remoteCommandId = row.id;
      entry.status = row.status === "pending" ? "sent" : (row.status as ChangeEntry["status"]);
    } catch (error) {
      if (error instanceof StateApiError && error.code === "ui.network") {
        this.outbox.enqueue({
          clientId,
          kind: "remote.enqueue",
          payload: body as unknown as Record<string, unknown>,
          createdAt: envelope.confirmedAt,
          label: card.what,
        });
        this.patch({ outboxPending: this.pendingCount(), syncMode: "offline" });
        this.note(
          "Offline: the change is queued and will reach your PC when the phone reconnects.",
        );
        queued = true;
      } else {
        throw error;
      }
    }
    this.changeLog.add(entry);
    this.bumpChanges();
    const switched = [...input.plan].reverse().find((c) => c.name === "project.switch");
    if (switched && typeof switched.params.project === "string") {
      this.setActiveProject(switched.params.project);
    }
    return { entry, queued };
  }

  /** One tap: send the inverse plan and mark the entry undone. */
  async undo(entryId: string): Promise<SendPlanResult> {
    const entry = this.changeLog.get(entryId);
    if (!entry || !this.changeLog.canUndo(entry) || !entry.undoPlan) {
      throw new StateApiError("validation", "this change cannot be undone", 400);
    }
    const result = await this.sendPlan({
      words: `undo: ${entry.wordsUsed}`,
      plan: entry.undoPlan,
      source: "ui",
      undoOf: entry.id,
    });
    this.changeLog.update(entry.id, { status: "undone", undoneBy: result.entry.id });
    this.bumpChanges();
    return result;
  }

  /** Quick chat relayed to the PC's principal agent as a remote command (text only). */
  async sendChat(text: string, projectId: string | null): Promise<RemoteCommandView> {
    const envelope: RemoteChatEnvelope = {
      v: 1,
      kind: "chat",
      text,
      projectId,
      clientId: newClientId(),
    };
    return this.client.sendRemote({ target: "pc", command: "start", params: envelope });
  }

  async addNote(projectId: string, text: string, kind = "note"): Promise<{ queued: boolean }> {
    try {
      await this.client.enqueueQueueItem(projectId, { kind, text });
      return { queued: false };
    } catch (error) {
      if (error instanceof StateApiError && error.code === "ui.network") {
        this.outbox.enqueue({
          clientId: newClientId(),
          kind: "queue.enqueue",
          payload: { projectId, kind, text, priority: 0 },
          createdAt: new Date(this.env.now()).toISOString(),
          label: `${kind} for ${projectId}`,
        });
        this.patch({ outboxPending: this.pendingCount(), syncMode: "offline" });
        return { queued: true };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------
  // Uploads (spec R.5; ADR 0080)

  /** The cap the service last reported; null until a list said it. */
  uploadMaxBytes: number | null = null;

  async loadUploads(projectId: string): Promise<UploadView[]> {
    const r = await this.client.uploads(projectId);
    if (r.maxBytes !== null) this.uploadMaxBytes = r.maxBytes;
    return r.uploads;
  }

  /**
   * Send a photo, file or document to the project, signed. Over the known cap it is refused
   * here, before any byte leaves; unreachable, it is queued under its clientId and sent on
   * reconnect (the service makes the resend idempotent).
   */
  async uploadFile(
    projectId: string,
    file: UploadFile,
    kind = "upload",
  ): Promise<{ queued: boolean; upload: UploadView | null }> {
    const cap = this.uploadMaxBytes;
    if (cap !== null && file.bytes.byteLength > cap) {
      throw new StateApiError(
        "payload_too_large",
        `${file.name} is ${formatBytes(file.bytes.byteLength)}; the limit is ${formatBytes(cap)}`,
        413,
        { maxBytes: cap },
      );
    }
    const clientId = newClientId();
    try {
      const upload = await this.client.upload(projectId, file, { clientId, kind });
      return { queued: false, upload };
    } catch (error) {
      if (error instanceof StateApiError && error.code === "ui.network") {
        this.uploads.enqueue({
          clientId,
          projectId,
          file,
          kind,
          createdAt: new Date(this.env.now()).toISOString(),
        });
        this.patch({ outboxPending: this.pendingCount(), syncMode: "offline" });
        this.note(
          `Offline: ${file.name} is queued and will be uploaded when the phone reconnects.`,
        );
        return { queued: true, upload: null };
      }
      if (error instanceof StateApiError && error.status === 413) {
        const max = error.details.maxBytes;
        if (typeof max === "number") this.uploadMaxBytes = max;
      }
      throw error;
    }
  }

  private async flushUploads(): Promise<void> {
    const report = await this.uploads.flush(this.client);
    this.patch({ outboxPending: this.pendingCount() });
    if (report.sent.length > 0) {
      this.note(
        `Uploaded ${report.sent.length} queued file${report.sent.length === 1 ? "" : "s"}.`,
      );
    }
    if (report.rejected.length > 0) {
      this.note(
        `${report.rejected.length} queued upload${report.rejected.length === 1 ? " was" : "s were"} refused: ${report.rejected
          .map((r) => `${r.name} (${r.code})`)
          .join(", ")}`,
      );
    }
  }

  // ---------------------------------------------------------------------------------
  // PR and critic review (spec R.5)

  loadReviews(projectId: string): Promise<ReviewView[]> {
    return this.client.reviews(projectId);
  }

  /** The open approval request a verdict on this review answers (the task's), if the inbox has it. */
  reviewRequest(review: ReviewView): HumanRequestView | null {
    if (!review.taskId) return null;
    return (
      this.state.inbox?.requests.find(
        (r) => r.status === "open" && r.kind === "approval" && r.taskId === review.taskId,
      ) ?? null
    );
  }

  async commentReview(review: ReviewView, text: string): Promise<void> {
    await this.client.commentReview(review.id, text);
  }

  /**
   * Approve or reject a review. The verdict answers the task's open approval request; when
   * that request is high risk the biometric prompt runs first and its flag travels inside
   * the signature (ADR 0045, ADR 0009). Never queued: the verdict needs the request's current
   * version and, when high risk, a live signature.
   */
  async reviewVerdict(
    review: ReviewView,
    verdict: "approve" | "reject",
    comment: string,
  ): Promise<ReviewVerdictResult> {
    const request = this.reviewRequest(review);
    const high = request ? MobileController.isHighRisk(request) : false;
    const biometric = high
      ? await this.assertHighRisk(
          `${verdict === "approve" ? "Approve" : "Reject"}: ${(review.taskTitle ?? review.id).slice(0, 80)}`,
        )
      : null;
    const result = await this.client.reviewVerdict(
      review.id,
      verdict,
      {
        ...(comment.trim() ? { body: comment.trim() } : {}),
        ...(request ? { requestVersion: request.version } : {}),
      },
      { biometric },
    );
    await this.loadInbox();
    return result;
  }

  // ---------------------------------------------------------------------------------
  // Voice (spec R.5, O; ADR 0080)

  /**
   * One push-to-talk turn relayed to the PC's voice loop as a remote command: the recording
   * when there is one, else the typed line. The PC's reply comes back as the result.
   */
  async sendVoice(
    input: { recorded: RecordedTurn } | { transcript: string },
    projectId: string | null,
  ): Promise<RemoteCommandView> {
    const envelope: RemoteVoiceEnvelope = {
      v: 1,
      kind: "voice",
      projectId,
      clientId: newClientId(),
      ...("recorded" in input
        ? { audio: encodeTurn(input.recorded) }
        : { transcript: input.transcript.trim() }),
    };
    return this.client.sendRemote({ target: "pc", command: "start", params: envelope });
  }

  async flushOutbox(): Promise<void> {
    if (this.state.stage !== "paired") return;
    if (this.uploads.size() > 0) await this.flushUploads();
    if (this.outbox.size() === 0) return;
    const report = await this.outbox.flush(this.client);
    this.patch({ outboxPending: this.pendingCount() });
    for (const applied of report.applied) {
      // A queued plan's clientId is its change-log entry id; link the remote command now.
      const id = (applied.result as { id?: unknown } | null)?.id;
      if (
        applied.kind === "remote.enqueue" &&
        typeof id === "string" &&
        this.changeLog.get(applied.clientId)
      ) {
        this.changeLog.update(applied.clientId, { remoteCommandId: id });
        this.bumpChanges();
        void this.trackCommand(id);
      }
    }
    if (report.sent > 0) {
      this.note(`Sent ${report.sent} queued action${report.sent === 1 ? "" : "s"}.`);
      await this.loadInbox();
    }
    if (report.rejected.length > 0) {
      this.note(
        `${report.rejected.length} queued action${report.rejected.length === 1 ? " was" : "s were"} refused: ${report.rejected
          .map((r) => `${r.label} (${r.code})`)
          .join(", ")}`,
      );
    }
  }
}

interface MobileContextValue {
  controller: MobileController;
}

const MobileContext = createContext<MobileContextValue | null>(null);

export function MobileProvider({
  env,
  controller,
  bootstrap = true,
  children,
}: {
  env?: MobileEnv;
  controller?: MobileController;
  bootstrap?: boolean;
  children: ReactNode;
}) {
  const ctrl = useMemo(() => {
    if (controller) return controller;
    if (!env) throw new Error("MobileProvider needs an env or a controller");
    return new MobileController(env);
  }, [controller, env]);
  useEffect(() => {
    if (!bootstrap) return;
    void ctrl.bootstrap();
    return () => ctrl.close();
  }, [ctrl, bootstrap]);
  return <MobileContext.Provider value={{ controller: ctrl }}>{children}</MobileContext.Provider>;
}

export function useMobileController(): MobileController {
  const value = useContext(MobileContext);
  if (!value) throw new Error("useMobileController must be used inside <MobileProvider>");
  return value.controller;
}

export function useMobileState<T>(selector: (state: MobileState) => T): T {
  const { store } = useMobileController();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function activeMobileProject(state: MobileState): ProjectCard | null {
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
