import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { describeError, type LessonView, type MemoryScopeView } from "../api/client.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, INPUT_CLASS, Loading } from "../components/ui.tsx";
import { formatDateTime, relativeTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";
import type { UiState } from "../store/store.ts";

export interface MemoryViewDef {
  id: string;
  label: string;
  scope: MemoryScopeView["scope"];
  agentId: string | undefined;
  /** Another human's agent: listed, never readable on this install (spec G.1, S). */
  foreign: boolean;
  active: number | null;
  pinned: number | null;
}

/**
 * The views of spec K.5 in order: the human's own principal(s) as the daemon lists them,
 * the peers' principals (listed, not readable), the critic, the shared lessons.
 */
export function memoryViews(
  scopes: MemoryScopeView[],
  state: Pick<UiState, "agents" | "me">,
): MemoryViewDef[] {
  const own = scopes
    .filter((s) => s.scope === "agent_private")
    .map((s) => ({
      id: `agent:${s.ownerAgentId ?? ""}`,
      label: s.label,
      scope: s.scope,
      agentId: s.ownerAgentId ?? undefined,
      foreign: false,
      active: s.active,
      pinned: s.pinned,
    }));
  const listed = new Set(own.map((v) => v.agentId));
  const peers = state.agents
    .filter((a) => a.kind === "principal" && !listed.has(a.id) && a.ownerHumanId !== state.me?.id)
    .map((a) => ({
      id: `agent:${a.id}`,
      label: a.name,
      scope: "agent_private" as const,
      agentId: a.id,
      foreign: true,
      active: null,
      pinned: null,
    }));
  const rest = (["critic", "shared"] as const).map((scope) => {
    const s = scopes.find((x) => x.scope === scope);
    return {
      id: scope,
      label: scope === "critic" ? "Critic" : "Shared lessons",
      scope,
      agentId: undefined,
      foreign: false,
      active: s?.active ?? null,
      pinned: s?.pinned ?? null,
    };
  });
  return [...own, ...peers, ...rest];
}

/** Pinned first, then most recently used, then newest. */
export function sortLessons(rows: LessonView[]): LessonView[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "") ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

function LessonRow({
  lesson,
  onChange,
  onDeleted,
}: {
  lesson: LessonView;
  onChange: (next: LessonView) => void;
  onDeleted: (id: string) => void;
}) {
  const client = useClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.text);
  const [tags, setTags] = useState(lesson.tags.join(", "));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const next = await client.updateLesson(lesson.id, {
        text: text.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onChange(next);
      setEditing(false);
    });
  };

  return (
    <li
      className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
      data-testid="lesson"
      data-lesson-id={lesson.id}
      data-pinned={lesson.pinned ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              onChange(await client.pinLesson(lesson.id, !lesson.pinned));
            })
          }
          disabled={busy}
          aria-pressed={lesson.pinned}
          aria-label={lesson.pinned ? "Unpin lesson" : "Pin lesson"}
          title={lesson.pinned ? "Pinned: always retrieved" : "Pin: always retrieved"}
          className={`rounded px-1 text-base ${lesson.pinned ? "text-amber-500" : "text-neutral-400"}`}
          data-testid="lesson-pin"
        >
          {lesson.pinned ? "★" : "☆"}
        </button>
        {lesson.tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <Badge title="Confidence 0 to 1">conf {Math.round(lesson.confidence * 100)}%</Badge>
        <Badge title="How often retrieval used this lesson">used {lesson.hitCount}×</Badge>
        {lesson.status !== "active" ? <Badge tone="warn">{lesson.status}</Badge> : null}
        {lesson.supersededBy ? (
          <Badge tone="warn">superseded by {lesson.supersededBy}</Badge>
        ) : null}
        <span className="ml-auto text-xs text-neutral-500">
          last used {relativeTime(lesson.lastUsed)}
        </span>
      </div>
      {editing ? (
        <form onSubmit={save} className="mt-2 space-y-2" data-testid="lesson-editor">
          <textarea
            className={`${INPUT_CLASS} min-h-20`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Lesson text"
            data-testid="lesson-text-input"
          />
          <input
            className={INPUT_CLASS}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            aria-label="Tags, comma separated"
            placeholder="tags, comma separated"
            data-testid="lesson-tags-input"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || text.trim().length === 0}
              data-testid="lesson-save"
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setText(lesson.text);
                setTags(lesson.tags.join(", "));
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-2" data-testid="lesson-text">
          {lesson.text}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>source {lesson.source}</span>
        {lesson.projectId ? <span>project {lesson.projectId}</span> : <span>all projects</span>}
        {lesson.filePath ? <code>{lesson.filePath}</code> : null}
        <span className="ml-auto flex gap-1">
          {!editing ? (
            <Button
              variant="ghost"
              onClick={() => setEditing(true)}
              disabled={busy}
              data-testid="lesson-edit"
            >
              Edit
            </Button>
          ) : null}
          {confirmDelete ? (
            <>
              <Button
                variant="danger"
                onClick={() =>
                  void run(async () => {
                    await client.deleteLesson(lesson.id);
                    onDeleted(lesson.id);
                  })
                }
                disabled={busy}
                data-testid="lesson-delete-confirm"
              >
                Confirm delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              data-testid="lesson-delete"
            >
              Delete
            </Button>
          )}
        </span>
      </div>
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} testId="lesson-error" />
        </div>
      ) : null}
    </li>
  );
}

