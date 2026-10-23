import { useCallback, useMemo, useState } from "react";
import {
  describeStateError,
  type HumanRequestView,
  type MessageView,
} from "../../api/state-client.ts";
import { UnlockCard, useAutoUnlock } from "../../components/UnlockCard.tsx";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  INPUT_CLASS,
  Loading,
} from "../../components/ui.tsx";
import { type PreparedAnswer, unlockChallengeOf } from "../../lib/runner-unlock.ts";
import { relativeTime } from "../../lib/time.ts";
import { renderCard } from "../change-card.ts";
import { sortMessages, sortRequests } from "../inbox-sort.ts";
import { MobileController, useMobileController, useMobileState } from "../store.tsx";

/**
 * Inbox on the phone (spec K.4, J.3, R.5): approvals first (blocking, then newest), multiple
 * choice answers, free text; a high-risk request shows that it needs biometrics and the
 * answer is sent only after the prompt succeeded (the flag travels inside the signature).
 * A cloud runner unlock (spec S.12, ADR 0068) renders as the unlock card; inside the window
 * this phone set, the next challenge is answered without a choice (the fingerprint still).
 */
export function InboxScreen() {
  const controller = useMobileController();
  const inbox = useMobileState((s) => s.inbox);
  const stage = useMobileState((s) => s.stage);
  const windowUntil = useMobileState((s) => s.unlockWindowUntil);
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null);
  const open = useMemo(() => (inbox?.requests ?? []).filter((r) => r.status === "open"), [inbox]);
  const sendUnlock = useCallback(
    (request: HumanRequestView, prepared: PreparedAnswer) =>
      controller.answerUnlock(request, prepared),
    [controller],
  );
  useAutoUnlock({
    requests: stage === "paired" ? open : [],
    bridge: controller.runnerKeys,
    windowUntil,
    now: controller.env.now,
    send: sendUnlock,
    notify: setUnlockNotice,
  });

  if (stage !== "paired") return null;
  if (!inbox) return <Loading what="inbox" />;
  const requests = sortRequests(open);
  const messages = sortMessages(inbox.messages);

  return (
    <section aria-labelledby="m-inbox-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 id="m-inbox-title" className="text-xl font-semibold">
          Inbox
        </h1>
        <Badge tone={inbox.blockingCount > 0 ? "bad" : "neutral"} testId="m-blocking-count">
          {inbox.blockingCount} blocking
        </Badge>
        <Button variant="ghost" className="ml-auto" onClick={() => void controller.loadInbox()}>
          Refresh
        </Button>
      </div>
      {unlockNotice ? (
        <p
          className="rounded border border-blue-300 p-2 text-sm dark:border-blue-800"
          role="status"
          data-testid="m-unlock-notice"
        >
          {unlockNotice}
        </p>
      ) : null}
      <h2 className="font-semibold">Approvals and requests</h2>
      {requests.length === 0 ? (
        <EmptyState testId="m-no-requests">Nothing waits on you.</EmptyState>
      ) : null}
      <ol className="space-y-3" data-testid="m-request-list">
        {requests.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
      </ol>
      <h2 className="font-semibold">Messages</h2>
      {messages.length === 0 ? <EmptyState>No messages.</EmptyState> : null}
      <ol className="space-y-2">
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </ol>
    </section>
  );
}

function RequestCard({ request }: { request: HumanRequestView }) {
  const controller = useMobileController();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const high = MobileController.isHighRisk(request);
  const card = request.changeCard;
  const challenge = unlockChallengeOf(request);
  const windowUntil = useMobileState((s) => s.unlockWindowUntil);

  const send = async (value: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await controller.answerRequest(request, value);
      setQueued(r.queued);
    } catch (e) {
      setError(describeStateError(e));
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
      data-testid="m-request"
      data-blocking={request.blocking ? "true" : "false"}
      data-request-id={request.id}
      data-risk={request.risk}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {request.blocking ? <Badge tone="bad">blocking</Badge> : <Badge>not blocking</Badge>}
        <Badge
          tone={request.risk === "high" ? "bad" : request.risk === "medium" ? "warn" : "neutral"}
        >
          {request.risk} risk
        </Badge>
        <Badge>{request.kind}</Badge>
        {request.projectName ? <Badge tone="info">{request.projectName}</Badge> : null}
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
      {challenge ? (
        <UnlockCard
          request={request}
          card={challenge}
          bridge={controller.runnerKeys}
          windowUntil={windowUntil}
          now={controller.env.now}
          onSend={(prepared) => controller.answerUnlock(request, prepared)}
          testIdPrefix="m-"
        />
      ) : null}
      {!challenge && card && typeof card === "object" && !Array.isArray(card) ? (
        <pre
          className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900"
          data-testid="m-request-card"
        >
          {isCardLike(card) ? renderCard(card) : JSON.stringify(card, null, 2)}
        </pre>
      ) : null}
      {high ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" data-testid="m-request-high">
          High risk: answering asks for your fingerprint or face first.
        </p>
      ) : null}
      {!challenge && request.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="m-options">
          {request.options.map((o) => (
            <Button
              key={o}
              variant="primary"
              onClick={() => void send(o)}
              disabled={busy}
              data-testid="m-option"
            >
              {o}
            </Button>
          ))}
        </div>
      ) : null}
      {challenge ? null : (
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
            data-testid="m-free-text"
          />
          <Button type="submit" disabled={busy || !text.trim()} data-testid="m-send-free-text">
            Send
          </Button>
        </form>
      )}
      {queued ? (
        <p className="mt-2 text-xs text-neutral-500" data-testid="m-answer-queued">
          Queued; sent when the phone reconnects.
        </p>
      ) : null}
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} testId="m-request-error" />
        </div>
      ) : null}
    </li>
  );
}

function isCardLike(value: object): value is Parameters<typeof renderCard>[0] {
  const c = value as Record<string, unknown>;
  return (
    typeof c.what === "string" &&
    typeof c.oldValue === "string" &&
    typeof c.newValue === "string" &&
    typeof c.scopeLabel === "string" &&
    typeof c.duration === "string" &&
    !!c.impact &&
    typeof c.undoHint === "string"
  );
}

function MessageRow({ message }: { message: MessageView }) {
  const controller = useMobileController();
  const [error, setError] = useState<string | null>(null);
  return (
    <li
      className={`rounded border p-3 text-sm ${
        message.readAt
          ? "border-neutral-200 text-neutral-600 dark:border-neutral-800 dark:text-neutral-400"
          : "border-blue-300 dark:border-blue-800"
      }`}
      data-testid="m-message"
      data-read={message.readAt ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{message.fromAgentName}</span>
        <Badge>{message.type}</Badge>
        {message.requiresAck ? <Badge tone="warn">needs acknowledgement</Badge> : null}
        <span className="text-xs text-neutral-500">{relativeTime(message.createdAt)}</span>
        {message.readAt ? null : (
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() =>
              void controller.markRead(message).catch((e) => setError(describeStateError(e)))
            }
            data-testid="m-mark-read"
          >
            Mark read
          </Button>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
      {error ? <ErrorBanner message={error} /> : null}
    </li>
  );
}
