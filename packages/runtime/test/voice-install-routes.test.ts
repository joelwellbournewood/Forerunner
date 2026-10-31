import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { type AppDirs, appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { DAEMON_ROUTES } from "../src/daemon/api-types.ts";
import { composeRuntime } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { installVoice, readVoiceSettings, voiceDirs } from "../src/voice/install.ts";
import { createVoiceInstallRoutes, VoiceInstallJobs } from "../src/voice/install-routes.ts";
import { VoiceInstallEntryView, VoiceInstallView } from "../src/voice/install-types.ts";
import { fakeRunner, NVIDIA, torchOnlyDeepDir } from "./voice-install-helpers.ts";

/**
 * Settings → Voice through the daemon (ADR 0090): the view with the catalog and the GPU, an
 * install or switch as a background job with its progress replayable as JSON or SSE, one job at
 * a time, refused while a voice session is open, and the helpers stopped before an old venv is
 * deleted.
 */

function setup(opts: { busy?: string | null; nvidia?: boolean; gate?: Promise<void> } = {}) {
  const h = mkdtempSync(join(tmpdir(), "fr-voice-routes-"));
  const env = { FORERUNNER_HOME: h };
  const dirs: AppDirs = appDirs({ env });
  const fake = fakeRunner({ nvidiaSmi: opts.nvidia === false ? null : NVIDIA });
  let released = 0;
  const jobs = new VoiceInstallJobs({
    dirs,
    env,
    clock: new SimulatedClock("2026-10-26T10:00:00Z"),
    platform: "linux",
    run: async (req) => {
      // Held at the packages step until the test opens the gate.
      if (opts.gate && req.argv.includes("-r")) await opts.gate;
      return fake.run(req);
    },
    busy: () => opts.busy ?? null,
    release: async () => {
      released++;
    },
  });
  const app = createVoiceInstallRoutes({ jobs });
  return { app, jobs, dirs, env, fake, released: () => released };
}

describe("GET /voice/install: where the next install goes (U-069)", () => {
  it("Windows without long paths and an install folder too deep: Settings → Voice names the data folder and says why", async () => {
    const h = mkdtempSync(join(tmpdir(), "fr-voice-routes-deep-"));
    const env = { FORERUNNER_HOME: h };
    const dirs: AppDirs = appDirs({ env });
    const deep = torchOnlyDeepDir(h, dirs);
    const view = async (longPaths: boolean) => {
      const fake = fakeRunner({ nvidiaSmi: NVIDIA, longPaths });
      const jobs = new VoiceInstallJobs({
        dirs,
        env,
        clock: new SimulatedClock("2026-10-31T10:00:00Z"),
        platform: "windows",
        run: fake.run,
        busy: () => null,
        release: async () => {},
        dependencies: () => ({ dir: deep, source: "install", note: null }),
      });
      const app = createVoiceInstallRoutes({ jobs });
      return VoiceInstallView.parse(await (await app.request("/voice/install")).json());
    };
    const off = await view(false);
    expect(off.folder).toBe(voiceDirs(dirs, dirs.data).root);
    expect(off.folderNote).toContain("too deep for Windows without long paths");
    expect(off.folderNote).toContain("turn on Windows long paths");
    const on = await view(true);
    expect(on.folder).toBe(voiceDirs(dirs, deep).root);
    expect(on.folderNote).toBeNull();
  });
});

describe("GET/POST /voice/install", () => {
  it("shows the catalog with sizes and trade-offs, the GPU and gpu recommended with NVIDIA", async () => {
    const { app } = setup();
    const v = VoiceInstallView.parse(await (await app.request("/voice/install")).json());
    expect(v.profile).toBeNull();
    expect(v.profiles.map((p) => p.profile)).toEqual(["none", "cpu", "gpu"]);
    expect(v.profiles.find((p) => p.profile === "gpu")?.disk).toMatch(/GB/);
    expect(v.profiles.find((p) => p.profile === "cpu")?.tradeOff).toMatch(/slower/);
    expect(v.gpu.name).toBe("NVIDIA GeForce RTX 4070");
    expect(v.recommended).toBe("gpu");
    expect(v.cli).toBe("fr voice install --gpu");
    expect(v.job).toBeNull();
    const cpuOnly = setup({ nvidia: false });
    const w = VoiceInstallView.parse(await (await cpuOnly.app.request("/voice/install")).json());
    expect(w.recommended).toBe("cpu");
  });

  it("installs in the background with replayable progress, one job at a time", async () => {
    let open = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const { app, jobs, dirs } = setup({ gate });
    const post = (profile: string) =>
      app.request("/voice/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile }),
      });
    const r = await post("cpu");
    expect(r.status).toBe(202);
    const started = VoiceInstallView.parse(await r.json());
    expect(started.job?.state).toBe("running");
    const again = await post("gpu");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { message: string }).message).toMatch(/running/);
    open();
    await jobs.settled;
    const v = VoiceInstallView.parse(await (await app.request("/voice/install")).json());
    expect(v.profile).toBe("cpu");
    expect(v.job).toMatchObject({ state: "done", exitCode: 0 });
    expect(v.stt).toEqual({ device: "cpu", computeType: "int8", fallback: null });
    expect(readVoiceSettings(dirs)?.profile).toBe("cpu");
    // JSON replay from a sequence number.
    const all = (await (await app.request("/voice/install/events")).json()) as unknown[];
    const entries = all.map((e) => VoiceInstallEntryView.parse(e));
    expect(entries.at(-1)?.event).toMatchObject({ type: "result", ok: true, exitCode: 0 });
    const tail = (await (
      await app.request("/voice/install/events?afterSeq=3")
    ).json()) as unknown[];
    expect(tail).toHaveLength(entries.length - 3);
    // SSE: a finished job replays and the stream ends.
    const sse = await app.request("/voice/install/events?afterSeq=0", {
      headers: { accept: "text/event-stream" },
    });
    const text = await sse.text();
    expect(text).toContain("event: voice.install");
    expect(text.match(/event: voice\.install/g)).toHaveLength(entries.length);
    expect(text).toContain('"type":"result"');
  });

  it("refuses while a voice session is open, and a profile that does not exist", async () => {
    const { app } = setup({ busy: "a voice session is open; stop it before switching voice" });
    const r = await app.request("/voice/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "gpu" }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toMatch(/voice session is open/);
    const bad = await app.request("/voice/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "tpu" }),
    });
    expect(bad.status).toBe(400);
  });

  it("a switch stops the helpers before the old venv goes; none removes everything", async () => {
    const { app, jobs, dirs, env, released } = setup();
    await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: () => {},
    });
    await app.request("/voice/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "gpu" }),
    });
    await jobs.settled;
    expect(released()).toBe(1);
    expect(existsSync(voiceDirs(dirs).venv("cpu"))).toBe(false);
    await app.request("/voice/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "none" }),
    });
    await jobs.settled;
    expect(released()).toBe(2);
    expect(readVoiceSettings(dirs)?.profile).toBe("none");
    expect(existsSync(voiceDirs(dirs).venv("gpu"))).toBe(false);
  });
});

