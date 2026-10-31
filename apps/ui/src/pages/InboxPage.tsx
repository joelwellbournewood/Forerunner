import {
  DEFAULT_TASK_PRIORITY,
  readPriority,
  type TaskPriority,
} from "@forerunner/runtime/priority";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  describeError,
  type HumanRequestView,
  type InboxView,
  type MessageView,
} from "../api/client.ts";
import { UnlockCard, useUnlockWindow } from "../components/UnlockCard.tsx";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  INPUT_CLASS,
  Loading,
  statusTone,
} from "../components/ui.tsx";
import { formatChf, usdMicroToChfMicro } from "../lib/money.ts";
import { inAppText, reviewLevel, withoutUndoWord } from "../lib/plain-words.ts";
import {
  daemonRunnerKeys,
  desktopUnlockWindowStore,
  type PreparedAnswer,
  type RunnerKeyBridge,
  unlockChallengeOf,
} from "../lib/runner-unlock.ts";
import { browserStorage, type KeyValueStore } from "../lib/storage.ts";
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

/** A plan task as the intake card shows it. */
export interface IntakeCardTask {
  key: string | null;
  title: string;
  riskTier: number | null;
  /** Low, medium or high (U-041); a card filed before holds the model's number, read as its level. */
  priority: TaskPriority;
  dependsOn: string[];
  specialist: string | null;
}

/**
 * The intake proposal (spec A.2, ADR 0055) read off a request's change card: the daemon's
 * `change_card.key` is `intake:<project>` and `proposal` carries the plan, the docs and the
 * first-session plan in the shape the runtime validated. Read defensively: a card that does
 * not fit is shown as the raw JSON instead.
 */
