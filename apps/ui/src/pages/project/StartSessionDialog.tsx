import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { describeError, type StartCheckView, type StartSessionView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS, Money } from "../../components/ui.tsx";
import {
  chfMicroToUsdMicro,
  chfToMicro,
  formatAmount,
  formatChf,
  type MoneyLike,
} from "../../lib/money.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient, useIdentity } from "../../store/context.tsx";
import { useIntakeStatus } from "./IntakeBanner.tsx";

/**
 * What the dialog says when the start did not hand back a session to open (U-003). A waiting
 * start runs in order behind the ones already waiting, never replaced (U-043), so the notice
 * says how many come first.
 */
/**
 * The line in place of what the session runs while the agent drafts a plan (TR-12): a Start
 * waits for it, so saying "This session runs ..." read as if it started at once.
 */
export const PLANNING_WAIT_LINE =
  "Your agent is drafting a plan; this session starts once it is ready.";

export function startNotice(
  result: StartSessionView["result"],
  ahead = 0,
  opts: { planning?: boolean } = {},
): string {
  const before =
    ahead === 1
      ? "1 other start waits before this one; they run one after the other, in order."
      : `${ahead} other starts wait before this one; they run one after the other, in order.`;
  switch (result) {
    case "queued":
      // TR-12: what it waits for is a plan the agent drafts, not a session the person can see.
      if (opts.planning && ahead === 0)
        return "Queued: your agent is drafting a plan. This one starts when the plan is ready.";
      return ahead > 0
        ? `Queued: your agent is in another session, and ${before} This one starts after them.`
        : "Queued: your agent is in another session. This one starts when that one ends.";
    case "deferred":
      return ahead > 0
        ? `Deferred: it is quiet hours, and ${before} This one starts after them, once the quiet hours end.`
        : "Deferred: it is quiet hours. The session starts when they end.";
    default:
      return "Started: the session works until nothing more can run, the budget is used, or you stop it.";
  }
}

/** How the dialog names what a waiting task waits on (U-040), in plain status words. */
export function waitsOnText(waitsOn: StartCheckView["waiting"][number]["waitsOn"]): string {
  return waitsOn
    .map((d) =>
      d.title === null
        ? "a task that does not exist"
        : `"${d.title}" (${
            d.status === "needs_human"
              ? "needs you"
              : d.status === "in_progress" || d.status === "claimed"
                ? "running"
                : d.status === "in_review"
                  ? "being reviewed"
                  : d.status
          })`,
    )
    .join(" and ");
}

/** True when a waiting task waits on one that never finishes by itself (U-040). */
function stuck(w: StartCheckView["waiting"][number]): boolean {
  return w.waitsOn.some(
    (d) =>
      d.status === null ||
      d.status === "cancelled" ||
      d.status === "failed" ||
      d.status === "needs_human",
  );
}

/**
 * The full-review tasks that wait for the Docker sandbox (U-079), with what is wrong and the
 * step to take: they are not failed, and they run in a session once the sandbox is ready.
 */
export function sandboxWaitingText(w: NonNullable<StartCheckView["waitingForSandbox"]>): string {
  const names = w.tasks.map((t) => `"${t.title}"`).join(", ");
  const one = w.tasks.length === 1;
  return `${names} ${one ? "needs" : "need"} a full review, which runs in the Docker sandbox, and it is not ready: ${w.headline} Next: ${w.step}. ${one ? "It waits" : "They wait"}; nothing fails and no retry is used.`;
}

/** "about CHF 0.80" for a sum of estimates. */
function about(values: readonly { estimate: MoneyLike }[]): string {
  return `about ${formatChf(values.reduce((s, v) => s + v.estimate.chfMicro, 0))}`;
}

/**
 * What a session started now does (design §3.6): "This session runs "X" (about CHF 0.12) and
 * continues with up to 6 more as they become ready (about CHF 0.80)." Null when nothing runs.
 */
export function planSentence(check: StartCheckView): string | null {
  const [first, ...rest] = check.runnable;
  if (!first) return null;
  const more = [...rest, ...check.later];
  const head = `This session runs "${first.title}" (${about([first])})`;
  if (more.length === 0) return `${head}.`;
  return `${head} and continues with up to ${more.length} more as they become ready (${about(more)}).`;
}

/**
 * The lines that name what holds work back and what to do (design §3.6): a task waiting on a
 * failed, cancelled or person-held task, a full-review task waiting for Docker, a task larger
 * than the budget. At most three, then "and N more". Tasks that only wait on this session's own
 * work are not listed: they run as it goes on.
 */
