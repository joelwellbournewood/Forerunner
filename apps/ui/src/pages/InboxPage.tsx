import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  describeError,
  type HumanRequestView,
  type InboxView,
  type MessageView,
} from "../api/client.ts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  INPUT_CLASS,
  Loading,
  statusTone,
} from "../components/ui.tsx";
import { relativeTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";

/** Blocking first, then newest first. */
export function sortRequests(requests: HumanRequestView[]): HumanRequestView[] {
  return [...requests].sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function sortMessages(messages: MessageView[]): MessageView[] {
  return [...messages].sort((a, b) => {
    const aUnread = a.readAt === null ? 0 : 1;
    const bUnread = b.readAt === null ? 0 : 1;
    if (aUnread !== bUnread) return aUnread - bUnread;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Inbox (spec K.4, J.3): human requests and agent messages, blocking first. */
export function InboxPage() {
  const client = useClient();
  const store = useUiStore();
  const me = useUiState((s) => s.me);
  const humanId = me?.id ?? null;
  const inbox = useAsync<InboxView | null>(
    (signal) => (humanId ? client.inbox(humanId, signal) : Promise.resolve(null)),
    [client, humanId],
  );

  // The page keeps the header badge in step with what it loaded, and reloads when the
  // install stream (`inbox.changed` on /events, or the poll) reports a count it has not seen,
  // so an answer given elsewhere (phone, chat, another device) shows up without Refresh.
  const blockingCount = inbox.data?.blockingCount ?? null;
  const loadedCount = useRef<number | null>(null);
  useEffect(() => {
    if (blockingCount === null) return;
    loadedCount.current = blockingCount;
    store.dispatch({ type: "blockingCount", count: blockingCount });
  }, [blockingCount, store]);
  const streamedCount = useUiState((s) => s.blockingCount);
  const reload = inbox.reload;
  useEffect(() => {
    if (loadedCount.current === null || streamedCount === loadedCount.current) return;
    reload();
  }, [streamedCount, reload]);

  const answer = async (request: HumanRequestView, value: unknown) => {
    await client.answerRequest(request.id, { version: request.version, answer: value });
    inbox.reload();
  };

  const markRead = async (message: MessageView) => {
    const updated = await client.markRead(message.id);
    inbox.setData((prev) =>
      prev
        ? { ...prev, messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)) }
        : prev,
    );
  };

  if (!humanId) return <Loading what="your identity" />;
  if (inbox.loading && !inbox.data) return <Loading what="inbox" />;
  if (inbox.error && !inbox.data)
    return <ErrorBanner message={inbox.error} onRetry={inbox.reload} />;
  const data = inbox.data;
  if (!data) return null;

  const requests = sortRequests(data.requests.filter((r) => r.status === "open"));
  const answered = sortRequests(data.requests.filter((r) => r.status !== "open"));
  const messages = sortMessages(data.messages);

  return (
    <section aria-labelledby="inbox-title" className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 id="inbox-title" className="text-xl font-semibold">
          Inbox
        </h1>
        <Badge tone={data.blockingCount > 0 ? "bad" : "neutral"} testId="blocking-count">
          {data.blockingCount} blocking
        </Badge>
        <Button variant="ghost" onClick={inbox.reload} className="ml-auto">
          Refresh
        </Button>
      </div>
      {inbox.error ? <ErrorBanner message={inbox.error} onRetry={inbox.reload} /> : null}

      <h2 className="font-semibold">Requests</h2>
      {requests.length === 0 ? (
        <EmptyState testId="no-requests">Nothing waits on you.</EmptyState>
      ) : null}
      <ol className="space-y-3" data-testid="request-list">
        {requests.map((r) => (
          <RequestCard key={r.id} request={r} onAnswer={(value) => answer(r, value)} />
        ))}
      </ol>

      <h2 className="font-semibold">Messages</h2>
      {messages.length === 0 ? <EmptyState>No messages.</EmptyState> : null}
      <ol className="space-y-2" data-testid="message-list">
        {messages.map((m) => (
          <li
            key={m.id}
            className={`rounded border p-3 text-sm ${
              m.readAt
                ? "border-neutral-200 text-neutral-600 dark:border-neutral-800 dark:text-neutral-400"
                : "border-blue-300 dark:border-blue-800"
            }`}
            data-testid="message"
            data-read={m.readAt ? "true" : "false"}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{m.fromAgentName}</span>
              <Badge>{m.type}</Badge>
              {m.requiresAck ? <Badge tone="warn">needs acknowledgement</Badge> : null}
              <span className="text-xs text-neutral-500">{relativeTime(m.createdAt)}</span>
              {m.readAt ? null : (
                <Button
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => void markRead(m)}
                  data-testid="mark-read"
                >
                  Mark read
                </Button>
              )}
            </div>
            <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>

      {answered.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-neutral-600 dark:text-neutral-400">
            {answered.length} answered or closed
          </summary>
          <ol className="mt-2 space-y-2">
            {answered.map((r) => (
              <li
                key={r.id}
                className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
              >
                <Badge tone={statusTone(r.status)}>{r.status}</Badge> {r.why}
                {r.answer !== null ? (
                  <span className="text-neutral-500"> → {JSON.stringify(r.answer)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function RequestCard({
  request,
  onAnswer,
}: {
  request: HumanRequestView;
  onAnswer: (value: unknown) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (value: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(value);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`rounded border p-3 ${
        request.blocking
          ? "border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/20"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
      data-testid="request"
      data-blocking={request.blocking ? "true" : "false"}
      data-request-id={request.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {request.blocking ? <Badge tone="bad">blocking</Badge> : <Badge>not blocking</Badge>}
        <Badge
          tone={request.risk === "high" ? "bad" : request.risk === "medium" ? "warn" : "neutral"}
        >
          {request.risk} risk
        </Badge>
        <Badge>{request.kind}</Badge>
        {request.projectId ? (
          <Link
            to={`/projects/${encodeURIComponent(request.projectId)}`}
            className="text-blue-700 hover:underline dark:text-blue-300"
          >
            {request.projectName ?? request.projectId}
          </Link>
        ) : null}
        <span className="ml-auto text-xs text-neutral-500">{relativeTime(request.createdAt)}</span>
      </div>
      <p className="mt-2 font-medium">{request.why}</p>
      {request.steps.length > 0 ? (
        <ol className="mt-1 list-decimal pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          {request.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      {request.changeCard !== null && request.changeCard !== undefined ? (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-neutral-500">Change card</summary>
          <pre className="overflow-auto rounded bg-neutral-100 p-2 dark:bg-neutral-900">
            {JSON.stringify(request.changeCard, null, 2)}
          </pre>
        </details>
      ) : null}
      {request.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="options">
          {request.options.map((o) => (
            <Button
              key={o}
              variant="primary"
              onClick={() => void send(o)}
              disabled={busy}
              data-testid="option"
            >
              {o}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send(text.trim());
        }}
      >
        <input
          className={INPUT_CLASS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or answer in your own words…"
          aria-label="Free-text answer"
          data-testid="free-text"
        />
        <Button type="submit" disabled={busy || !text.trim()} data-testid="send-free-text">
          Send
        </Button>
      </form>
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} />
        </div>
      ) : null}
    </li>
  );
}
