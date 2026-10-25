import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nearestRank } from "../packages/runtime/src/daemon/views.ts";
import { openStore, type StateStore } from "../packages/state/src/index.ts";
import {
  buildLatencyReport,
  FakeStt,
  FakeTts,
  medianTotalToFirstAudio,
  type SttProvider,
  type TtsProvider,
  VoiceProviderRegistry,
} from "../packages/voice/src/index.ts";
import { median, p90, runCheck, runReport, turnSample } from "./voice-run.ts";

/**
 * scripts/voice-run.ts: `report` over a seeded store in a temporary FORERUNNER_HOME (the
 * lines, the summary, --since, --exclude-first, no transcript text, the refusals) and `check`
 * over a stubbed registry and Python probe.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-10-25T20:00:00.000Z";
const SECRET_SAID = "my private sentence about the dentist";
const SECRET_HEARD = "the private reply about the appointment";

const temps: string[] = [];
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-voice-run-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lines(): { out: (l: string) => void; text: () => string; all: string[] } {
  const all: string[] = [];
  return { out: (l) => all.push(l), text: () => all.join("\n"), all };
}

interface Seed {
  home: string;
  url: string;
}

/** A home with config.json naming its own SQLite store, holding voice.turn rows. */
async function seedHome(
  turns: {
    hoursAgo: number;
    source?: string;
    total: number | null;
    stages?: Partial<Record<string, number | null>>;
    error?: { code: string; message: string };
    /** The voice session (default `vs-1`) and its turn number (default: the row's position). */
    vs?: string;
    turnNo?: number;
    /** `latency.heardFirstAudioMs` on the row (the player posted it while the turn ran). */
    heard?: number | null;
    /** A `voice.heard` row right after the turn's row (the player's figure arrived later). */
    heardRow?: number;
  }[],
): Promise<Seed> {
  const home = tempHome();
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  const file = join(home, "data", "state.sqlite");
  const url = `sqlite:${file}`;
  writeFileSync(
    join(home, "config", "config.json"),
    JSON.stringify({ profile: "voice-run", stateUrl: url, credentials: { anthropic: true } }),
  );
  // Rows are written in time order, the oldest first, on the store's clock.
  const ordered = [...turns].sort((a, b) => b.hoursAgo - a.hoursAgo);
  const at = (hoursAgo: number) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString();
  const clock = new SimulatedClock(at((ordered[0]?.hoursAgo ?? 0) + 1));
  const store: StateStore = await openStore({ url, clock });
  try {
    const human = await store.human.insert({ name: "J", email: "j@example.test" });
    const agent = await store.agent.insert({
      name: "A",
      owner_human_id: human.id,
      kind: "principal",
    });
    const session = await store.session.insert({
      agent_id: agent.id,
      project_id: null,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1,
      step_cap: 1,
      status: "planned",
    });
    let n = 0;
    for (const t of ordered) {
      await clock.set(at(t.hoursAgo));
      n++;
      const s = t.stages ?? {};
      await store.event.append(session.id, "voice.turn", {
        voiceSessionId: t.vs ?? "vs-1",
        turn: t.turnNo ?? n,
        source: t.source ?? "audio",
        said: SECRET_SAID,
        heard: SECRET_HEARD,
        unspokenText: `${SECRET_HEARD} unspoken`,
        audioChunks: 40,
        audioStored: false,
        interrupted: false,
        pendingId: null,
        outcome: null,
        error: t.error ?? null,
        latency: {
          endOfTurnMs: s.endOfTurnMs ?? 20,
          finalTranscriptMs: s.finalTranscriptMs ?? 300,
          modelFirstTokenMs: s.modelFirstTokenMs ?? 500,
          firstAudioMs: s.firstAudioMs ?? 200,
          totalToFirstAudioMs: t.total,
          withinTarget: t.total !== null && t.total <= 1200,
          firstSentenceMs: s.firstSentenceMs ?? 50,
          ttsFirstByteMs: s.ttsFirstByteMs ?? 150,
          ...(t.heard === undefined ? {} : { heardFirstAudioMs: t.heard }),
        },
      });
      if (t.heardRow !== undefined)
        await store.event.append(session.id, "voice.heard", {
          voiceSessionId: t.vs ?? "vs-1",
          turn: t.turnNo ?? n,
          heardFirstAudioMs: t.heardRow,
        });
    }
  } finally {
    await store.close();
  }
  return { home, url };
}

