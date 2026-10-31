/**
 * Settings → Sandbox (Docker) shapes and words (U-079, ADR 0101). Browser-safe (zod only, no
 * node imports): the daemon's routes, the session summary, the Start dialog, the Inbox notice
 * and the Settings card say the same thing in the same words.
 *
 * Tasks at risk tier 2 and above get a full review: they run their tests and builds in a
 * Docker (or Podman) container with only the task's folder mounted. Until that sandbox is
 * ready they wait; nothing fails and no retry is used.
 */
import { z } from "zod";

/**
 * Where the sandbox stands, in the order a person fixes it: no Docker, Docker not started,
 * Docker Desktop on Windows containers, the image not downloaded, downloading, ready.
 */
export const SANDBOX_STATES = [
  "not_installed",
  "not_running",
  "windows_containers",
  "image_missing",
  "pulling",
  "ready",
] as const;
export const SandboxStateSchema = z.enum(SANDBOX_STATES);
export type SandboxState = z.infer<typeof SandboxStateSchema>;

/** One event of a sandbox download, in order. */
export const SandboxPullEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("step"), message: z.string() }),
  /** Image layers downloaded and unpacked so far, of those the registry listed. */
  z.object({ type: z.literal("layers"), done: z.number().int(), total: z.number().int() }),
  z.object({ type: z.literal("log"), message: z.string() }),
  z.object({ type: z.literal("warning"), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("result"),
    ok: z.boolean(),
    /** The image now on this computer (the fallback when the version tag was not published). */
    image: z.string(),
    message: z.string(),
  }),
]);
export type SandboxPullEvent = z.infer<typeof SandboxPullEvent>;

export const SandboxPullEntryView = z.object({ seq: z.number().int(), event: SandboxPullEvent });
export type SandboxPullEntryView = z.infer<typeof SandboxPullEntryView>;

export const SandboxPullJobView = z.object({
  id: z.string(),
  image: z.string(),
  state: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  layersDone: z.number().int(),
  layersTotal: z.number().int(),
  /** The last events (the whole stream is on the events route). */
  recent: z.array(SandboxPullEntryView),
});
export type SandboxPullJobView = z.infer<typeof SandboxPullJobView>;

/** `GET /sandbox`: the state, what it needs from the person, and the download if one runs. */
export const SandboxStatusView = z.object({
  state: SandboxStateSchema,
  ready: z.boolean(),
  engine: z.enum(["docker", "podman", "none"]),
  engineVersion: z.string().nullable(),
  /** The daemon's OS (the steps differ: Docker Desktop on Windows, Docker Engine on Linux). */
  platform: z.string(),
  /** The image full-review tasks run in. */
  image: z.string(),
  imageSource: z.enum(["config", "env", "build", "local"]),
  /** False for the local image a source checkout builds; the card then shows the build command. */
  pullable: z.boolean(),
  /** Download size in bytes as the registry lists it; null when unknown. */
  downloadBytes: z.number().int().nullable(),
  /** What the check saw (the engine's own words). */
  reason: z.string(),
  headline: z.string(),
  steps: z.array(z.string()),
  why: z.string(),
  /** Ready tasks at risk tier 2 and above that wait for the sandbox now. */
  waiting: z.number().int().nonnegative(),
  checkedAt: z.string(),
  pull: SandboxPullJobView.nullable(),
});
export type SandboxStatusView = z.infer<typeof SandboxStatusView>;

export const SANDBOX_ROUTES = {
  sandboxStatus:
    "GET /sandbox (SandboxStatusView: the Docker sandbox for full-review tasks, U-079: not_installed, not_running, windows_containers, image_missing, pulling or ready, with the plain steps for it, the image and its download size, the ready tasks at tier 2+ that wait, the running or last download)",
  checkSandbox:
    "POST /sandbox/check (-> SandboxStatusView after a fresh check: docker info, the image on this computer; Settings' Check again)",
  pullSandbox:
    "POST /sandbox/pull (-> 202 SandboxStatusView: downloads the image in the background (docker pull; the version tag, else latest when the registry has no image for this version); a running download is followed, not started twice; 409 conflict while Docker is not installed, not running or on Windows containers, or for a local image that is built, not downloaded)",
  sandboxPullEvents:
    "GET /sandbox/pull/events?afterSeq= (SandboxPullEntryView[] as JSON) | Accept: text/event-stream (SSE `sandbox.pull` frames, bearer header; ends with the download)",
} as const;

/** Why the sandbox exists, in the person's words. */
export const SANDBOX_WHY =
  "Full-review tasks (risk tier 2 and above) run their tests and builds in this sandbox, isolated from your computer, so the critic sees real results. Until it is ready they wait: nothing fails and no retry is used.";

/** Where the person fixes it. */
export const SANDBOX_SETTINGS_PLACE = "Settings → Sandbox (Docker)";

