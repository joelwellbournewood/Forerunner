/**
 * Provider registry with the default selection policy "local if available, else cloud if a
 * key is configured, else fake", exposing the reason so the Extensions panel can show it.
 */
import { ForerunnerError } from "@forerunner/platform";
import type { ProviderKind, SttProvider, TtsProvider } from "./types.ts";

export interface RegisterOptions {
  /** Secret reference the provider needs (cloud providers). */
  secretRef?: string;
}

export interface ProviderStatus {
  name: string;
  kind: ProviderKind;
  available: boolean;
  reason: string;
  secretRef?: string;
  secretConfigured?: boolean;
  selected: boolean;
}

export type SelectionPolicy = "preferred" | "local" | "cloud" | "fake";

export interface Selection<T> {
  provider: T;
  name: string;
  kind: ProviderKind;
  policy: SelectionPolicy;
  /** Human-readable explanation for the Extensions panel. */
  reason: string;
  statuses: ProviderStatus[];
}

export interface SelectInput {
  /** Provider chosen in the Extensions panel; used when it is available. */
  preferred?: string;
  /**
   * Where `preferred` came from, for the reason ("selected in Extensions (voice-deepgram)",
   * "set by FORERUNNER_VOICE_STT"); default "selected in Extensions".
   */
  preferredBy?: string;
  /** Whether a secret reference has a value; defaults to "unknown" (treated as configured). */
  hasSecret?: (ref: string) => Promise<boolean> | boolean;
}

interface Entry<T> {
  provider: T;
  secretRef?: string;
}

interface Probeable {
  readonly name: string;
  readonly kind: ProviderKind;
  isAvailable(): Promise<{ ok: boolean; reason: string }>;
}

export class VoiceProviderRegistry {
  private readonly stt: Entry<SttProvider>[] = [];
  private readonly tts: Entry<TtsProvider>[] = [];

  registerStt(provider: SttProvider, opts: RegisterOptions = {}): this {
    this.replace(this.stt, { provider, ...(opts.secretRef ? { secretRef: opts.secretRef } : {}) });
    return this;
  }

  registerTts(provider: TtsProvider, opts: RegisterOptions = {}): this {
    this.replace(this.tts, { provider, ...(opts.secretRef ? { secretRef: opts.secretRef } : {}) });
    return this;
  }

  sttNames(): string[] {
    return this.stt.map((e) => e.provider.name);
  }

  ttsNames(): string[] {
    return this.tts.map((e) => e.provider.name);
  }

  getStt(name: string): SttProvider | undefined {
    return this.stt.find((e) => e.provider.name === name)?.provider;
  }

  getTts(name: string): TtsProvider | undefined {
    return this.tts.find((e) => e.provider.name === name)?.provider;
  }

  selectStt(input: SelectInput = {}): Promise<Selection<SttProvider>> {
    return select(this.stt, input, "STT");
  }

  selectTts(input: SelectInput = {}): Promise<Selection<TtsProvider>> {
    return select(this.tts, input, "TTS");
  }

  /** Status rows for the Extensions panel, with the current selection marked. */
  async statusStt(input: SelectInput = {}): Promise<ProviderStatus[]> {
    return statusRows(this.stt, input);
  }

  async statusTts(input: SelectInput = {}): Promise<ProviderStatus[]> {
    return statusRows(this.tts, input);
  }

  private replace<T extends Probeable>(list: Entry<T>[], entry: Entry<T>): void {
    const i = list.findIndex((e) => e.provider.name === entry.provider.name);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
  }
}

async function probeAll<T extends Probeable>(
  list: Entry<T>[],
  input: SelectInput,
): Promise<ProviderStatus[]> {
  return Promise.all(
    list.map(async (e) => {
      let secretConfigured: boolean | undefined;
      if (e.secretRef && input.hasSecret) {
        try {
          secretConfigured = await input.hasSecret(e.secretRef);
        } catch {
          secretConfigured = false;
        }
      }
      let available = false;
      let reason: string;
      try {
        const a = await e.provider.isAvailable();
        available = a.ok;
        reason = a.reason;
      } catch (err) {
        reason = `probe threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (secretConfigured === false) {
        available = false;
        reason = `no value for ${e.secretRef}`;
      }
      return {
        name: e.provider.name,
        kind: e.provider.kind,
        available,
        reason,
        ...(e.secretRef ? { secretRef: e.secretRef } : {}),
        ...(secretConfigured !== undefined ? { secretConfigured } : {}),
        selected: false,
      };
    }),
  );
}

async function statusRows<T extends Probeable>(
  list: Entry<T>[],
  input: SelectInput,
): Promise<ProviderStatus[]> {
  try {
    const sel = await select(list, input, "voice");
    return sel.statuses;
  } catch {
    return probeAll(list, input);
  }
}

async function select<T extends Probeable>(
  list: Entry<T>[],
  input: SelectInput,
  label: string,
): Promise<Selection<T>> {
  const statuses = await probeAll(list, input);
  const byName = (name: string) => list.find((e) => e.provider.name === name);
  const done = (name: string, policy: SelectionPolicy, reason: string): Selection<T> => {
    const entry = byName(name) as Entry<T>;
    for (const s of statuses) s.selected = s.name === name;
    return { provider: entry.provider, name, kind: entry.provider.kind, policy, reason, statuses };
  };

  let note = "";
  if (input.preferred) {
    const s = statuses.find((x) => x.name === input.preferred);
    if (s?.available) {
      return done(
        s.name,
        "preferred",
        `"${s.name}" ${input.preferredBy ?? "selected in Extensions"}`,
      );
    }
    note = s
      ? `preferred "${s.name}" unavailable (${s.reason}); `
      : `preferred "${input.preferred}" is not registered; `;
  }
  const local = statuses.find((s) => s.kind === "local" && s.available);
  if (local)
    return done(local.name, "local", `${note}local provider "${local.name}": ${local.reason}`);
  const cloud = statuses.find((s) => s.kind === "cloud" && s.available);
  if (cloud) {
    return done(
      cloud.name,
      "cloud",
      `${note}no local ${label} provider available; cloud provider "${cloud.name}" has a key configured`,
    );
  }
  const fake = statuses.find((s) => s.kind === "fake" && s.available);
  if (fake) {
    return done(
      fake.name,
      "fake",
      `${note}no local ${label} provider and no cloud key configured; using "${fake.name}"`,
    );
  }
  throw new ForerunnerError("unavailable", `no ${label} provider available`, {
    details: { statuses },
  });
}