export interface IntakeCardView {
  milestones: { name: string; targetDate: string | null; tasks: IntakeCardTask[] }[];
  looseTasks: IntakeCardTask[];
  /** The drafted docs, the first decision (`docs/decisions/0001-…`) first (U-073). */
  docs: { path: string; text: string }[];
  firstSession: {
    summary: string;
    /** `key` is the plan task's key (unique in a proposal the runtime accepted). */
    items: { key: string; title: string; estimateUsdMicro: number }[];
  };
  docsTarget: "repository" | "workspace" | null;
  costUsdMicro: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function taskOf(v: unknown): IntakeCardTask | null {
  if (!isRecord(v)) return null;
  const title = str(v.title);
  if (title === null) return null;
  return {
    key: str(v.key),
    title,
    riskTier: num(v.riskTier),
    priority: readPriority(v.priority) ?? DEFAULT_TASK_PRIORITY,
    dependsOn: strings(v.dependsOn),
    specialist: str(v.specialist),
  };
}

/** A decision doc the intake drafts (`docs/decisions/0001-<slug>.md`). */
const isDecisionDoc = (path: string): boolean => /^docs\/decisions\/\d{4}-.+\.md$/.test(path);

export function intakeCardOf(card: unknown): IntakeCardView | null {
  if (!isRecord(card) || !str(card.key)?.startsWith("intake:")) return null;
  const proposal = card.proposal;
  if (!isRecord(proposal) || !isRecord(proposal.plan) || !isRecord(proposal.firstSession))
    return null;
  const plan = proposal.plan;
  const milestones = (Array.isArray(plan.milestones) ? plan.milestones : [])
    .filter(isRecord)
    .map((m) => ({
      name: str(m.name) ?? "(unnamed)",
      targetDate: str(m.targetDate),
      tasks: (Array.isArray(m.tasks) ? m.tasks : [])
        .map(taskOf)
        .filter((t): t is IntakeCardTask => t !== null),
    }));
  const looseTasks = (Array.isArray(plan.tasks) ? plan.tasks : [])
    .map(taskOf)
    .filter((t): t is IntakeCardTask => t !== null);
  const titles = new Map<string, string>();
  for (const t of [...milestones.flatMap((m) => m.tasks), ...looseTasks])
    if (t.key !== null) titles.set(t.key, t.title);
  const first = proposal.firstSession;
  const items = (Array.isArray(first.items) ? first.items : []).filter(isRecord).map((i) => {
    const key = str(i.key) ?? "";
    return { key, title: titles.get(key) ?? key, estimateUsdMicro: num(i.estimateUsdMicro) ?? 0 };
  });
  const target = str(card.docs_target);
  return {
    milestones,
    looseTasks,
    docs: isRecord(proposal.docs)
      ? Object.entries(proposal.docs)
          .map(([path, text]) => ({ path, text: str(text) ?? "" }))
          .sort((a, b) => Number(isDecisionDoc(b.path)) - Number(isDecisionDoc(a.path)))
      : [],
    firstSession: { summary: str(first.summary) ?? "", items },
    docsTarget: target === "repository" || target === "workspace" ? target : null,
    costUsdMicro: num(card.cost_usd_micro),
  };
}

/**
 * The card key of questions only the person can answer (U-022): the runtime's
 * `PERSON_QUESTIONS_KEY_PREFIX` (`session/person-questions.ts`), which `test/inbox.test.tsx`
 * checks this equals; the runtime module itself needs Node and is not imported here.
 */
export const PERSON_QUESTIONS_KEY_PREFIX = "person_questions:";

/** A person's questions card as the Inbox shows it: one answer field per question. */
export interface PersonQuestionsView {
  taskTitle: string;
  questions: string[];
  /** Where the questions came from: the plan, the specialist, or the critic's stop. */
  source: "planned" | "specialist" | "critic";
  /** The specialist's or the critic's own words about why it asks. */
  context: string | null;
}

export function personQuestionsOf(card: unknown): PersonQuestionsView | null {
  if (!isRecord(card) || !str(card.key)?.startsWith(PERSON_QUESTIONS_KEY_PREFIX)) return null;
  const questions = strings(card.questions);
  if (questions.length === 0) return null;
  const source = str(card.source);
  return {
    taskTitle: str(card.task_title) ?? "",
    questions,
    source: source === "specialist" || source === "critic" ? source : "planned",
    context: str(card.context),
  };
}

/**
 * The questions with one answer field each (U-022). The answer is sent as
 * `{ answers: [{ question, answer }] }`, the blank ones left out; at least one must be given.
 */
function PersonQuestionsForm({
  card,
  busy,
  onSend,
}: {
  card: PersonQuestionsView;
  busy: boolean;
  onSend: (value: unknown) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => card.questions.map(() => ""));
  const given = card.questions
    .map((question, i) => ({ question, answer: (answers[i] ?? "").trim() }))
    .filter((a) => a.answer.length > 0);
  return (
    <form
      className="mt-2 space-y-2"
      data-testid="person-questions"
      aria-label="Your answers"
      onSubmit={(e) => {
        e.preventDefault();
        if (given.length) onSend({ answers: given });
      }}
    >
      {card.context ? (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">{card.context}</p>
      ) : null}
      {card.questions.map((q, i) => (
        <label key={q} className="block text-sm">
          <span className="font-medium">{q}</span>
          <textarea
            className={`${INPUT_CLASS} mt-1 min-h-12`}
            value={answers[i] ?? ""}
            onChange={(e) =>
              setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))
            }
            data-testid="person-answer"
          />
        </label>
      ))}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || given.length === 0}
        data-testid="send-answers"
      >
        Send answers
      </Button>
    </form>
  );
}

/** The intake card's estimates in CHF (U-074), at the default rate the card has no other for. */
const usd = (micro: number): string => formatChf(usdMicroToChfMicro(micro));