/** Consolidation (spec G.4): the weekly job's proposals, shown for review; the inbox answers them. */
function ConsolidationSection() {
  const client = useClient();
  const proposals = useAsync((signal) => client.consolidation(signal), [client]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.runConsolidation();
      setNote(
        r.proposals > 0
          ? `${r.proposals} proposal${r.proposals === 1 ? "" : "s"} filed as an approval request in the inbox.`
          : "Consolidation ran; nothing to merge, flag or retire.",
      );
      proposals.reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // A daemon without the consolidation routes gets the same visible "route not available"
  // state as every other panel (ADR 0032), never a section that silently disappears.
  if (proposals.routeMissing) {
    return (
      <section
        className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        data-testid="consolidation"
        aria-labelledby="consolidation-title"
      >
        <h2 id="consolidation-title" className="font-semibold">
          Consolidation
        </h2>
        <div className="mt-2">
          <RouteMissing route="consolidation" what="consolidation proposals" />
        </div>
      </section>
    );
  }
  return (
    <section
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="consolidation"
      aria-labelledby="consolidation-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="consolidation-title" className="font-semibold">
          Consolidation
        </h2>
        <span className="text-xs text-neutral-500">
          Weekly: merges duplicates, flags contradictions, retires unused lessons. Changes are shown
          here and applied only after your approval in the inbox.
        </span>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => void run()}
          disabled={busy}
          data-testid="consolidation-run"
        >
          Run now
        </Button>
      </div>
      {proposals.loading && !proposals.data ? <Loading what="consolidation proposals" /> : null}
      {proposals.error && !proposals.data ? (
        <ErrorBanner message={proposals.error} onRetry={proposals.reload} />
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      {note ? (
        <output className="block text-sm" data-testid="consolidation-note">
          {note}
        </output>
      ) : null}
      {proposals.data && proposals.data.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">No proposals yet.</p>
      ) : null}
      <ul className="mt-2 space-y-2 text-sm">
        {proposals.data?.map((p) => (
          <li
            key={p.requestId}
            className="rounded bg-neutral-50 p-2 dark:bg-neutral-900"
            data-testid="consolidation-proposal"
            data-status={p.status}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={p.status === "open" ? "warn" : p.appliedAt ? "good" : "neutral"}>
                {p.status}
              </Badge>
              <span className="text-xs text-neutral-500">{formatDateTime(p.createdAt)}</span>
              {p.status === "open" ? (
                <Link
                  to="/inbox"
                  className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                >
                  answer in the inbox
                </Link>
              ) : null}
              {p.appliedAt ? (
                <span className="text-xs text-neutral-500">
                  applied {formatDateTime(p.appliedAt)}
                </span>
              ) : null}
            </div>
            {p.proposals.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {p.proposals.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            ) : null}
            {p.reports.map((r) => (
              <p
                key={`${r.scope}:${r.ownerAgentId ?? ""}:${r.ranAt}`}
                className="mt-1 text-xs text-neutral-500"
              >
                {r.scope}
                {r.ownerAgentId ? ` (${r.ownerAgentId})` : ""}: {r.merged.length} merged,{" "}
                {r.contradictions.length} contradiction{r.contradictions.length === 1 ? "" : "s"},{" "}
                {r.retired.length} retired
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Memory (spec K.5, G): separate views per agent, the critic and shared lessons; search, edit, delete, pin. */
export function MemoryPage() {
  const client = useClient();
  const state = useUiState((s) => s);
  const scopes = useAsync((signal) => client.memoryScopes(signal), [client]);
  const views = useMemo(() => memoryViews(scopes.data ?? [], state), [scopes.data, state]);
  const [viewId, setViewId] = useState<string | null>(null);
  const view = views.find((v) => v.id === viewId) ?? views[0] ?? null;
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const scope = view?.scope ?? "shared";
  const agentId = view?.agentId;
  const ready = scopes.data !== null || scopes.routeMissing;
  const lessons = useAsync(
    (signal) =>
      ready && view
        ? client.memory({ scope, agentId, q: q || undefined, limit: 200 }, signal)
        : Promise.resolve(null),
    [client, scope, agentId, q, ready, view !== null],
  );
  const rows = useMemo(() => sortLessons(lessons.data?.lessons ?? []), [lessons.data]);

  return (
    <section aria-labelledby="memory-title" className="space-y-3">
      <h1 id="memory-title" className="text-xl font-semibold">
        Memory
      </h1>
      <p className="text-xs text-neutral-500">
        Three scopes, never mixed: each agent's private memory, the critic's memory and the shared
        lessons.
      </p>
      {scopes.routeMissing || lessons.routeMissing ? (
        <RouteMissing route="memory" what="lessons" />
      ) : null}
      {scopes.error && !scopes.routeMissing && !scopes.data ? (
        <ErrorBanner message={scopes.error} onRetry={scopes.reload} />
      ) : null}
      <div
        className="flex flex-wrap gap-1"
        role="tablist"
        aria-label="Memory views"
        data-testid="memory-views"
      >
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view?.id === v.id}
            onClick={() => setViewId(v.id)}
            data-testid={`memory-view-${v.id.replace(":", "-")}`}
            className={`rounded px-3 py-1 text-sm ${
              view?.id === v.id
                ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            {v.label}
            {v.active !== null ? (
              <span className="ml-1 text-xs text-neutral-500">
                {v.active}
                {v.pinned ? ` · ${v.pinned} pinned` : ""}
              </span>
            ) : null}
            {v.foreign ? <span className="ml-1 text-xs text-neutral-500">(peer)</span> : null}
          </button>
        ))}
      </div>
      <input
        className={`${INPUT_CLASS} max-w-md`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search text and tags"
        aria-label="Search lessons"
        data-testid="memory-search"
      />
      {!lessons.routeMissing && lessons.errorStatus === 403 ? (
        <output
          className="block rounded border border-neutral-300 p-3 text-sm dark:border-neutral-700"
          data-testid="memory-not-readable"
        >
          {lessons.error} Private memory of another human's agent is listed here but never readable
          on this install.
        </output>
      ) : null}
      {!lessons.routeMissing && lessons.error && lessons.errorStatus !== 403 && !lessons.data ? (
        <ErrorBanner message={lessons.error} onRetry={lessons.reload} />
      ) : null}
      {lessons.loading && !lessons.data ? <Loading what="lessons" /> : null}
      {lessons.data && rows.length === 0 && !lessons.error ? (
        <p className="text-sm text-neutral-500" data-testid="memory-empty">
          {q
            ? "No lesson matches."
            : view?.foreign
              ? "Nothing here: a peer's private memory never syncs to this install."
              : "No lessons in this scope yet."}
        </p>
      ) : null}
      {lessons.data && !lessons.error ? (
        <ul className="space-y-2" data-testid="lessons" data-scope={scope}>
          {rows.map((l) => (
            <LessonRow
              key={l.id}
              lesson={l}
              onChange={(next) =>
                lessons.setData((prev) =>
                  prev
                    ? { ...prev, lessons: prev.lessons.map((x) => (x.id === next.id ? next : x)) }
                    : prev,
                )
              }
              onDeleted={(id) =>
                lessons.setData((prev) =>
                  prev ? { ...prev, lessons: prev.lessons.filter((x) => x.id !== id) } : prev,
                )
              }
            />
          ))}
        </ul>
      ) : null}
      <ConsolidationSection />
    </section>
  );
}
