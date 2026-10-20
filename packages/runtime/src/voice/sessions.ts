/**
 * The daemon's voice sessions (ADR 0048): one `VoiceBridge` per session the shell opens,
 * each on the providers the registry's policy selected at that moment. `status()` never
 * throws: without a usable STT or TTS provider, or without a model credential, it reports
 * `available: false` with the reason the shells show, and `start()` refuses with
 * `unavailable` carrying the same reason.
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
  SelectionPolicy,
  SttProvider,
  TtsProvider,
  VoiceMode,
  VoiceProviderRegistry,
} from "./pkg.ts";
import type { VoicePreferences } from "./providers.ts";

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
}

export interface VoiceSessionsDeps {
  registry: VoiceProviderRegistry;
  preferred?: VoicePreferences;
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
}

export const DEFAULT_MAX_VOICE_SESSIONS = 4;
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

  /** What the shells show before opening the microphone; never throws. */
  async status(): Promise<VoiceAvailability> {
    const base = {
      stt: null,
      tts: null,
      sessions: this.open().length,
      maxSessions: this.maxSessions,
    };
    if (!this.deps.conversation()) {
      return { available: false, reason: NO_MODEL, statuses: await this.probe(), ...base };
    }
    try {
      const picked = await this.pick();
      return {
        available: true,
        reason: `${picked.stt.pick.reason}; ${picked.tts.pick.reason}`,
        ...base,
        stt: picked.stt.pick,
        tts: picked.tts.pick,
        statuses: picked.statuses,
      };
    } catch (e) {
      return { available: false, reason: errorMessage(e), statuses: await this.probe(), ...base };
    }
  }

  async start(opts: StartVoiceSessionOptions = {}): Promise<VoiceSession> {
    const agent = this.deps.conversation();
    if (!agent) throw new ForerunnerError("provider_auth", NO_MODEL);
    if (this.open().length >= this.maxSessions) {
      throw new ForerunnerError(
        "unavailable",
        `voice: ${this.maxSessions} sessions are already open; stop one first`,
      );
    }
    const picked = await this.pick();
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
    return this.sessions.get(id);
  }

  mustGet(id: string): VoiceSession {
    const s = this.sessions.get(id);
    if (!s) throw new ForerunnerError("not_found", `no voice session ${id}`);
    return s;
  }

  list(): VoiceSession[] {
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

  private selectInput(): { preferred?: string; hasSecret?: (ref: string) => Promise<boolean> } {
    return this.deps.hasSecret ? { hasSecret: this.deps.hasSecret } : {};
  }

  private async pick(): Promise<Picked> {
    const { registry, preferred } = this.deps;
    const stt = await registry.selectStt({
      ...this.selectInput(),
      ...(preferred?.stt ? { preferred: preferred.stt } : {}),
    });
    const tts = await registry.selectTts({
      ...this.selectInput(),
      ...(preferred?.tts ? { preferred: preferred.tts } : {}),
    });
    return {
      stt: {
        provider: stt.provider,
        pick: { name: stt.name, kind: stt.kind, policy: stt.policy, reason: stt.reason },
      },
      tts: {
        provider: tts.provider,
        pick: { name: tts.name, kind: tts.kind, policy: tts.policy, reason: tts.reason },
      },
      statuses: { stt: stt.statuses, tts: tts.statuses },
    };
  }

  private async probe(): Promise<{ stt: ProviderStatus[]; tts: ProviderStatus[] }> {
    const { registry, preferred } = this.deps;
    return {
      stt: await registry.statusStt({
        ...this.selectInput(),
        ...(preferred?.stt ? { preferred: preferred.stt } : {}),
      }),
      tts: await registry.statusTts({
        ...this.selectInput(),
        ...(preferred?.tts ? { preferred: preferred.tts } : {}),
      }),
    };
  }
}