describe("cancelling an install", () => {
  it("POST /voice/install/cancel aborts the running job; the result says cancelled", async () => {
    const h = mkdtempSync(join(tmpdir(), "fr-voice-routes-cancel-"));
    const env = { FORERUNNER_HOME: h };
    const fake = fakeRunner({ nvidiaSmi: null });
    let signalled: AbortSignal | undefined;
    const jobs = new VoiceInstallJobs({
      dirs: appDirs({ env }),
      env,
      clock: new SimulatedClock(),
      platform: "linux",
      run: async (req) => {
        if (req.argv.some((a) => a.endsWith("torch-cpu.txt"))) {
          signalled = req.signal;
          // A long download, until the signal aborts it.
          await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r()));
          return { code: null, stdout: Buffer.alloc(0), stderr: "killed" };
        }
        return fake.run(req);
      },
      busy: () => null,
      release: async () => {},
    });
    const app = createVoiceInstallRoutes({ jobs });
    expect((await app.request("/voice/install/cancel", { method: "POST" })).status).toBe(409);
    await app.request("/voice/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "cpu" }),
    });
    for (let i = 0; i < 50 && !signalled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(signalled).toBeDefined();
    const r = await app.request("/voice/install/cancel", { method: "POST" });
    expect(r.status).toBe(202);
    await jobs.settled;
    const v = VoiceInstallView.parse(await (await app.request("/voice/install")).json());
    expect(v.job).toMatchObject({ state: "failed", exitCode: 1 });
    expect(JSON.stringify(v.job?.recent.at(-1))).toMatch(/cancelled/);
    expect(DAEMON_ROUTES.cancelVoiceInstall).toMatch(/^POST \/voice\/install\/cancel/);
  });
});

describe("the daemon serves the voice install routes", () => {
  it("behind the bearer token, listed in DAEMON_ROUTES", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-voice-routes-daemon-"));
    const env = { FORERUNNER_HOME: home };
    const rt = await composeRuntime({
      env,
      dirs: appDirs({ env }),
      config: null,
      clock: new SimulatedClock(),
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: { installRunner: fakeRunner({ nvidiaSmi: null }).run },
    });
    try {
      const { app, token } = createDaemonApp(rt);
      expect((await app.request("/voice/install")).status).toBe(401);
      const r = await app.request("/voice/install", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(200);
      const v = VoiceInstallView.parse(await r.json());
      expect(v.recommended).toBe("cpu");
      expect(DAEMON_ROUTES.voiceInstall).toMatch(/^GET \/voice\/install/);
      expect(DAEMON_ROUTES.startVoiceInstall).toMatch(/^POST \/voice\/install/);
      expect(DAEMON_ROUTES.voiceInstallEvents).toMatch(/^GET \/voice\/install\/events/);
    } finally {
      await rt.close();
    }
  });

  it("a daemon stop cancels a running install; a voice install blocks local voice meanwhile", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-voice-routes-stop-"));
    const env = { FORERUNNER_HOME: home };
    const fake = fakeRunner({ nvidiaSmi: null });
    let aborted = false;
    let downloading = false;
    const rt = await composeRuntime({
      env,
      dirs: appDirs({ env }),
      config: null,
      clock: new SimulatedClock(),
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: {
        installRunner: async (req) => {
          if (req.argv.some((a) => a.endsWith("torch-cpu.txt"))) {
            downloading = true;
            await new Promise<void>((r) =>
              req.signal?.addEventListener("abort", () => {
                aborted = true;
                r();
              }),
            );
            return { code: null, stdout: Buffer.alloc(0), stderr: "killed" };
          }
          return fake.run(req);
        },
      },
    });
    rt.voiceInstall.start("cpu");
    for (let i = 0; i < 100 && !downloading; i++) await new Promise((r) => setTimeout(r, 10));
    expect(downloading).toBe(true);
    expect(await rt.localVoice.stt.isAvailable()).toEqual({
      ok: false,
      reason: expect.stringMatching(/voice install is running/),
    });
    await rt.close();
    expect(aborted).toBe(true);
    expect(rt.voiceInstall.running).toBe(false);
  });
});
