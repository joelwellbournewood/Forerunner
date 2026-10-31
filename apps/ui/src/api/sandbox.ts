import { ErrorBody } from "@forerunner/runtime/daemon/api-types";
import {
  SandboxPullEntryView as SandboxPullEntrySchema,
  type SandboxPullEntryView,
} from "@forerunner/runtime/sandbox/readiness-types";
import { ApiError, type DaemonClient, routePath } from "./client.ts";
import { readSseStream } from "./sse.ts";

/**
 * Settings → Sandbox (Docker) (U-079, ADR 0101): the download's progress. The events stream is
 * read with fetch and the bearer header (no token in the URL), as the voice install's is; a
 * daemon that answers JSON is read once.
 */
export async function followSandboxPull(
  client: DaemonClient,
  afterSeq: number,
  onEntry: (e: SandboxPullEntryView) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await client.raw({
    method: "GET",
    path: routePath("sandboxPullEvents"),
    query: { afterSeq },
    accept: "text/event-stream",
    signal,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const p = ErrorBody.safeParse(body);
    throw new ApiError(
      p.success ? p.data.code : "ui.http_error",
      p.success ? p.data.message : `${res.status}: the sandbox download's progress failed`,
      res.status,
    );
  }
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const raw of (await res.json()) as unknown[]) {
      const p = SandboxPullEntrySchema.safeParse(raw);
      if (p.success) onEntry(p.data);
    }
    return;
  }
  for await (const frame of readSseStream(res)) {
    if (frame.event !== "sandbox.pull") continue;
    try {
      const p = SandboxPullEntrySchema.safeParse(JSON.parse(frame.data));
      if (p.success) onEntry(p.data);
    } catch {
      // a frame that is not JSON is skipped
    }
  }
}

/** What the progress area shows: the layers bar and the last lines. */
export function pullProgress(entries: SandboxPullEntryView[]): {
  percent: number | null;
  layers: string | null;
  lines: { tone: "neutral" | "warn" | "bad" | "good"; text: string }[];
  result: { ok: boolean; message: string } | null;
} {
  let percent: number | null = null;
  let layers: string | null = null;
  const lines: { tone: "neutral" | "warn" | "bad" | "good"; text: string }[] = [];
  let result: { ok: boolean; message: string } | null = null;
  for (const { event: e } of entries) {
    if (e.type === "layers") {
      percent = e.total > 0 ? Math.floor((e.done / e.total) * 100) : null;
      layers = `${e.done} of ${e.total} parts`;
    } else if (e.type === "step") lines.push({ tone: "neutral", text: e.message });
    else if (e.type === "log") lines.push({ tone: "neutral", text: e.message });
    else if (e.type === "warning") lines.push({ tone: "warn", text: e.message });
    else if (e.type === "error") lines.push({ tone: "bad", text: e.message });
    else if (e.type === "result") {
      result = { ok: e.ok, message: e.message };
      lines.push({ tone: e.ok ? "good" : "bad", text: e.message });
    }
  }
  return { percent, layers, lines: lines.slice(-6), result };
}