const clockAt = () => new SimulatedClock(NOW);

describe("voice-run report", () => {
  it("prints one line per turn with the stages and the summary with the result line", async () => {
    const totals = [900, 1000, 1100, 1300, 950, 1050, 980, 1020, 1150, 1250];
    const { home } = await seedHome(
      totals.map((total, i) => ({
        hoursAgo: 10 - i,
        total,
        stages: { modelFirstTokenMs: 400 + i * 10 },
      })),
    );
    const o = lines();
    const r = await runReport({
      env: { FORERUNNER_HOME: home },
      out: o.out,
      argv: [],
      clock: clockAt(),
    });
    const turnLines = o.all.filter((l) => / turn=\d+ /.test(l));
    expect(turnLines).toHaveLength(10);
    expect(turnLines[0]).toMatch(
      /turn=1 source=audio totalToFirstAudioMs=900 heardFirstAudioMs=- endOfTurnMs=20 finalTranscriptMs=300 modelFirstTokenMs=400 firstAudioMs=200 firstSentenceMs=50 ttsFirstByteMs=150 within=yes$/,
    );
    expect(turnLines[3]).toMatch(/totalToFirstAudioMs=1300 .* within=no$/);
    // median of ten: mean of 1020 and 1050; p90 by nearest rank: the 9th of ten (1250).
    expect(r).toMatchObject({ code: 0, n: 10, median: 1035, p90: 1250, met: true });
    expect(o.text()).toContain(
      "first audio, daemon-side (totalToFirstAudioMs, measured where the daemon's paced sink takes the first chunk; the SSE hop, decoding, scheduling and the output device come after it): n=10 median=1035 p90=1250 target=1200 (MODE_DEFAULTS.voice_chat, first_audio); median within target: yes; p90 within target: no",
    );
    expect(o.text()).toContain(
      "first audio, heard (heardFirstAudioMs): none recorded (no player posted one: the result is the daemon-side figure)",
    );
    expect(o.text()).toContain(
      "stage medians: endOfTurnMs=20/200 finalTranscriptMs=300/300 modelFirstTokenMs=445/500 firstAudioMs=200/200 firstSentenceMs=50 ttsFirstByteMs=150",
    );
    expect(o.all.at(-1)).toBe(
      "VOICE RESULT: n=10 median=1035 p90=1250 target=1200 met (daemon-side first audio)",
    );
  });

  it("never prints transcripts or error messages, only numbers, the source and codes", async () => {
    const { home } = await seedHome([
      { hoursAgo: 2, total: 1000 },
      {
        hoursAgo: 1,
        total: null,
        error: { code: "unavailable", message: `stt failed on: ${SECRET_SAID}` },
      },
    ]);
    const o = lines();
    await runReport({ env: { FORERUNNER_HOME: home }, out: o.out, argv: [], clock: clockAt() });
    const text = o.text();
    expect(text).not.toContain("dentist");
    expect(text).not.toContain("appointment");
    expect(text).not.toContain("private");
    expect(text).toContain("error=unavailable [not counted: no first audio]");
    // The sample itself carries no text field to leak.
    const sample = turnSample({
      created_at: NOW,
      payload: { said: SECRET_SAID, heard: SECRET_HEARD, source: "audio", latency: {} },
    });
    expect(JSON.stringify(sample)).not.toContain("dentist");
  });

  it("filters by --since and defaults to the last 24 hours", async () => {
    const { home } = await seedHome([
      { hoursAgo: 48, total: 5000 },
      { hoursAgo: 30, total: 4000 },
      { hoursAgo: 5, total: 1000 },
      { hoursAgo: 1, total: 1100 },
    ]);
    const env = { FORERUNNER_HOME: home };
    const day = lines();
    const r = await runReport({ env, out: day.out, argv: [], clock: clockAt() });
    expect(r).toMatchObject({ n: 2, median: 1050 });
    expect(day.all.at(-1)).toBe(
      "VOICE RESULT: n=2 median=1050 p90=1100 target=1200 met (daemon-side first audio)",
    );

    const since = lines();
    const s = await runReport({
      env,
      out: since.out,
      argv: ["--since", "2026-10-24T00:00:00Z"],
      clock: clockAt(),
    });
    expect(s).toMatchObject({ n: 3, median: 1100, met: true });
    expect(since.text()).toContain("since 2026-10-24T00:00:00.000Z: 3");

    const all = lines();
    const a = await runReport({
      env,
      out: all.out,
      argv: ["--since", "2026-10-01T00:00:00Z"],
      clock: clockAt(),
    });
    expect(a).toMatchObject({ code: 2, n: 4, median: 2550, met: false });
    expect(all.all.at(-1)).toBe(
      "VOICE RESULT: n=4 median=2550 p90=5000 target=1200 not met (daemon-side first audio)",
    );

    const bad = lines();
    expect(
      (await runReport({ env, out: bad.out, argv: ["--since", "yesterday"], clock: clockAt() }))
        .code,
    ).toBe(1);
  });

  it("leaves typed turns and the warm-up turns out of the figures", async () => {
    const { home } = await seedHome([
      { hoursAgo: 4, total: 9000 },
      { hoursAgo: 3, total: 300, source: "text" },
      { hoursAgo: 2, total: 1000 },
      { hoursAgo: 1, total: 1200 },
    ]);
    const o = lines();
    const r = await runReport({
      env: { FORERUNNER_HOME: home },
      out: o.out,
      argv: ["--exclude-first", "1"],
      clock: clockAt(),
    });
    expect(r).toMatchObject({ n: 2, median: 1100, p90: 1200, met: true });
    expect(o.text()).toContain("totalToFirstAudioMs=9000");
    expect(o.text()).toContain("[not counted: warm-up]");
    expect(o.text()).toContain("source=text totalToFirstAudioMs=300");
    expect(o.text()).toContain("[not counted: typed turn]");
    expect(o.text()).toContain("4 in the window; 2 counted; 1 typed, 1 warm-up, 0 without");
  });

  it("decides on what the human heard when the player posted it, and prints both figures", async () => {
    // Daemon-side every turn is within 1200 ms; what the player heard adds the hop, the
    // decode, the lead and the device, and pushes the median over the target.
    const { home } = await seedHome([
      { hoursAgo: 6, total: 4000, heard: 4300 }, // the warm-up
      { hoursAgo: 5, total: 900, heard: 1150 },
      { hoursAgo: 4, total: 1000, heard: 1290 },
      // Its figure arrived after the row was written: a voice.heard row, joined by session and turn.
      { hoursAgo: 3, total: 1050, heardRow: 1310 },
      { hoursAgo: 2, total: 1100, heard: 1400 },
      // Another voice session with the same turn number: its voice.heard row is its own.
      { hoursAgo: 1, total: 950, vs: "vs-2", turnNo: 4, heardRow: 1240 },
    ]);
    const o = lines();
    const r = await runReport({
      env: { FORERUNNER_HOME: home },
      out: o.out,
      argv: ["--exclude-first", "1"],
      clock: clockAt(),
    });
    expect(r).toMatchObject({
      code: 2,
      basis: "heard",
      n: 5,
      median: 1290,
      p90: 1400,
      met: false,
    });
    const turnLines = o.all.filter((l) => / turn=\d+ /.test(l));
    expect(turnLines[3]).toContain("totalToFirstAudioMs=1050 heardFirstAudioMs=1310 ");
    expect(turnLines[5]).toContain(
      "turn=4 source=audio totalToFirstAudioMs=950 heardFirstAudioMs=1240 ",
    );
    expect(o.text()).toContain(
      "first audio, daemon-side (totalToFirstAudioMs, measured where the daemon's paced sink takes the first chunk; the SSE hop, decoding, scheduling and the output device come after it): n=5 median=1000 p90=1100",
    );
    expect(o.text()).toContain(
      "first audio, heard (heardFirstAudioMs, the panel's player: the press release to its first chunk at the speaker): n=5 median=1290 p90=1400 target=1200 (MODE_DEFAULTS.voice_chat, first_audio); median within target: no; p90 within target: no",
    );
    expect(o.all.at(-1)).toBe(
      "VOICE RESULT: n=5 median=1290 p90=1400 target=1200 not met (heard first audio)",
    );
  });

  it("says which counted turns have no heard figure and decides on the turns that have one", async () => {
    const { home } = await seedHome([
      { hoursAgo: 3, total: 900, heard: 1000 },
      { hoursAgo: 2, total: 1300 },
      { hoursAgo: 1, total: 1000, heard: 1100 },
    ]);
    const o = lines();
    const r = await runReport({
      env: { FORERUNNER_HOME: home },
      out: o.out,
      argv: [],
      clock: clockAt(),
    });
    expect(r).toMatchObject({ code: 0, basis: "heard", n: 2, median: 1050, met: true });
    expect(o.text()).toContain("totalToFirstAudioMs=1300 heardFirstAudioMs=- ");
    expect(o.text()).toContain("[no heard figure: daemon-side only]");
    expect(o.text()).toContain("1 of 3 counted turns have no heard figure");
    expect(o.all.at(-1)).toBe(
      "VOICE RESULT: n=2 median=1050 p90=1100 target=1200 met (heard first audio)",
    );
  });

  it("refuses without a dedicated FORERUNNER_HOME and a store outside it", async () => {
    const none = lines();
    expect((await runReport({ env: {}, out: none.out, argv: [] })).code).toBe(1);
    expect(none.text()).toContain("refusing to run without FORERUNNER_HOME");

    const { url } = await seedHome([{ hoursAgo: 1, total: 1000 }]);
    const other = tempHome();
    const outside = lines();
    const r = await runReport({
      env: { FORERUNNER_HOME: other, FORERUNNER_STATE_URL: url },
      out: outside.out,
      argv: [],
      clock: clockAt(),
    });
    expect(r.code).toBe(1);
    expect(outside.text()).toContain("is outside FORERUNNER_HOME");

    const shared = lines();
    await runReport({
      env: { FORERUNNER_HOME: other, FORERUNNER_STATE_URL: "postgres://u@db.invalid/x" },
      out: shared.out,
      argv: [],
    });
    expect(shared.text()).toContain("not a SQLite file");

    const empty = lines();
    await runReport({ env: { FORERUNNER_HOME: tempHome() }, out: empty.out, argv: [] });
    expect(empty.text()).toContain("no store yet");
  });

  it("runs as a script: the result line and the exit code", async () => {
    const { home } = await seedHome([{ hoursAgo: 1, total: 1000 }]);
    const run = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", join(repoRoot, "scripts", "voice-run.ts"), "report"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, FORERUNNER_HOME: "", ...env },
          timeout: 60_000,
        },
      );
    const ok = run({ FORERUNNER_HOME: home });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(
      "VOICE RESULT: n=1 median=1000 p90=1000 target=1200 met (daemon-side first audio)",
    );
    const refused = run({});
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("refusing to run without FORERUNNER_HOME");
  }, 90_000);

  it("takes the median as the gate does and p90 by the nearest rank /performance uses", () => {
    const xs = [900, 1000, 1100, 1300, 950, 1050, 980, 1020, 1150, 1250, 1400];
    for (const sample of [xs, xs.slice(0, 10), xs.slice(0, 3), [42]]) {
      const reports = sample.map((t, i) =>
        buildLatencyReport({
          turn: i,
          endOfTurnMs: 0,
          finalTranscriptMs: 0,
          modelFirstTokenMs: 0,
          firstAudioMs: t,
        }),
      );
      expect(median(sample)).toBe(medianTotalToFirstAudio(reports));
      expect(p90(sample)).toBe(nearestRank(sample, 90));
    }
    expect(median([])).toBeNull();
    expect(p90([])).toBeNull();
  });
});

