import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, describeError } from "../api/client.ts";
import {
  type HumanRequestView,
  type InboxView,
  isHighRisk,
  type MessageView,
} from "../api/types.ts";
import { Badge, Banner, Button, Loading } from "../components/ui.tsx";
import { useApp } from "../store/AppContext.tsx";
import { ConfirmCodeDialog, type ConfirmState } from "./ConfirmCodeDialog.tsx";

/**
 * The inbox (spec J.3, K.4): human requests blocking first, each with its context (steps),
 * why it matters, its options and whether it blocks; then agent messages. An answer posts
 * with the request's version; a 409 shows "changed, reload". An answered request leaves the
 * list and is never shown again (the service only lists open ones; the runtime records the
 * decision, spec J.4).
 */
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: InboxView }
  | { kind: "error"; message: string };

export function sortRequests(requests: readonly HumanRequestView[]): HumanRequestView[] {
  return [...requests].sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function Inbox() {
  const { client, onChange, onPoll, reportBlockingCount } = useApp();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async () => {
    try {
      const data = await client.inbox();
      setState({ kind: "ready", data });
      reportBlockingCount(data.blockingCount);
    } catch (err) {
      setState({ kind: "error", message: describeError(err) });
    }
  }, [client, reportBlockingCount]);

  useEffect(() => {
    void load();
    const offChange = onChange((e) => {
      if (e.type === "human_request.changed" || e.type === "message.changed") void load();
    });
    const offPoll = onPoll(() => void load());
    return () => {
      offChange();
      offPoll();
    };
  }, [onChange, onPoll, load]);

  const removeRequest = (id: string) => {
    const s = stateRef.current;
    if (s.kind !== "ready") return;
    const requests = s.data.requests.filter((r) => r.id !== id);
    const blockingCount = requests.filter((r) => r.blocking).length;
    setState({ kind: "ready", data: { ...s.data, requests, blockingCount } });
    reportBlockingCount(blockingCount);
  };

  const replaceMessage = (m: MessageView) =>
    setState((s) =>
      s.kind === "ready"
        ? {
            kind: "ready",
            data: { ...s.data, messages: s.data.messages.map((x) => (x.id === m.id ? m : x)) },
          }
        : s,
    );

  if (state.kind === "loading") return <Loading what="your inbox" />;
  if (state.kind === "error") {
    return (
      <div className="space-y-3">
        <Banner tone="error" testId="inbox-error">
          {state.message}
        </Banner>
        <Button onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  const requests = sortRequests(state.data.requests);
  return (
    <div className="space-y-6" data-testid="inbox">
      <section>
        <h2 className="mb-2 text-lg font-semibold">
          Requests{" "}
          <span className="text-sm font-normal text-neutral-500">
            ({requests.length}, {state.data.blockingCount} blocking)
          </span>
        </h2>
        {requests.length === 0 && (
          <p className="text-sm text-neutral-500" data-testid="no-requests">
            Nothing waits on you.
          </p>
        )}
        <ul className="space-y-3">
          {requests.map((r) => (
            // Keyed by version too: a reload after a 409 remounts the card with a clean state.
            <li key={`${r.id}:${r.version}`}>
              <RequestCard request={r} onAnswered={removeRequest} onReload={() => void load()} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Messages</h2>
        {state.data.messages.length === 0 && (
          <p className="text-sm text-neutral-500">No messages.</p>
        )}
        <ul className="space-y-2">
          {state.data.messages.map((m) => (
            <li key={m.id}>
              <MessageCard message={m} onChanged={replaceMessage} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

type AnswerState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

const KIND_LABEL: Record<string, string> = {
  decision: "Decision",
  credential: "Credential",
  approval: "Approval",
  info: "Information",
};

/** The runner id of a cloud runner unlock challenge card (`runner_vault_unlock`), else null. */
export function runnerUnlockOf(card: unknown): string | null {
  if (typeof card !== "object" || card === null || Array.isArray(card)) return null;
  const c = card as { kind?: unknown; runnerId?: unknown };
  return c.kind === "runner_vault_unlock" && typeof c.runnerId === "string" ? c.runnerId : null;
}

export function RequestCard({
  request,
  onAnswered,
  onReload,
}: {
  request: HumanRequestView;
  onAnswered: (id: string) => void;
  onReload: () => void;
}) {
  const app = useApp();
  const [answer, setAnswer] = useState<AnswerState>({ kind: "idle" });
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState<{ answer: unknown; state: ConfirmState } | null>(null);
  const canAnswer = app.client.hasScope("write:approvals");
  const highRisk = isHighRisk(request);
  const credential = request.kind === "credential";
  // A cloud runner's vault unlock (spec S.12, ADR 0068): read-only here, without a keyring.
  const unlockRunner = credential ? runnerUnlockOf(request.changeCard) : null;

  async function post(value: unknown, confirmation?: { challengeId: string; code: string }) {
    setAnswer({ kind: "sending" });
    try {
      await app.client.answerRequest(request.id, {
        version: request.version,
        answer: value,
        ...(confirmation ? { confirmation } : {}),
      });
      setConfirm(null);
      onAnswered(request.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict") {
        setConfirm(null);
        setAnswer({ kind: "conflict" });
        return;
      }
      if (confirmation && err instanceof ApiError && err.code === "confirmation_invalid") {
        setAnswer({ kind: "idle" });
        setConfirm((c) =>
          c && (c.state.kind === "sending" || c.state.kind === "enter")
            ? {
                answer: c.answer,
                state: { kind: "enter", challenge: c.state.challenge, error: describeError(err) },
              }
            : c,
        );
        return;
      }
      setConfirm(null);
      setAnswer({ kind: "error", message: describeError(err) });
    }
  }

  async function requestCode(value: unknown) {
    setConfirm({ answer: value, state: { kind: "requesting" } });
    try {
      const challenge = await app.client.confirmChallenge(request.id);
      setConfirm({ answer: value, state: { kind: "enter", challenge, error: null } });
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === "not_found"
          ? "This state service cannot send confirmation codes yet. Confirm this request from your phone or the desktop app."
          : describeError(err);
      setConfirm({ answer: value, state: { kind: "unavailable", message } });
    }
  }

  function choose(value: unknown) {
    if (highRisk) void requestCode(value);
    else void post(value);
  }

  function submitCode(code: string) {
    if (confirm?.state.kind !== "enter") return;
    const { challenge } = confirm.state;
    setConfirm({ answer: confirm.answer, state: { kind: "sending", challenge } });
    void post(confirm.answer, { challengeId: challenge.challengeId, code });
  }

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (value) choose(value);
  };

  const busy = answer.kind === "sending" || confirm !== null;
  return (
    <article
      data-testid="request"
      data-request-id={request.id}
      data-blocking={request.blocking ? "1" : "0"}
      className={`rounded border p-3 ${
        request.blocking
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950"
          : "border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium">{KIND_LABEL[request.kind] ?? request.kind}</span>
        {request.projectName && <Badge tone="info">{request.projectName}</Badge>}
        {/* U-073: every card names its task beside its project. */}
        {request.taskTitle && (
          <span className="text-sm" data-testid="request-task">
            Task: {request.taskTitle}
          </span>
        )}
        {request.blocking ? (
          <Badge tone="error" testId="blocking">
            Blocks work
          </Badge>
        ) : (
          <Badge testId="non-blocking">Does not block</Badge>
        )}
        {highRisk && (
          <Badge tone="warn" testId="high-risk">
            High risk: needs a fresh code
          </Badge>
        )}
      </div>
      <p className="text-sm">
        <span className="text-neutral-500">Why it matters: </span>
        {request.why}
      </p>
      {request.steps.length > 0 && (
        <div className="mt-2 text-sm">
          <span className="text-neutral-500">Context</span>
          <ol className="list-decimal pl-5" data-testid="steps">
            {request.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      {answer.kind === "conflict" && (
        <div className="mt-2 flex items-center gap-2">
          <Banner tone="warn" testId="conflict">
            This request changed on another device. Reload to see the latest.
          </Banner>
          <Button data-testid="reload" onClick={onReload}>
            Reload
          </Button>
        </div>
      )}
      {answer.kind === "error" && (
        <div className="mt-2">
          <Banner tone="error" testId="answer-error">
            {answer.message}
          </Banner>
        </div>
      )}
      {!canAnswer && (
        <p className="mt-2 text-sm text-neutral-500" data-testid="no-approvals-scope">
          This link was issued without approvals, so it can only show requests.
        </p>
      )}
      {canAnswer && credential && unlockRunner === null && (
        <p className="mt-2 text-sm text-neutral-500" data-testid="credential-notice">
          Credentials go into the vault from the desktop app, never through this page.
        </p>
      )}
      {credential && unlockRunner !== null && (
        <p className="mt-2 text-sm text-neutral-500" data-testid="unlock-readonly">
          Cloud runner "{unlockRunner}" asks for its vault key. This page has no OS keyring to hold
          the key, so it can only show the request: unlock from the desktop app or the Android app.
        </p>
      )}
      {canAnswer && !credential && answer.kind !== "conflict" && (
        <div className="mt-2">
          {request.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {request.options.map((o) => (
                <Button
                  key={o}
                  variant="primary"
                  data-testid="option"
                  disabled={busy}
                  onClick={() => choose(o)}
                >
                  {o}
                </Button>
              ))}
            </div>
          ) : (
            <form onSubmit={submitText} className="flex gap-2" data-testid="free-text">
              <input
                aria-label="Your answer"
                className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
              <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
                Answer
              </Button>
            </form>
          )}
        </div>
      )}
      {confirm && (
        <ConfirmCodeDialog
          open
          state={confirm.state}
          onSubmit={submitCode}
          onNewCode={() => void requestCode(confirm.answer)}
          onClose={() => {
            setConfirm(null);
            setAnswer({ kind: "idle" });
          }}
        />
      )}
    </article>
  );
}

export function MessageCard({
  message,
  onChanged,
}: {
  message: MessageView;
  onChanged: (m: MessageView) => void;
}) {
  const app = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canReceipt = app.client.hasScope("write:inbox");
  async function markRead() {
    setBusy(true);
    try {
      onChanged(await app.client.markRead(message.id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      data-testid="message"
      className="rounded border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone={message.type === "warning" ? "warn" : "neutral"}>{message.type}</Badge>
        <span className="text-neutral-500">from {message.fromAgentName}</span>
        {message.requiresAck && <Badge tone="info">needs acknowledgement</Badge>}
        {message.readAt ? (
          <Badge tone="good" testId="read">
            read
          </Badge>
        ) : (
          canReceipt && (
            <Button data-testid="mark-read" disabled={busy} onClick={() => void markRead()}>
              Mark read
            </Button>
          )
        )}
      </div>
      <p className="whitespace-pre-wrap">{message.body}</p>
      {error && (
        <div className="mt-2">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
    </article>
  );
}
