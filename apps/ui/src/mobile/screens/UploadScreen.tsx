import { useCallback, useEffect, useState } from "react";
import { describeStateError, type UploadView } from "../../api/state-client.ts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
} from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { formatBytes, useMobileController, useMobileState } from "../store.tsx";

/**
 * Upload photos, files and documents to a project (spec R.5; ADR 0080). The human picks a
 * file (or takes a photo through the WebView's camera input), names it, picks the project,
 * and the phone sends it to the service's `POST /projects/:id/uploads` as signed multipart.
 * The service's size cap is shown before a file is picked and checked before a byte leaves.
 * Offline, the file is queued with its clientId and sent on reconnect. The Android shell
 * has no file-picker or share-target command yet; the web file input is the picker.
 */
type Phase = "idle" | "reading" | "sending" | "stored" | "queued";

const PHASE_PROGRESS: Record<Phase, number> = {
  idle: 0,
  reading: 25,
  sending: 60,
  stored: 100,
  queued: 100,
};

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  reading: "Reading the file…",
  sending: "Sending to the project…",
  stored: "Uploaded.",
  queued: "Offline: queued, sent when the phone reconnects.",
};

function kindOf(type: string): "photo" | "document" | "file" {
  if (type.startsWith("image/")) return "photo";
  if (
    type === "application/pdf" ||
    type.startsWith("text/") ||
    type.includes("document") ||
    type.includes("msword") ||
    type.includes("spreadsheet") ||
    type.includes("presentation")
  ) {
    return "document";
  }
  return "file";
}

/** The picked file's bytes (FileReader where Blob.arrayBuffer is missing, as in old WebViews). */
async function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsArrayBuffer(file);
  });
}

export function UploadScreen() {
  const controller = useMobileController();
  const projects = useMobileState((s) => s.projects);
  const activeProjectId = useMobileState((s) => s.activeProjectId);
  const stage = useMobileState((s) => s.stage);
  const [projectId, setProjectId] = useState<string>(activeProjectId ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"photo" | "document" | "file">("file");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadView[] | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(controller.uploadMaxBytes);
  const [inputKey, setInputKey] = useState(0);

  useEffect(() => {
    if (!projectId && activeProjectId) setProjectId(activeProjectId);
  }, [activeProjectId, projectId]);

  const reload = useCallback(
    async (id: string) => {
      try {
        setUploads(await controller.loadUploads(id));
        setMaxBytes(controller.uploadMaxBytes);
      } catch (e) {
        setUploads([]);
        setError(describeStateError(e));
      }
    },
    [controller],
  );

  useEffect(() => {
    if (stage === "paired" && projectId) void reload(projectId);
  }, [stage, projectId, reload]);

  if (stage !== "paired") return null;

  const tooLarge = file !== null && maxBytes !== null && file.size > maxBytes;
  const busy = phase === "reading" || phase === "sending";

  const pick = (picked: File | null) => {
    setError(null);
    setPhase("idle");
    setFile(picked);
    setName(picked?.name ?? "");
    setKind(picked ? kindOf(picked.type) : "file");
  };

  const send = async () => {
    if (!file || !projectId || busy || tooLarge) return;
    setError(null);
    setPhase("reading");
    try {
      const bytes = await readBytes(file);
      setPhase("sending");
      const r = await controller.uploadFile(
        projectId,
        { name: name.trim() || file.name || "upload", type: file.type, bytes },
        kind,
      );
      setPhase(r.queued ? "queued" : "stored");
      setFile(null);
      setName("");
      setInputKey((k) => k + 1);
      if (!r.queued) await reload(projectId);
    } catch (e) {
      setPhase("idle");
      setMaxBytes(controller.uploadMaxBytes);
      setError(describeStateError(e));
    }
  };

  return (
    <section aria-labelledby="m-upload-title" className="space-y-3">
      <h1 id="m-upload-title" className="text-xl font-semibold">
        Upload
      </h1>
      <p className="text-xs text-neutral-500" data-testid="m-upload-cap">
        Photos, files and documents go to the project's data assets
        {maxBytes !== null ? `, up to ${formatBytes(maxBytes)} each` : ""}.
      </p>
      <Field label="Project">
        <select
          className={INPUT_CLASS}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          data-testid="m-upload-project"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="File or document">
        <input
          key={`file-${inputKey}`}
          type="file"
          className="block w-full text-sm"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
          data-testid="m-upload-file"
        />
      </Field>
      <Field label="Or take a photo">
        <input
          key={`photo-${inputKey}`}
          type="file"
          accept="image/*"
          capture="environment"
          className="block w-full text-sm"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
          data-testid="m-upload-photo"
        />
      </Field>
      {file ? (
        <div className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <Field label="Name">
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="m-upload-name"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge testId="m-upload-size" tone={tooLarge ? "bad" : "neutral"}>
              {formatBytes(file.size)}
            </Badge>
            <select
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              aria-label="Kind"
              data-testid="m-upload-kind"
            >
              <option value="photo">photo</option>
              <option value="document">document</option>
              <option value="file">file</option>
            </select>
          </div>
          {tooLarge && maxBytes !== null ? (
            <p className="text-xs text-red-700 dark:text-red-300" data-testid="m-upload-too-large">
              Too large: the limit is {formatBytes(maxBytes)}.
            </p>
          ) : null}
        </div>
      ) : null}
      <Button
        variant="primary"
        onClick={() => void send()}
        disabled={!file || !projectId || busy || tooLarge}
        data-testid="m-upload-send"
      >
        Upload
      </Button>
      {phase !== "idle" ? (
        <div className="space-y-1" data-testid="m-upload-progress" data-phase={phase}>
          <progress
            className="w-full"
            max={100}
            value={PHASE_PROGRESS[phase]}
            aria-label="Upload progress"
          />
          <p className="text-xs text-neutral-600 dark:text-neutral-400">{PHASE_LABEL[phase]}</p>
        </div>
      ) : null}
      {error ? <ErrorBanner message={error} testId="m-upload-error" /> : null}
      <h2 className="font-semibold">In this project</h2>
      {uploads === null ? <Loading what="uploads" /> : null}
      {uploads && uploads.length === 0 ? <EmptyState>Nothing uploaded yet.</EmptyState> : null}
      <ul className="space-y-1" data-testid="m-upload-list">
        {(uploads ?? []).map((u) => (
          <li key={u.id} className="flex items-center gap-2 text-sm" data-testid="m-upload-row">
            <span className="truncate">{u.name}</span>
            <Badge>{u.kind}</Badge>
            <span className="ml-auto text-xs text-neutral-500">
              {formatBytes(u.sizeBytes)} · {relativeTime(u.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
