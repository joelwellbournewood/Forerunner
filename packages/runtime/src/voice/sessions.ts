/**
 * The daemon's voice sessions (ADR 0048): one `VoiceBridge` per session the shell opens,
 * each on the providers the registry's policy selected at that moment, with the preferences
 * (the Extensions panel's enabled `voice-*` rows, or the environment override) read afresh
 * at every status read and session start, so a change in the panel applies at the next
 * session. `status()` never throws: without a usable STT or TTS provider, or without a model
 * credential, it reports `available: false` with the reason the shells show, and `start()`
 * refuses with `unavailable` carrying the same reason.
 */
import type { Clock } from "@forerunner/platform";
import { errorMessage, ForerunnerError } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { ConversationAgent } from "../conversation/agent.ts";
import { VoiceBridge, type VoiceBridgeCommands } from "./bridge.ts";
import type {
  AudioSink,
  LatencyTargets,
  ProviderKind,
  ProviderStatus,
  ReplyMode,
  SelectInput,
  SelectionPolicy,
  SttProvider,
  TtsProvider,
  VoiceMode,
  VoiceProviderRegistry,
} from "./pkg.ts";
import {
  noVoicePreferences,
  preferredBy,
  type VoicePreference,
  type VoicePreferences,
  type VoiceSide,
} from "./providers.ts";

export interface VoiceProviderPick {
  name: string;
  kind: ProviderKind;
  policy: SelectionPolicy;
  reason: string;
}

export interface VoiceAvailability {
  available: boolean;
  /** Why voice is unavailable, or how the providers were picked. */
  reason: string;
  stt: VoiceProviderPick | null;
  tts: VoiceProviderPick | null;
  statuses: { stt: ProviderStatus[]; tts: ProviderStatus[] };
  /** The panel's (or the environment's) choice per side and the rows not in force, with why. */
  preferences: VoicePreferences;
  sessions: number;
  maxSessions: number;
}

export interface VoiceSession {
  id: string;
  bridge: VoiceBridge;
  providers: { stt: VoiceProviderPick; tts: VoiceProviderPick };
}

export interface StartVoiceSessionOptions {
  projectId?: string;
  language?: string;
  mode?: VoiceMode;
  /** `voice` (default) speaks the replies; `text` streams them as text only (no TTS, no audio). */
  replyMode?: ReplyMode;
  /** The phone relay's sessions: replies stay spoken, a reply mode is refused. */
  replyModeLocked?: boolean;
}

export interface VoiceSessionsDeps {
  registry: VoiceProviderRegistry;
  /**
   * The preferred providers, read at every status read and session start: the Extensions
   * panel's enabled `voice-*` rows and the environment override (`resolveVoicePreferences`).
   * Default: none, the registry's policy decides.
   */
  preferences?: () => Promise<VoicePreferences> | VoicePreferences;
  hasSecret?: (ref: string) => Promise<boolean>;
  /** The conversation agent, null without a model credential. */
  conversation: () => ConversationAgent | null;
  commands: VoiceBridgeCommands;
  store: StateStore;
  clock: Clock;
  humanId: string;
  agentId: string;
  /** Playback sink per session; default: paced on the clock. */
  sink?: (clock: Clock) => AudioSink;
  storeAudio?: boolean;
  audioDir?: string;
  env?: NodeJS.ProcessEnv;
  targets?: Partial<LatencyTargets>;
  /** Concurrent voice sessions per daemon; default 4. */
  maxSessions?: number;
  /**
   * Stopped sessions still answer `GET /voice/sessions/:id` and a late stream for a while,
   * then they are dropped (a bridge keeps up to 1000 buffered events and every turn's record,
   * so a daemon open for weeks must not keep every session it ever opened): at most
   * `keepStopped` of them (default 8) and none older than `retainStoppedMs` (default 10 min).
   */
  keepStopped?: number;
  retainStoppedMs?: number;
}

