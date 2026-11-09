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
  buttonClassName,
  EmptyState,
  ErrorBanner,
  INPUT_CLASS,
  Loading,
} from "../components/ui.tsx";
import { aboutChf, chfWords, usdMicroToChfMicro } from "../lib/money.ts";
import { inAppText, withoutMarks, withoutUndoWord } from "../lib/plain-words.ts";
import { decisionLine, planTotalWords } from "../lib/plan-card.ts";
import {
  daemonRunnerKeys,
  desktopUnlockWindowStore,
  type PreparedAnswer,
  type RunnerKeyBridge,
  unlockChallengeOf,
} from "../lib/runner-unlock.ts";
import { browserStorage, type KeyValueStore } from "../lib/storage.ts";
import { specialistName } from "../lib/task-actions.ts";
import { relativeTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useScrollToHash } from "../lib/use-hash-scroll.ts";
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
 * Each question and the context read without the specialist's markdown (`withoutMarks`,
 * W15B-17); the answer sent keeps the question as it was asked.
 */
function PersonQuestionsForm({
  card,
  busy,
  onSend,
  showContext = true,
}: {
  card: PersonQuestionsView;
  busy: boolean;
  onSend: (value: unknown) => void;
  /** The card body says the specialist's words already (design §3.8): not twice. */
  showContext?: boolean;
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
      {showContext && card.context ? (
        <p
          className="text-xs text-neutral-600 dark:text-neutral-400"
          data-testid="person-questions-context"
        >
          {withoutMarks(card.context)}
        </p>
      ) : null}
      {card.questions.map((q, i) => (
        <label key={q} className="block text-sm">
          <span className="font-medium">{withoutMarks(q)}</span>
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

/**
 * The intake card's estimates in CHF (U-074), at the default rate the card has no other for;
 * under a centime "less than CHF 0.01", never "CHF 0.00" (W15-74).
 */
const aboutUsd = (micro: number): string => aboutChf(usdMicroToChfMicro(micro));

/**
 * A drafted decision doc as text (design §3.3: "rendered as text, never raw markdown"): the
 * heading marks, bullets and emphasis become plain lines.
 */
export function markdownAsText(md: string): string[] {
  return md
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((line) =>
          line
            .replace(/^#+\s*/, "")
            .replace(/^\s*[-*]\s+/, "• ")
            .replace(/\*\*|__|`/g, "")
            // Single emphasis ("_pending_", "*draft*") as plain words.
            .replace(/(^|[\s(])[_*]([^_*\n]+)[_*](?=[\s).,;:!?]|$)/g, "$1$2")
            .trim(),
        )
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);
}

/**
 * What this install cannot do for a plan task, in a few words, or null (phase C, ADR 0107): the
 * daemon's limitation of its specialist ("Cannot read the web on this computer"), read from the
 * specialists list (`GET /settings/models`), so the words are the daemon's and true now. The
 * plan names specialists as the registry does ("data analyst" reads as `data-analyst`); a name
 * the list does not have says nothing here: the daemon's `planTasks` (`GET /inbox`, C-68) names
 * it, and its `runsOn` sentence (U-078) takes this chip's place when there is one.
 */
export function cannotRunHere(
  specialist: string | null,
  specialists: ReadonlyMap<string, string | null> | null,
): string | null {
  if (!specialists || !specialist) return null;
  const name = specialist
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return specialists.get(name) ?? null;
}

/**
 * The plan from the brief, shown once (design §3.3): the tasks in order with who does each and
 * what it costs ("cost not known" where the plan has no estimate), "Needs Docker" beside a
 * full-review task while Docker is not ready, beside a task this install cannot run what is
 * missing (`cannotRunHere`), beside a task whose specialist this install does not have that it
 * will wait for the person (C-68), under a task where it runs and why when the credential
 * chooser has something to say (U-078: "Runs on your API key: only it can read web pages
 * here.", the daemon's `planTasks`), the total and what it covers, and the decision in
 * one or two sentences with the full record, as text, one click away. The other docs are
 * scaffolded without being listed. Live (2026-11-01) the card ran a title into "Needs Docker",
 * left a task without an estimate out of the total without saying so, and pasted the whole
 * decision record, status line and answer placeholder included.
 */
function IntakeCard({
  card,
  dockerReady,
  specialists,
  planTasks,
}: {
  card: IntakeCardView;
  dockerReady: boolean | null;
  specialists: ReadonlyMap<string, string | null> | null;
  /** The daemon's view of each plan task here (U-078, C-68): who, where it runs and why. */
  planTasks: HumanRequestView["planTasks"];
}) {
  const hereOf = (t: IntakeCardTask) =>
    planTasks?.find((p) => (t.key !== null ? p.key === t.key : p.title === t.title)) ?? null;
  const tasks = [...card.milestones.flatMap((m) => m.tasks), ...card.looseTasks];
  const isPerson = (t: IntakeCardTask) => t.specialist === "person";
  const estimate = new Map(card.firstSession.items.map((i) => [i.key, i.estimateUsdMicro]));
  // The daemon's figure, as the Start dialog will price the task (the learned estimate; the
  // leftovers of wave 7), else the plan's own.
  const costOf = (t: IntakeCardTask) => {
    const now = hereOf(t)?.estimateUsdMicro;
    if (typeof now === "number") return now;
    return t.key !== null ? estimate.get(t.key) : undefined;
  };
  const agentTasks = tasks.filter((t) => !isPerson(t));
  const estimated = agentTasks.filter((t) => costOf(t) !== undefined);
  // W15-72: the total is the sum of the figures the rows show (each rounded to the centime),
  // so they add up as read; under a centime in all it reads "less than CHF 0.01".
  const shownChf = (usd: number) => Math.round(usdMicroToChfMicro(usd) / 10_000) * 10_000;
  const exactChf = estimated.reduce((s, t) => s + usdMicroToChfMicro(costOf(t) ?? 0), 0);
  const shownTotal = estimated.reduce((s, t) => s + shownChf(costOf(t) ?? 0), 0);
  const totalWords = planTotalWords({
    agentTasks: agentTasks.length,
    estimated: estimated.length,
    total: chfWords(shownTotal > 0 ? shownTotal : exactChf),
    personTasks: agentTasks.length < tasks.length,
  });
  const decision = card.docs.find((d) => isDecisionDoc(d.path));
  const decided = decision ? decisionLine(decision.text) : null;
  const titleOf = (key: string) => tasks.find((t) => t.key === key)?.title ?? null;
  return (
    <section
      className="mt-2 space-y-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
      data-testid="intake-card"
      aria-label="The plan"
    >
      <ol className="list-decimal space-y-0.5 pl-5" data-testid="intake-tasks">
        {tasks.map((t) => {
          const cost = costOf(t);
          const after = t.dependsOn.map(titleOf).filter((x): x is string => x !== null);
          const needsDocker = (t.riskTier ?? 0) >= 2 && dockerReady === false;
          const here = hereOf(t);
          // Where it runs and why (U-078): the daemon's sentence; it says what the limitation
          // would, so the chip is shown only without one (an older daemon, no credential).
          const runsOn = here?.runsOn?.line ?? null;
          const missing = runsOn ? null : cannotRunHere(t.specialist, specialists);
          const unknown = here?.unknown
            ? `No specialist here is named "${here.unknown}": this task will wait for you; change who does it after you approve`
            : null;
          const badges = [
            ...(needsDocker ? ["Needs Docker"] : []),
            ...(unknown ? [unknown] : []),
            ...(missing ? [missing] : []),
          ];
          return (
            <li key={t.key ?? t.title} data-testid="intake-task">
              {t.title}
              <span className="text-neutral-600 dark:text-neutral-400">
                {" "}
                ·{" "}
                {isPerson(t)
                  ? "you: answer its questions"
                  : // W15-43: the specialist in words ("writer"), never the registry's key.
                    (specialistName(t.specialist) ?? "the agent chooses who")}
                {isPerson(t)
                  ? ""
                  : cost !== undefined
                    ? ` · ${aboutUsd(cost)}`
                    : " · cost not known"}
                {after.length ? ` · after ${after.map((a) => `"${a}"`).join(", ")}` : ""}
              </span>
              {badges.map((b) => (
                <span key={b}>
                  <span className="text-neutral-600 dark:text-neutral-400"> · </span>
                  <span
                    className="rounded bg-amber-100 px-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                    data-testid="intake-task-cannot-run"
                  >
                    {b}
                  </span>
                </span>
              ))}
              {runsOn ? (
                <span
                  className="block text-xs text-neutral-600 dark:text-neutral-400"
                  data-testid="intake-task-runs-on"
                >
                  {runsOn}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {totalWords ? (
        <p data-testid="intake-total">
          {card.docsTarget === "repository"
            ? `${totalWords.replace(/\.$/, "")}; the docs go to the project's repository as a pull request.`
            : totalWords}
        </p>
      ) : null}
      {decided ? <p data-testid="intake-decision-line">Decision: {decided}</p> : null}
      {decision ? (
        <details
          className="rounded border border-neutral-200 p-1 dark:border-neutral-800"
          data-testid="intake-decision"
        >
          <summary className="cursor-pointer font-medium">The full decision record</summary>
          <div className="mt-1 max-h-80 space-y-1 overflow-auto text-xs">
            {markdownAsText(decision.text).map((p) => (
              <p key={p} className="whitespace-pre-wrap">
                {p}
              </p>
            ))}
          </div>
        </details>
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

/** The count of cards that need the person (design §3.8); `blockingCount` from an older daemon. */
export function needsYouCountOf(inbox: Pick<InboxView, "needsYouCount" | "blockingCount">): number {
  return inbox.needsYouCount ?? inbox.blockingCount;
}

/**
 * Inbox (design §3.8): everything that waits on the person, and short news. Two lists:
 * **Needs you** (the cards) and **Updates** (one line each); **Answered** (collapsed) says what
 * was answered and what came of it. After an answer the card is replaced by its "Done" line.
 */
export function InboxPage({ runnerKeys, unlockWindows, now = Date.now }: InboxPageProps = {}) {
  const client = useClient();
  const store = useUiStore();
  const me = useUiState((s) => s.me);
  const humanId = me?.id ?? null;
  const inbox = useAsync<InboxView | null>(
    (signal) => (humanId ? client.inbox(humanId, signal) : Promise.resolve(null)),
    [client, humanId],
  );
  // "Needs Docker" beside a full-review task of a plan (design §3.3); unknown until it answers.
  const sandbox = useAsync((signal) => client.sandboxStatus(signal), [client]);
  // Home's and the Overview's "Answer" open `/inbox#card-<id>`: the page goes to that card.
  useScrollToHash(inbox.data !== null && inbox.data !== undefined);
  const dockerReady = sandbox.data ? sandbox.data.state === "ready" : null;
  // What each specialist cannot do on this install (ADR 0107), beside a plan task that needs it.
  const models = useAsync((signal) => client.modelSettings(signal), [client]);
  const specialists = useMemo(
    () =>
      models.data
        ? new Map(models.data.specialists.map((s) => [s.name, s.limitation ?? null] as const))
        : null,
    [models.data],
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
  const count = inbox.data ? needsYouCountOf(inbox.data) : null;
  const loadedCount = useRef<number | null>(null);
  useEffect(() => {
    if (count === null) return;
    loadedCount.current = count;
    store.dispatch({ type: "blockingCount", count });
  }, [count, store]);
  const streamedCount = useUiState((s) => s.blockingCount);
  const reload = inbox.reload;
  useEffect(() => {
    if (loadedCount.current === null || streamedCount === loadedCount.current) return;
    reload();
  }, [streamedCount, reload]);

  // Design §3.8: after an answer the card is replaced by "Done: <what happens next>" for as
  // long as the page is open; the Answered list keeps it after that.
  const [done, setDone] = useState<
    { id: string; line: string; title: string; request: HumanRequestView }[]
  >([]);
  const answer = async (request: HumanRequestView, value: unknown) => {
    const answered = await client.answerRequest(request.id, {
      version: request.version,
      answer: value,
    });
    setDone((prev) => [
      {
        id: request.id,
        title: request.title ?? request.why,
        line: doneLine(answered, value),
        request: answered,
      },
      ...prev.filter((d) => d.id !== request.id),
    ]);
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
  const answered = [...data.requests.filter((r) => r.status !== "open")].sort((a, b) =>
    (b.answeredAt ?? b.createdAt).localeCompare(a.answeredAt ?? a.createdAt),
  );
  const messages = sortMessages(data.messages);
  const unreadMessages = messages.filter((m) => m.readAt === null);
  const needsYou = needsYouCountOf(data);
  const openIds = new Set(requests.map((r) => r.id));
  const doneLines = done.filter((d) => !openIds.has(d.id));

  return (
    <section aria-labelledby="inbox-title" className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 id="inbox-title" className="text-xl font-semibold">
          Inbox
        </h1>
        <Button variant="ghost" onClick={inbox.reload} className="ml-auto">
          Refresh
        </Button>
      </div>
      {inbox.error ? <ErrorBanner message={inbox.error} onRetry={inbox.reload} /> : null}

      <h2 className="font-semibold" data-testid="needs-you-heading">
        Needs you{needsYou > 0 ? ` (${needsYou})` : ""}
      </h2>
      {doneLines.length ? (
        <ul className="space-y-1" data-testid="done-lines">
          {doneLines.map((d) => (
            <li
              key={d.id}
              className="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200"
              data-testid="done-line"
              data-request-id={d.id}
              role="status"
            >
              {d.line}
              <FollowUp request={d.request} onDone={inbox.reload} />
            </li>
          ))}
        </ul>
      ) : null}
      {requests.length === 0 ? (
        <EmptyState testId="no-requests">Nothing needs you.</EmptyState>
      ) : null}
      <ol className="space-y-3" data-testid="request-list">
        {requests.map((r) => (
          <RequestCard
            key={r.id}
            request={r}
            dockerReady={dockerReady}
            specialists={specialists}
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
        <h2 className="font-semibold">Updates</h2>
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
      {messages.length === 0 ? <EmptyState>No updates.</EmptyState> : null}
      <ol className="space-y-1" data-testid="message-list">
        {messages.map((m) => (
          <li
            key={m.id}
            className={`flex flex-wrap items-baseline gap-2 rounded border px-3 py-2 text-sm ${
              m.readAt
                ? "border-neutral-200 text-neutral-600 dark:border-neutral-800 dark:text-neutral-400"
                : "border-blue-300 dark:border-blue-800"
            }`}
            data-testid="message"
            data-read={m.readAt ? "true" : "false"}
          >
            <MessageBody body={m.body} />
            {m.type === "warning" ? <Badge tone="warn">warning</Badge> : null}
            {m.requiresAck ? <Badge tone="warn">needs acknowledgement</Badge> : null}
            <span className="ml-auto text-xs text-neutral-500">
              {m.fromAgentName} · {relativeTime(m.createdAt)}
            </span>
            {m.readAt ? null : (
              <Button variant="ghost" onClick={() => void markRead(m)} data-testid="mark-read">
                Mark read
              </Button>
            )}
          </li>
        ))}
      </ol>

      {answered.length > 0 ? (
        <details data-testid="answered">
          <summary className="cursor-pointer text-sm text-neutral-600 dark:text-neutral-400">
            Answered ({answered.length})
          </summary>
          <ol className="mt-2 space-y-2">
            {answered.map((r) => (
              <li
                key={r.id}
                className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
                data-testid="answered-request"
                data-request-id={r.id}
              >
                <span className="font-medium">{r.title ?? r.why}</span>
                {r.projectName ? (
                  <span className="text-neutral-500"> · {r.projectName}</span>
                ) : null}
                <p className="text-neutral-700 dark:text-neutral-300">
                  {r.outcome ?? (r.answer !== null ? `You answered: ${answerText(r.answer)}.` : "")}
                  <FollowUp request={r} onDone={inbox.reload} />
                </p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

/**
 * What can still be done about an answered card (design §3.8): answers that came after their
 * task had finished offer "Redo with these answers", the task's own Redo (or Reopen, Try
 * again), so its next attempt reads them.
 */
function FollowUp({ request, onDone }: { request: HumanRequestView; onDone: () => void }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const follow = request.followUp;
  // Once done, the line stays (the reloaded card offers nothing more: its task moved again).
  if (said)
    return (
      <span className="ml-2 text-xs" data-testid="follow-up-done">
        {said}
      </span>
    );
  if (!follow || !request.taskId) return null;
  const taskId = request.taskId;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { task } = await client.task(taskId);
      const moved = await client.taskAction(taskId, {
        version: task.version,
        action: follow.action,
        note: "Use the answers the person gave in the Inbox.",
      });
      setSaid(moved.change?.sentence ?? "Done.");
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-2">
      <Button onClick={() => void run()} disabled={busy} data-testid="follow-up">
        {follow.label}
      </Button>
      <span className="text-xs text-neutral-600 dark:text-neutral-400">{follow.explain}</span>
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}

/** The "Done" line that replaces a card after its answer (design §3.8). */
function doneLine(answered: HumanRequestView, value: unknown): string {
  if (answered.outcome) return `Done: ${answered.outcome}`;
  return `Done: you answered "${answerText(value)}".`;
}

/**
 * An update as the person reads it (U-074): a change sentence's spoken "Undo." becomes a link to
 * Changes, where the change can be undone.
 */
function MessageBody({ body }: { body: string }) {
  const { text, undo } = withoutUndoWord(body);
  return (
    <p className="whitespace-pre-wrap">
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
    if (Array.isArray(o.answers)) return "your answers";
  }
  return "answered";
}

type Choice = NonNullable<HumanRequestView["choices"]>[number];

/** A card's buttons: the daemon's words (design §3.8), or its options from an older daemon. */
function choicesOf(request: HumanRequestView): Choice[] {
  if (request.choices) return request.choices;
  return request.options.map((label, i) => ({
    label,
    explain: null,
    tone: i === 0 ? ("primary" as const) : ("secondary" as const),
    confirm: null,
    input: null,
  }));
}

/** Whether a card takes an answer in the person's own words (an older daemon: every card did). */
function takesText(request: HumanRequestView): boolean {
  return request.reply ? request.reply === "text" : true;
}

function RequestCard({
  request,
  dockerReady,
  specialists,
  onAnswer,
  unlock,
}: {
  request: HumanRequestView;
  dockerReady: boolean | null;
  specialists: ReadonlyMap<string, string | null> | null;
  onAnswer: (value: unknown) => Promise<void>;
  unlock: {
    bridge: RunnerKeyBridge;
    windowUntil: string | null;
    now: () => number;
    send: (prepared: PreparedAnswer) => Promise<void>;
  };
}) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** What the card says while a choice's answer is sent (L-20: "Writing the plan…"). */
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The choice asked to be confirmed, or whose words are being typed (`input: "text"`). */
  const [pending, setPending] = useState<Choice | null>(null);
  const [words, setWords] = useState("");
  const intake = intakeCardOf(request.changeCard);
  const challenge = unlockChallengeOf(request);
  const questions = challenge ? null : personQuestionsOf(request.changeCard);
  const choices = challenge ? [] : choicesOf(request);
  const withNote = choices.some((c) => c.input === "note");

  const send = async (value: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(value);
      setPending(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };
  /** A click on a choice: asked once first when it says so; its note or words go with it. */
  const choose = (c: Choice, confirmed = false) => {
    if (c.input === "text") {
      setPending(c);
      return;
    }
    if (c.confirm && !confirmed) {
      setPending(c);
      return;
    }
    if (!busy) setWorking(c.working ?? null);
    const n = note.trim();
    void send(c.input === "note" && n ? { choice: c.label, note: n } : c.label);
  };
  const title = request.title ?? request.why;
  const body = request.title ? request.body : null;
  const details = request.details ?? (questions ? [] : request.steps.map(inAppText));

  return (
    <li
      className={`rounded border p-3 ${
        request.blocking
          ? "border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
      id={`card-${request.id}`}
      data-testid="request"
      data-blocking={request.blocking ? "true" : "false"}
      data-request-id={request.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
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
          <span data-testid="request-task">
            Task:{" "}
            {request.projectId ? (
              <Link
                to={`/projects/${encodeURIComponent(request.projectId)}/tasks${
                  request.taskId ? `?task=${encodeURIComponent(request.taskId)}` : ""
                }`}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                {request.taskTitle}
              </Link>
            ) : (
              request.taskTitle
            )}
          </span>
        ) : null}
        <span className="ml-auto">{relativeTime(request.createdAt)}</span>
      </div>
      <p className="mt-1 font-medium" data-testid="request-title">
        {title}
      </p>
      {body ? (
        <p
          className="mt-1 text-sm text-neutral-700 dark:text-neutral-300"
          data-testid="request-body"
        >
          {body}
        </p>
      ) : null}
      {questions ? (
        <PersonQuestionsForm
          card={questions}
          busy={busy}
          onSend={send}
          showContext={!request.body}
        />
      ) : null}
      {intake ? (
        <IntakeCard
          card={intake}
          dockerReady={dockerReady}
          specialists={specialists}
          planTasks={request.planTasks}
        />
      ) : null}
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
      {details.length > 0 ? (
        <details className="mt-1 text-sm" data-testid="request-details">
          <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
            Details
          </summary>
          <ul className="mt-1 list-disc pl-5 text-neutral-700 dark:text-neutral-300">
            {details.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {withNote && !pending ? (
        <label className="mt-2 block text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">
            Note for the agent (optional): goes into the next attempt
          </span>
          <input
            className={`${INPUT_CLASS} mt-1`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="choice-note"
          />
        </label>
      ) : null}
      {pending ? (
        <div
          className="mt-2 space-y-2 rounded border border-neutral-300 p-2 text-sm dark:border-neutral-700"
          data-testid="choice-pending"
        >
          {pending.input === "text" ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (words.trim()) void send({ choice: pending.label, text: words.trim() });
              }}
            >
              <label className="block">
                <span>{pending.explain ?? pending.label}</span>
                <textarea
                  className={`${INPUT_CLASS} mt-1 min-h-16`}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  data-testid="choice-text"
                />
              </label>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !words.trim()}
                  data-testid="choice-send"
                >
                  Send
                </Button>
                <Button onClick={() => setPending(null)} disabled={busy}>
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p data-testid="choice-confirm">{pending.confirm}</p>
              <div className="flex gap-2">
                <Button
                  variant={pending.tone === "danger" ? "danger" : "primary"}
                  onClick={() => choose(pending, true)}
                  disabled={busy}
                  data-testid="choice-confirm-yes"
                >
                  {`Yes, ${pending.label.charAt(0).toLowerCase()}${pending.label.slice(1)}`}
                </Button>
                <Button onClick={() => setPending(null)} disabled={busy}>
                  Back
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {!pending && (choices.length > 0 || (request.links ?? []).length > 0) ? (
        <ul className="mt-2 space-y-1.5" data-testid="options">
          {/* A link that unblocks (Set up Docker) is the main way on; then the answers. */}
          {(request.links ?? []).map((l) => (
            <li key={l.label} className="flex flex-wrap items-center gap-2">
              <Link to={l.to} className={buttonClassName("primary")} data-testid="option-link">
                {l.label}
              </Link>
              {l.explain ? (
                <span className="text-xs text-neutral-600 dark:text-neutral-400">{l.explain}</span>
              ) : null}
            </li>
          ))}
          {choices.map((c) => (
            <li key={c.label} className="flex flex-wrap items-center gap-2">
              <Button
                // Design §3.8: the safe or likely option primary; a destructive one secondary
                // (outlined, its words in red) and asked once.
                variant={c.tone === "primary" ? "primary" : "secondary"}
                className={c.tone === "danger" ? "text-red-700 dark:text-red-300" : ""}
                onClick={() => choose(c)}
                disabled={busy}
                data-testid="option"
                data-tone={c.tone}
              >
                {c.label}
              </Button>
              {c.explain ? (
                <span
                  className="text-xs text-neutral-600 dark:text-neutral-400"
                  data-testid="option-explain"
                >
                  {c.explain}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {busy && working ? (
        <p
          className="mt-2 text-sm text-neutral-700 dark:text-neutral-300"
          role="status"
          data-testid="choice-working"
        >
          {working}
        </p>
      ) : null}
      {!challenge && !questions && !pending && takesText(request) ? (
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
            placeholder="Answer in your own words…"
            aria-label="Your answer"
            data-testid="free-text"
          />
          <Button type="submit" disabled={busy || !text.trim()} data-testid="send-free-text">
            Send
          </Button>
        </form>
      ) : null}
      {error ? (
        <div className="mt-2">
          <ErrorBanner message={error} />
        </div>
      ) : null}
    </li>
  );
}