function BlockerLines({ check }: { check: StartCheckView }) {
  const lines: { key: string; testId: string; node: React.ReactNode }[] = [];
  for (const w of check.waiting.filter(stuck))
    lines.push({
      key: `w-${w.taskId}`,
      testId: "start-session-waiting",
      node: (
        <>
          "{w.title}" waits on {waitsOnText(w.waitsOn)}: that will not be done by itself. Change
          what it waits for on the Tasks tab, or try the failed task again.
        </>
      ),
    });
  if (check.waitingForSandbox && check.waitingForSandbox.tasks.length > 0)
    lines.push({
      key: "sandbox",
      testId: "start-session-sandbox",
      node: (
        <>
          {sandboxWaitingText(check.waitingForSandbox)}{" "}
          <Link to="/settings#sandbox" className="text-blue-700 hover:underline dark:text-blue-300">
            Open Settings → Sandbox (Docker)
          </Link>
        </>
      ),
    });
  // A task left out is larger than the whole work budget, or (live walk 2, phase C) only does
  // not fit after the tasks that run first: "needs about CHF 1.20, more than this session's work
  // budget of CHF 2.40" was untrue for the second kind. Each says which it is.
  const first = check.runnable.reduce((s, r) => s + r.estimate.chfMicro, 0);
  for (const t of check.overBudget)
    lines.push({
      key: `b-${t.taskId}`,
      testId: "start-session-over-budget",
      node:
        t.estimate.usdMicro > check.workBudget.usdMicro ? (
          <>
            "{t.title}" needs about <Money value={t.estimate} />, more than this session's work
            budget of <Money value={check.workBudget} /> (the budget less a fifth kept for reviews).
            Give the session a larger budget, or the task a smaller one.
          </>
        ) : (
          <>
            "{t.title}" (about <Money value={t.estimate} />) may be left for next time: the tasks
            that run first take about {formatChf(first)} of this session's work budget of{" "}
            <Money value={check.workBudget} /> (the budget less a fifth kept for reviews). Give the
            session a larger budget to be sure it runs.
          </>
        ),
    });
  if (lines.length === 0) return null;
  return (
    <ul className="mt-1 list-disc pl-5" data-testid="start-session-blockers">
      {lines.slice(0, 3).map((l) => (
        <li key={l.key} data-testid={l.testId}>
          {l.node}
        </li>
      ))}
      {lines.length > 3 ? (
        <li data-testid="start-session-more">and {lines.length - 3} more</li>
      ) : null}
    </ul>
  );
}

/** The budget field's value refused in words (design §3.6), or null when it can be sent. */
export function budgetProblem(text: string, monthLeft: MoneyLike | null): string | null {
  if (!text.trim()) return null;
  const chf = chfToMicro(text.replace(",", "."));
  if (chf === null)
    return text.trim().startsWith("-")
      ? "The budget must be more than CHF 0."
      : "The budget must be an amount in CHF, like 5.00.";
  if (chf <= 0) return "The budget must be more than CHF 0.";
  if (monthLeft && chf > monthLeft.chfMicro)
    return `That is more than what is left of your monthly cap (${formatChf(monthLeft.chfMicro)}).`;
  return null;
}

/**
 * Start a session for the project -> POST /sessions. Says first what the session will do, with
 * the real default budget filled in; refuses a start that would do nothing with the reason and
 * the button that unblocks it; after Start the person stays where they were (design §3.6).
 */