export const DEFAULT_MAX_VOICE_SESSIONS = 4;
export const DEFAULT_KEEP_STOPPED = 8;
export const DEFAULT_RETAIN_STOPPED_MS = 10 * 60_000;
const NO_MODEL = "no model credential configured; run fr setup";

interface Picked {
  stt: { provider: SttProvider; pick: VoiceProviderPick };
  tts: { provider: TtsProvider; pick: VoiceProviderPick };
  statuses: { stt: ProviderStatus[]; tts: ProviderStatus[] };
}

export class VoiceSessions {
  private readonly sessions = new Map<string, VoiceSession>();

  constructor(private readonly deps: VoiceSessionsDeps) {}

  get maxSessions(): number {
    return this.deps.maxSessions ?? DEFAULT_MAX_VOICE_SESSIONS;
  }

  get keepStopped(): number {
    return this.deps.keepStopped ?? DEFAULT_KEEP_STOPPED;
  }

  get retainStoppedMs(): number {
    return this.deps.retainStoppedMs ?? DEFAULT_RETAIN_STOPPED_MS;
  }

  /** What the shells show before opening the microphone; never throws. */
  async status(): Promise<VoiceAvailability> {
    this.sweep();
    const preferences = await this.preferences();
    const base = {
      stt: null,
      tts: null,
      preferences,
      sessions: this.open().length,
      maxSessions: this.maxSessions,
    };
    if (!this.deps.conversation()) {
      return {
        available: false,
        reason: NO_MODEL,
        statuses: await this.probe(preferences),
        ...base,
      };
    }
    try {
      const picked = await this.pick(preferences);
      return {
        available: true,
        reason: `${picked.stt.pick.reason}; ${picked.tts.pick.reason}`,
        ...base,
        stt: picked.stt.pick,
        tts: picked.tts.pick,
        statuses: picked.statuses,
      };
    } catch (e) {
      return {
        available: false,
        reason: errorMessage(e),
        statuses: await this.probe(preferences),
        ...base,
      };
    }
  }

