import {
  ErrorBody,
  VoiceInstallEntryView as VoiceInstallEntrySchema,
  type VoiceInstallEntryView,
  type VoiceInstallView,
  VoiceInstallView as VoiceInstallViewSchema,
  type VoiceProfile,
} from "@forerunner/runtime/daemon/api-types";
import { ApiError, type DaemonClient, routePath } from "./client.ts";
import { readSseStream } from "./sse.ts";

/**
 * Settings → Voice (ADR 0090): the voice profile, its install as a daemon job, and the job's
 * progress. The events stream is read with fetch and the bearer header (no token in the URL);
 * a daemon that answers JSON is read once.
 */

async function failure(res: Response, what: string): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const p = ErrorBody.safeParse(body);
  return new ApiError(
    p.success ? p.data.code : "ui.http_error",
    p.success ? p.data.message : `${res.status}: ${what} failed`,
    res.status,
  );
}

export async function voiceInstallView(
  client: DaemonClient,
  signal?: AbortSignal,
): Promise<VoiceInstallView> {
  const res = await client.raw({ method: "GET", path: routePath("voiceInstall"), signal });
  if (!res.ok) throw await failure(res, "voice settings");
  return VoiceInstallViewSchema.parse(await res.json());
}

export async function startVoiceInstall(
  client: DaemonClient,
  profile: VoiceProfile,
): Promise<VoiceInstallView> {
  const res = await client.raw({
    method: "POST",
    path: routePath("startVoiceInstall"),
    body: { profile },
  });
  if (!res.ok) throw await failure(res, "voice install");
  return VoiceInstallViewSchema.parse(await res.json());
}

/** Cancel the running install; resolves with the view once it has stopped. */
export async function cancelVoiceInstall(client: DaemonClient): Promise<VoiceInstallView> {
  const res = await client.raw({ method: "POST", path: routePath("cancelVoiceInstall"), body: {} });
  if (!res.ok) throw await failure(res, "cancelling the voice install");
  return VoiceInstallViewSchema.parse(await res.json());
}

/** Follow the job's events after `afterSeq` until the job ends (or `signal` aborts). */
export async function followVoiceInstall(
  client: DaemonClient,
  afterSeq: number,
  onEntry: (e: VoiceInstallEntryView) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await client.raw({
    method: "GET",
    path: routePath("voiceInstallEvents"),
    query: { afterSeq },
    accept: "text/event-stream",
    signal,
  });
  if (!res.ok) throw await failure(res, "voice install progress");
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const raw of (await res.json()) as unknown[]) {
      const p = VoiceInstallEntrySchema.safeParse(raw);
      if (p.success) onEntry(p.data);
    }
    return;
  }
  for await (const frame of readSseStream(res)) {
    if (frame.event !== "voice.install") continue;
    try {
      const p = VoiceInstallEntrySchema.safeParse(JSON.parse(frame.data));
      if (p.success) onEntry(p.data);
    } catch {
      // a frame that is not JSON is skipped
    }
  }
}