export function StartSessionDialog({
  open,
  onClose,
  projectId,
  reference,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** A Money pair that carries the day's rate for the CHF budget input. */
  reference: MoneyLike;
}) {
  const client = useClient();
  const identity = useIdentity();
  const [budget, setBudget] = useState("");
  const [budgetTouched, setBudgetTouched] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  // What a session would do, with the budget typed so far (the project's default while empty).
  const typedChf = budgetTouched && budget.trim() ? chfToMicro(budget.replace(",", ".")) : null;
  const budgetUsdMicro =
    typedChf !== null && typedChf > 0 ? chfMicroToUsdMicro(typedChf, reference) : undefined;
  const check = useAsync(
    (signal) =>
      open ? client.startCheck(projectId, { budgetUsdMicro }, signal) : Promise.resolve(null),
    [client, projectId, open, budgetUsdMicro, checkTick],
  );
  const data = check.data;
  // The real default, filled in once it is known (design §3.6: "CHF 5.00", never a hidden one).
  useEffect(() => {
    if (open && data && !budgetTouched && !budget)
      setBudget(formatAmount(data.sessionBudget.chfMicro).replace(/'/g, ""));
  }, [open, data, budgetTouched, budget]);
  useEffect(() => {
    if (!open) {
      setNotice(null);
      setStartedId(null);
      setBudget("");
      setBudgetTouched(false);
      setNote("");
      setError(null);
    }
  }, [open]);
  const intake = useIntakeStatus(projectId, { enabled: open }).data?.state ?? null;
  const problem = budgetProblem(budget, data?.monthLeft ?? null);
  const blocked = data?.blocked ?? null;
  // leftovers7-tailrun TR-2: work that waits for a credential's reset no Start has kept a wait
  // for yet: the line says what Start does, and Start keeps the wait (looking records nothing).
  const stops = !!blocked && !blocked.startable;
  // What a session would run is said only when it can start: above "Claude is not connected"
  // or "Sessions are stopped", "This session runs ..." contradicted the disabled Start.
  // TR-12: while the agent drafts a plan, a Start waits for it: the line says that instead.
  const planning = !!data?.planning && !blocked;
  const plan = data && !blocked ? (planning ? PLANNING_WAIT_LINE : planSentence(data)) : null;
  // While the plan from the brief waits for approval, is being drafted or waits for a Claude
  // credential (U-078), the daemon's one
  // sentence names it with its one link (startBlocked); nothing is said twice (wave 2 handoff:
  // three statements of one blocker, one pointing to the Tasks tab).
  const planBlocks = intake === "pending" || intake === "drafting" || intake === "waiting";
  const noReadyTask =
    data !== null && data.ready === 0 && blocked?.kind === "nothing_runnable" && !planBlocks;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !identity || stops || problem) return;
    const chf = budget.trim() ? chfToMicro(budget.replace(",", ".")) : null;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const started = await client.startSession({
        agentId: identity.agentId,
        projectId,
        trigger: "manual",
        // The default as filled in is the project's own: sent only when the person changed it.
        budgetUsdMicro:
          budgetTouched && chf !== null && chf > 0 ? chfMicroToUsdMicro(chf, reference) : undefined,
        note: note.trim() || undefined,
      });
      setNote("");
      // The person stays where they were (design §3.6); the session can be opened from here.
      setNotice(startNotice(started.result, started.ahead, { planning }));
      setStartedId(started.session?.id ?? null);
      setCheckTick((n) => n + 1);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    try {
      await client.resume();
      setCheckTick((n) => n + 1);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Start a session" testId="start-session-dialog">
      <form onSubmit={submit} className="space-y-3">
        {plan ? (
          <p className="text-sm" data-testid="start-session-plan">
            {plan}
          </p>
        ) : null}
        {blocked ? (
          <div
            role="note"
            className="rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            data-testid={noReadyTask ? "start-session-no-work" : "start-session-cannot-run"}
          >
            <p className="font-medium" data-testid="start-session-blocked">
              {blocked.sentence}
            </p>
            {blocked.action ? (
              blocked.action.kind === "resume" ? (
                <Button onClick={() => void resume()} data-testid="start-session-unblock">
                  {blocked.action.label}
                </Button>
              ) : (
                <Link
                  to={blocked.action.to ?? "/"}
                  className="text-blue-700 hover:underline dark:text-blue-300"
                  data-testid="start-session-unblock"
                  onClick={onClose}
                >
                  {blocked.action.label}
                </Link>
              )
            ) : null}
            {noReadyTask ? (
              <p className="mt-1">
                Give your agent work first: add a task on the Tasks tab, click Make ready on a draft
                there, or ask in Chat, for example "add a task: write the README".
              </p>
            ) : null}
            {noReadyTask && intake === "failed" ? (
              <p className="mt-1" data-testid="start-session-intake">
                The plan from your brief could not be drafted; the project page says why and has a
                Retry.
              </p>
            ) : null}
            {data ? <BlockerLines check={data} /> : null}
          </div>
        ) : data && plan ? (
          <BlockerLines check={data} />
        ) : null}
        <Field
          label="Session budget (CHF)"
          hint={`The project's default is filled in. The session stops when it is used; a fifth is kept for reviews.${
            data?.monthLeft ? ` Left this month: ${formatChf(data.monthLeft.chfMicro)}.` : ""
          }`}
        >
          <input
            className={INPUT_CLASS}
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setBudgetTouched(true);
            }}
            inputMode="decimal"
            name="budget"
          />
        </Field>
        {problem ? (
          <p
            className="text-sm text-red-700 dark:text-red-300"
            data-testid="start-session-budget-error"
          >
            {problem}
          </p>
        ) : null}
        <Field
          label="Note for this session (optional)"
          hint="Goes into the brief of every task this session runs."
        >
          <input
            className={INPUT_CLASS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            name="note"
          />
        </Field>
        {!identity ? (
          <p className="text-xs text-neutral-500">Waiting for the daemon to report your agent…</p>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        {notice ? (
          <p
            role="status"
            className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
            data-testid="start-session-notice"
          >
            {notice}{" "}
            {startedId ? (
              <Link
                to={`/sessions/${encodeURIComponent(startedId)}`}
                className="text-blue-700 hover:underline dark:text-blue-300"
                data-testid="start-session-open"
                onClick={onClose}
              >
                Open the session
              </Link>
            ) : null}
          </p>
        ) : null}
        {/* After Start the notice says what happened; the line about what Start would do goes
            (wave 1 handoff: "Started: …" stood above "Starts after the current session", read
            again from the start check the new session itself made busy). A refused start
            waits for nothing: another project's session makes nothing here runnable (later
            #38), so it never reads "Starts after the current session". */}
        {notice ? null : (
          <p className="text-xs text-neutral-500" data-testid="start-session-explain">
            {data?.busy && !blocked && !planning
              ? "Starts after the current session; then works until nothing more can run, the budget is used, or you stop it."
              : "Start: works until nothing more can run, the budget is used, or you stop it."}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{notice ? "Close" : "Cancel"}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !identity || stops || !!problem}
            data-testid="confirm-start-session"
          >
            {busy ? "Starting…" : "Start"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