/** A provider whose probe answers what the test says, never spawning anything. */
function stub<T extends SttProvider | TtsProvider>(
  base: T,
  name: string,
  ok: boolean,
  reason: string,
): T {
  return Object.assign(Object.create(base) as T, {
    name,
    kind: "local" as const,
    isAvailable: async () => ({ ok, reason }),
  });
}

function registry(opts: { whisper: boolean; kokoro: boolean }): VoiceProviderRegistry {
  const clock = new SimulatedClock(NOW);
  return new VoiceProviderRegistry()
    .registerStt(
      stub(
        new FakeStt({ clock, scripts: [] }) as SttProvider,
        "faster-whisper",
        opts.whisper,
        opts.whisper
          ? "faster_whisper importable with py"
          : "py: import faster_whisper failed: ModuleNotFoundError",
      ),
    )
    .registerTts(
      stub(
        new FakeTts({ clock }) as TtsProvider,
        "kokoro",
        opts.kokoro,
        opts.kokoro ? "kokoro importable with py" : "py: import kokoro failed: ModuleNotFoundError",
      ),
    );
}

describe("voice-run check", () => {
  let home = "";
  beforeEach(() => {
    home = tempHome();
  });

  it("passes when both local providers are available, printing each with its reason", async () => {
    const o = lines();
    const r = await runCheck({
      env: { FORERUNNER_HOME: home },
      out: o.out,
      platform: "windows",
      nodeVersion: "24.14.1",
      registry: registry({ whisper: true, kokoro: true }),
      python: async () => ({ python: "py", version: "3.12.7", reason: "runs" }),
    });
    expect(r).toMatchObject({ ok: true, stt: "faster-whisper", tts: "kokoro", commands: [] });
    const text = o.text();
    expect(text).toContain("ok  node            24.14.1");
    expect(text).toContain("ok  python          3.12.7 (py)");
    expect(text).toContain("ok  faster_whisper  faster_whisper importable with py");
    expect(text).toContain("ok  kokoro          kokoro importable with py");
    expect(text).toMatch(/\* faster-whisper\s+local\s+available/);
    expect(text).toContain("not set up yet in this home");
    expect(o.all.at(-1)).toBe("VOICE CHECK: ok");
  });

  it("fails with the install commands when a package is missing, installing nothing", async () => {
    const o = lines();
    const r = await runCheck({
      env: { FORERUNNER_HOME: home },
      out: o.out,
      platform: "windows",
      nodeVersion: "24.14.1",
      registry: registry({ whisper: false, kokoro: false }),
      python: async () => ({ python: "python", version: "3.13.1", reason: "runs" }),
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["faster_whisper", "kokoro"]);
    const venv = join(home, "voice-venv");
    expect(r.commands).toEqual([
      `py -3.12 -m venv ${venv}`,
      `${join(venv, "Scripts", "python.exe")} -m pip install faster-whisper kokoro`,
      `set FORERUNNER_PYTHON=${join(venv, "Scripts", "python.exe")}`,
    ]);
    expect(o.text()).toContain("kokoro needs Python 3.10 to below 3.13; 3.13.1 found");
    expect(o.text()).toMatch(
      /faster-whisper\s+local\s+unavailable py: import faster_whisper failed/,
    );
    expect(o.all.at(-1)).toBe("VOICE CHECK: not ready (faster_whisper, kokoro)");
  });

  it("names the interpreter in FORERUNNER_PYTHON and Python itself when it is missing", async () => {
    const withPy = lines();
    const a = await runCheck({
      env: { FORERUNNER_HOME: home, FORERUNNER_PYTHON: "/opt/py/bin/python" },
      out: withPy.out,
      platform: "linux",
      nodeVersion: "22.13.0",
      registry: registry({ whisper: false, kokoro: true }),
      python: async () => ({ python: "/opt/py/bin/python", version: "3.11.2", reason: "runs" }),
    });
    expect(a.commands).toEqual(["/opt/py/bin/python -m pip install faster-whisper"]);

    const noPy = lines();
    const b = await runCheck({
      env: { FORERUNNER_HOME: home },
      out: noPy.out,
      platform: "linux",
      nodeVersion: "20.1.0",
      registry: registry({ whisper: false, kokoro: false }),
      python: async () => ({ python: null, version: null, reason: "no python interpreter found" }),
    });
    expect(b.ok).toBe(false);
    expect(b.missing).toEqual(["node", "python", "faster_whisper", "kokoro"]);
    expect(b.commands[1]).toContain("sudo apt-get install -y python3");
    expect(noPy.text()).toContain("!!  node            20.1.0 (needs >= 22.13)");
  });

  it("refuses without a dedicated FORERUNNER_HOME", async () => {
    const o = lines();
    const r = await runCheck({
      env: {},
      out: o.out,
      registry: registry({ whisper: true, kokoro: true }),
    });
    expect(r.ok).toBe(false);
    expect(o.text()).toContain("refusing to run without FORERUNNER_HOME");
  });
});