  async start(opts: StartVoiceSessionOptions = {}): Promise<VoiceSession> {
    this.sweep();
    const agent = this.deps.conversation();
    if (!agent) throw new ForerunnerError("provider_auth", NO_MODEL);
    if (this.open().length >= this.maxSessions) {
      throw new ForerunnerError(
        "unavailable",
        `voice: ${this.maxSessions} sessions are already open; stop one first`,
      );
    }
    // The panel's choice as it stands now: a toggle since the last session is seen here.
    const picked = await this.pick(await this.preferences());
    const bridge = await VoiceBridge.create({
      agent,
      commands: this.deps.commands,
      store: this.deps.store,
      clock: this.deps.clock,
      humanId: this.deps.humanId,
      agentId: this.deps.agentId,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.replyMode ? { replyMode: opts.replyMode } : {}),
      ...(opts.replyModeLocked ? { replyModeLocked: true } : {}),
      stt: picked.stt.provider,
      tts: picked.tts.provider,
      ...(this.deps.sink ? { sink: this.deps.sink(this.deps.clock) } : {}),
      ...(this.deps.storeAudio ? { storeAudio: true } : {}),
      ...(this.deps.audioDir ? { audioDir: this.deps.audioDir } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(this.deps.targets ? { targets: this.deps.targets } : {}),
      providers: { stt: picked.stt.pick.name, tts: picked.tts.pick.name },
    });
    const session: VoiceSession = {
      id: bridge.id,
      bridge,
      providers: { stt: picked.stt.pick, tts: picked.tts.pick },
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): VoiceSession | undefined {
    this.sweep();
    return this.sessions.get(id);
  }

  mustGet(id: string): VoiceSession {
    const s = this.get(id);
    if (!s) throw new ForerunnerError("not_found", `no voice session ${id}`);
    return s;
  }

  list(): VoiceSession[] {
    this.sweep();
    return [...this.sessions.values()];
  }

  /** Sessions still running. */
  open(): VoiceSession[] {
    return this.list().filter((s) => !s.bridge.ended);
  }

  async stop(id: string): Promise<VoiceSession> {
    const s = this.mustGet(id);
    await s.bridge.stop();
    return s;
  }

  async close(): Promise<void> {
    for (const s of this.open()) {
      await s.bridge.stop().catch(() => undefined);
    }
  }

  /**
   * Drop the stopped sessions beyond the kept count or older than the grace period. Lazy, on
   * every access, so no timer runs and the simulated clock of the tests decides the age.
   */
  private sweep(): void {
    const now = this.deps.clock.now();
    const stopped = [...this.sessions.values()]
      .filter((s) => s.bridge.endedAt !== null)
      .sort((a, b) => Date.parse(a.bridge.endedAt ?? "") - Date.parse(b.bridge.endedAt ?? ""));
    for (const [i, s] of stopped.entries()) {
      const beyondCap = stopped.length - i > this.keepStopped;
      const stale = now - Date.parse(s.bridge.endedAt ?? "") > this.retainStoppedMs;
      if (beyondCap || stale) this.sessions.delete(s.id);
    }
  }

  private async preferences(): Promise<VoicePreferences> {
    return this.deps.preferences ? await this.deps.preferences() : noVoicePreferences();
  }

  private selectInput(side: VoiceSide, prefs: VoicePreferences): SelectInput {
    return selectInputFor(side, prefs, this.deps.hasSecret);
  }

  private async pick(prefs: VoicePreferences): Promise<Picked> {
    const { registry } = this.deps;
    const stt = await registry.selectStt(this.selectInput("stt", prefs));
    const tts = await pickTts(registry, prefs, this.deps.hasSecret);
    return {
      stt: {
        provider: stt.provider,
        pick: { name: stt.name, kind: stt.kind, policy: stt.policy, reason: stt.reason },
      },
      tts: { provider: tts.provider, pick: tts.pick },
      statuses: { stt: stt.statuses, tts: tts.statuses },
    };
  }

  private async probe(
    prefs: VoicePreferences,
  ): Promise<{ stt: ProviderStatus[]; tts: ProviderStatus[] }> {
    const { registry } = this.deps;
    return {
      stt: await registry.statusStt(this.selectInput("stt", prefs)),
      tts: await registry.statusTts(this.selectInput("tts", prefs)),
    };
  }
}

/**
 * The registry's selection input for one side: the preferred row's name and why it is
 * preferred (the Extensions panel or the environment override), the providers the panel rules
 * out of the fallback (a switched-off cloud row, a grant without its key: off means off), and
 * the vault probe.
 */
function selectInputFor(
  side: VoiceSide,
  prefs: VoicePreferences,
  hasSecret: ((ref: string) => Promise<boolean>) | undefined,
): SelectInput {
  const p: VoicePreference | null = prefs[side];
  const excluded = prefs.excluded[side];
  return {
    ...(hasSecret ? { hasSecret } : {}),
    ...(p ? { preferred: p.name, preferredBy: preferredBy(p, side) } : {}),
    ...(excluded.length > 0 ? { excluded } : {}),
  };
}

/**
 * The TTS provider the registry's policy picks right now (local if available, else cloud with
 * a key, the preferred row first: the Extensions panel's choice or the environment override, as
 * the voice sessions read it); shared by the voice sessions and the speaker. Throws
 * `unavailable` with the reason when nothing can run.
 */
export async function pickTts(
  registry: VoiceProviderRegistry,
  preferred: VoicePreferences | undefined,
  hasSecret: ((ref: string) => Promise<boolean>) | undefined,
): Promise<{ provider: TtsProvider; pick: VoiceProviderPick; statuses: ProviderStatus[] }> {
  const tts = await registry.selectTts(
    selectInputFor("tts", preferred ?? noVoicePreferences(), hasSecret),
  );
  return {
    provider: tts.provider,
    pick: { name: tts.name, kind: tts.kind, policy: tts.policy, reason: tts.reason },
    statuses: tts.statuses,
  };
}