function IntakeTaskList({ tasks }: { tasks: IntakeCardTask[] }) {
  return (
    <ol className="list-decimal pl-5">
      {tasks.map((t) => (
        <li key={t.key ?? t.title}>
          {t.title}
          <span className="text-neutral-500">
            {" "}
            · {reviewLevel(t.riskTier)}, priority {t.priority}
            {t.specialist === "person"
              ? ", asks you in the Inbox"
              : t.specialist
                ? `, ${t.specialist}`
                : ""}
            {t.dependsOn.length
              ? `, after ${t.dependsOn
                  // The plan's keys name its own tasks: shown by title (U-040).
                  .map((k) => {
                    const dep = tasks.find((x) => x.key === k);
                    return dep ? `"${dep.title}"` : k;
                  })
                  .join(", ")}`
              : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The intake proposal, readable: phases and tasks, the docs, the first session, the cost. */
function IntakeCard({ card }: { card: IntakeCardView }) {
  const total = card.firstSession.items.reduce((s, i) => s + i.estimateUsdMicro, 0);
  return (
    <section
      className="mt-2 space-y-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
      data-testid="intake-card"
      aria-label="Intake proposal"
    >
      <h3 className="font-medium">Proposed plan</h3>
      <ul className="space-y-1" data-testid="intake-milestones">
        {card.milestones.map((m) => (
          <li key={m.name}>
            <span className="font-medium">{m.name}</span>
            {m.targetDate ? <span className="text-neutral-500"> · by {m.targetDate}</span> : null}
            <IntakeTaskList tasks={m.tasks} />
          </li>
        ))}
        {card.looseTasks.length > 0 ? (
          <li>
            <span className="font-medium">Under no milestone</span>
            <IntakeTaskList tasks={card.looseTasks} />
          </li>
        ) : null}
      </ul>
      <p data-testid="intake-docs">
        <span className="font-medium">Docs ({card.docs.length}):</span>{" "}
        {card.docs.map((d) => d.path).join(", ")}
        {card.docsTarget === "repository"
          ? " — as a pull request on the project's repository"
          : card.docsTarget === "workspace"
            ? " — into the project's workspace"
            : ""}
      </p>
      {/* U-073: what you approve, readable before you approve it; the decision doc open. */}
      <div className="space-y-1" data-testid="intake-doc-texts">
        {card.docs.map((d) => (
          <details
            key={d.path}
            open={isDecisionDoc(d.path)}
            className="rounded border border-neutral-200 p-1 dark:border-neutral-800"
            data-testid="intake-doc"
          >
            <summary className="cursor-pointer font-medium">
              {isDecisionDoc(d.path) ? `Decision: ${d.path}` : d.path}
            </summary>
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{d.text}</pre>
          </details>
        ))}
      </div>
      <div data-testid="intake-first-session">
        <span className="font-medium">First session ({usd(total)}):</span>{" "}
        {card.firstSession.summary}
        <ol className="list-decimal pl-5">
          {card.firstSession.items.map((i) => (
            <li key={i.key || i.title}>
              {i.title} <span className="text-neutral-500">(~{usd(i.estimateUsdMicro)})</span>
            </li>
          ))}
        </ol>
      </div>
      {card.costUsdMicro !== null ? (
        <p className="text-xs text-neutral-500">
          Planning call: {usd(card.costUsdMicro)}. Nothing is written until you approve.
        </p>
      ) : null}
    </section>
  );
}

export interface InboxPageProps {
  /** Where the runner's vault key is (ADR 0068); the daemon, which holds the OS keyring, by default. */
  runnerKeys?: RunnerKeyBridge;
  /** Where this device keeps the auto-unlock window it set; browser storage by default. */
  unlockWindows?: KeyValueStore;
  now?: () => number;
}

/** Inbox (spec K.4, J.3): human requests and agent messages, blocking first. */
export function InboxPage({ runnerKeys, unlockWindows, now = Date.now }: InboxPageProps = {}) {
  const client = useClient();
  const store = useUiStore();
  const me = useUiState((s) => s.me);
  const humanId = me?.id ?? null;
  const inbox = useAsync<InboxView | null>(
    (signal) => (humanId ? client.inbox(humanId, signal) : Promise.resolve(null)),
    [client, humanId],
  );

  // Cloud runner unlock (spec S.12, ADR 0068): the key bridge and this device's window record.
  // The auto-answer inside that window runs app-wide (`RunnerAutoUnlock` in the Shell), which
  // reads the same record, so a window set here takes effect on every page at once.
  const bridge = useMemo(() => runnerKeys ?? daemonRunnerKeys(client), [runnerKeys, client]);
  const windows = useMemo(
    () => (humanId ? desktopUnlockWindowStore(unlockWindows ?? browserStorage(), humanId) : null),
    [unlockWindows, humanId],
  );
  const windowUntil = useUnlockWindow(windows);

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

  const sendUnlock = useCallback(
    async (request: HumanRequestView, prepared: PreparedAnswer) => {
      await client.answerRequest(request.id, { version: request.version, answer: prepared.value });
      // The window is recorded only once the answer that carries it was accepted.
      if (prepared.window !== undefined) windows?.set(prepared.window);
      reload();
    },
    [client, windows, reload],
  );

  const markRead = async (message: MessageView) => {
    const updated = await client.markRead(message.id);
    inbox.setData((prev) =>
      prev
        ? { ...prev, messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)) }
        : prev,
    );
  };

  // U-020: one click marks every unread message read. The messages are marked one by one
  // through the same route as "Mark read" (the service checks each is addressed to you), and
  // the list updates as each answer arrives; a failure stops there and shows the error.
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const markAllRead = async (unread: MessageView[]) => {
    if (markingAll) return;
    setMarkingAll(true);
    setMarkAllError(null);
    try {
      for (const m of unread) await markRead(m);
    } catch (error) {
      setMarkAllError(describeError(error));
    } finally {
      setMarkingAll(false);
    }
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
  const unreadMessages = messages.filter((m) => m.readAt === null);

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
          <RequestCard
            key={r.id}
            request={r}
            onAnswer={(value) => answer(r, value)}
            unlock={{
              bridge,
              windowUntil,
              now,
              send: (prepared) => sendUnlock(r, prepared),
            }}
          />
        ))}
      </ol>

      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Messages</h2>
        {unreadMessages.length > 0 ? (
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => void markAllRead(unreadMessages)}
            disabled={markingAll}
            data-testid="mark-all-read"
          >
            {markingAll ? "Marking read…" : `Mark all read (${unreadMessages.length})`}
          </Button>
        ) : null}
      </div>
      {markAllError ? <ErrorBanner message={markAllError} /> : null}
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
            <MessageBody body={m.body} />
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
                  <span className="text-neutral-500"> → {answerText(r.answer)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

/**
 * A message as the person reads it (U-074): a change sentence's spoken "Undo." becomes a link to
 * Changes, where the change can be undone.
 */
function MessageBody({ body }: { body: string }) {
  const { text, undo } = withoutUndoWord(body);
  return (
    <p className="mt-1 whitespace-pre-wrap">
      {text}
      {undo ? (
        <>
          {" "}
          <Link
            to="/changes"
            className="text-blue-700 hover:underline dark:text-blue-300"
            data-testid="message-undo"
          >
            Undo in Changes
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** An answer as it was given: the option's words, never JSON (U-074). */
function answerText(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (answer && typeof answer === "object") {
    const o = answer as Record<string, unknown>;
    for (const k of ["choice", "answer", "decision", "text"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
  }
  return "answered";
}

function RequestCard({
  request,
  onAnswer,
  unlock,
}: {
  request: HumanRequestView;
  onAnswer: (value: unknown) => Promise<void>;
  unlock: {
    bridge: RunnerKeyBridge;
    windowUntil: string | null;
    now: () => number;
    send: (prepared: PreparedAnswer) => Promise<void>;
  };
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intake = intakeCardOf(request.changeCard);
  const challenge = unlockChallengeOf(request);
  const questions = challenge ? null : personQuestionsOf(request.changeCard);

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
        {/* U-073: every card names its task beside its project. */}
        {request.taskTitle ? (
          <span data-testid="request-task" className="text-neutral-700 dark:text-neutral-300">
            Task:{" "}
            {request.projectId ? (
              <Link
                to={`/projects/${encodeURIComponent(request.projectId)}/tasks`}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                {request.taskTitle}
              </Link>
            ) : (
              request.taskTitle
            )}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-neutral-500">{relativeTime(request.createdAt)}</span>
      </div>
      <p className="mt-2 font-medium">{request.why}</p>
      {request.steps.length > 0 && !questions ? (
        <ol className="mt-1 list-decimal pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          {request.steps.map((s) => (
            <li key={s}>{inAppText(s)}</li>
          ))}
        </ol>
      ) : null}
      {questions ? <PersonQuestionsForm card={questions} busy={busy} onSend={send} /> : null}
      {intake ? <IntakeCard card={intake} /> : null}
      {challenge ? (
        <UnlockCard
          request={request}
          card={challenge}
          bridge={unlock.bridge}
          windowUntil={unlock.windowUntil}
          now={unlock.now}
          onSend={unlock.send}
        />
      ) : null}
      {challenge || questions ? null : request.changeCard !== null &&
        request.changeCard !== undefined ? (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-neutral-500">Change card</summary>
          <pre className="overflow-auto rounded bg-neutral-100 p-2 dark:bg-neutral-900">
            {JSON.stringify(request.changeCard, null, 2)}
          </pre>
        </details>
      ) : null}
      {!challenge && request.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="options">
          {request.options.map((o) => (
            <Button
              key={o}
              // The questions card's one option ("Cancel the task") is not its main answer.
              variant={questions ? "secondary" : "primary"}
              onClick={() => void send(o)}
              disabled={busy}
              data-testid="option"
            >
              {o}
            </Button>
          ))}
        </div>
      ) : null}
      {challenge || questions ? null : (
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
      )}
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} />
        </div>
      ) : null}
    </li>
  );
}