/** The install page for Docker Desktop (shown as a link on the card). */
export const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";

export interface SandboxWordsInput {
  state: SandboxState;
  /** The daemon's OS: "windows", "linux", "macos". */
  platform: string;
  image: string;
  pullable: boolean;
  engine?: string;
  engineVersion?: string | null;
  downloadBytes?: number | null;
}

/** "about 1.2 GB" / "about 640 MB" from bytes; null when unknown. */
export function sizeWords(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  return bytes >= 1e9
    ? `about ${(bytes / 1e9).toFixed(1)} GB`
    : `about ${Math.ceil(bytes / 1e6)} MB`;
}

/** The command a source checkout builds the local image with. */
export const LOCAL_IMAGE_BUILD_COMMAND =
  "docker build -t forerunner-runner:local -f services/cloud-runner/Dockerfile .";

/** The headline and the steps for a state: one source for every place that shows it. */
export function sandboxWords(input: SandboxWordsInput): { headline: string; steps: string[] } {
  const desktop = input.platform !== "linux";
  const check = `Click Check again in ${SANDBOX_SETTINGS_PLACE}.`;
  switch (input.state) {
    case "not_installed":
      return {
        headline: "Docker is not installed on this computer.",
        steps: desktop
          ? [
              `Install Docker Desktop (${DOCKER_DESKTOP_URL}) with its default settings (on Windows it uses WSL 2).`,
              "Start Docker Desktop and wait until it says the engine is running.",
              check,
            ]
          : [
              "Install Docker Engine (or Docker Desktop, or Podman) and let your user run it (the docker group, or rootless Docker).",
              "Start it.",
              check,
            ],
      };
    case "not_running":
      return {
        headline: "Docker is installed but not running.",
        steps: desktop
          ? ["Start Docker Desktop and wait until it says the engine is running.", check]
          : [
              "Start Docker: sudo systemctl start docker (systemctl --user start docker for rootless Docker).",
              check,
            ],
      };
    case "windows_containers":
      return {
        headline: "Docker Desktop runs Windows containers; the sandbox needs Linux containers.",
        steps: [
          "Right-click the Docker icon in the taskbar and choose Switch to Linux containers.",
          "Wait until Docker Desktop has restarted.",
          check,
        ],
      };
    case "image_missing": {
      if (!input.pullable)
        return {
          headline: `Docker is ready; the sandbox image ${input.image} is not on this computer.`,
          steps: [
            `Build it from the source checkout: ${LOCAL_IMAGE_BUILD_COMMAND}`,
            "Or set FORERUNNER_RUNNER_IMAGE to a published runner image.",
            check,
          ],
        };
      const size = sizeWords(input.downloadBytes);
      return {
        headline: "Docker is ready; the sandbox is not downloaded yet.",
        steps: [
          `Click Download the sandbox in ${SANDBOX_SETTINGS_PLACE}${size ? ` (${size})` : ""}; the progress shows there.`,
        ],
      };
    }
    case "pulling":
      return {
        headline: "Downloading the sandbox.",
        steps: [
          `The download runs in the background; ${SANDBOX_SETTINGS_PLACE} shows its progress. Full-review tasks run in the next session once it is done.`,
        ],
      };
    case "ready":
      return {
        headline: `Ready: full-review tasks run in ${input.image}${
          input.engine && input.engine !== "none"
            ? ` on ${input.engine}${input.engineVersion ? ` ${input.engineVersion}` : ""}`
            : ""
        }.`,
        steps: [],
      };
  }
}

/** The one step a waiting line names (the summary, the Start dialog, the Inbox notice). */
export function sandboxNextStep(input: SandboxWordsInput): string {
  const desktop = input.platform !== "linux";
  switch (input.state) {
    case "not_installed":
      return desktop
        ? `install Docker Desktop and start it, then Check again in ${SANDBOX_SETTINGS_PLACE}`
        : `install Docker (or Podman) and start it, then Check again in ${SANDBOX_SETTINGS_PLACE}`;
    case "not_running":
      return `start ${desktop ? "Docker Desktop" : "Docker"}, then Check again in ${SANDBOX_SETTINGS_PLACE}`;
    case "windows_containers":
      return `switch Docker Desktop to Linux containers (right-click its taskbar icon), then Check again in ${SANDBOX_SETTINGS_PLACE}`;
    case "image_missing":
      return input.pullable
        ? `click Download the sandbox in ${SANDBOX_SETTINGS_PLACE}`
        : `build the sandbox image (${LOCAL_IMAGE_BUILD_COMMAND}), then Check again in ${SANDBOX_SETTINGS_PLACE}`;
    case "pulling":
      return `wait for the sandbox download to finish (${SANDBOX_SETTINGS_PLACE} shows it)`;
    case "ready":
      return "nothing: the sandbox is ready";
  }
}
