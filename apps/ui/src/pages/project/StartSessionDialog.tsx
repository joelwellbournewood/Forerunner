import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { describeError, type StartCheckView, type StartSessionView } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import {
  AboutMoney,
  Button,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Money,
} from "../../components/ui.tsx";
import {
  aboutChf,
  chfMicroToUsdMicro,
  chfToMicro,
  chfWords,
  formatAmount,
  type MoneyLike,
} from "../../lib/money.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient, useIdentity } from "../../store/context.tsx";
import { useIntakeStatus } from "./IntakeBanner.tsx";

/**
 * The line in place of what the session runs while the agent drafts a plan (TR-12): a Start
 * waits for it, so saying "This session runs ..." read as if it started at once. W15-39: "it"
 * named the session or the plan; it names the plan.
 */
export const PLANNING_WAIT_LINE =
  "Your agent is drafting a plan; this session starts once the plan is ready.";

/**
 * What the dialog says when the start did not hand back a session to open (U-003). A waiting
 * start runs in order behind the ones already waiting, never replaced (U-043), so the notice
 * says how many come first. While the agent drafts a plan, that is what it waits for, with or
 * without starts ahead (W15-39: with one ahead it said "your agent is in another session").
 */
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
      if (opts.planning)
        return ahead > 0
          ? `Queued: your agent is drafting a plan, and ${before} This one starts after them, once the plan is ready.`
          : "Queued: your agent is drafting a plan. This one starts when the plan is ready.";
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

/** A dependency's state as a clause ("which failed"), never the stored status (later #69). */
function stateClause(status: string | null): string {
  switch (status) {
    case "failed":
      return "which failed";
    case "cancelled":
      return "which was cancelled";
    case "needs_human":
      return "which needs your answer";
    case "in_progress":
    case "claimed":
      return "which is running";
    case "in_review":
      return "which is being reviewed";
    case "draft":
      return "which is a draft";
    case "done":
      return "which is done";
    default:
      return "which has not run yet";
  }
}

/**
 * How the dialog names what a waiting task waits on (U-040), in plain words: '"A", which
 * failed, and "B", which is a draft'. Before (later #69): '"A" (failed) and "B" (draft)', the
 * stored statuses in parentheses.
 */
export function waitsOnText(waitsOn: StartCheckView["waiting"][number]["waitsOn"]): string {
  const parts = waitsOn.map((d) =>
    d.title === null ? "a task that does not exist" : `"${d.title}", ${stateClause(d.status)}`,
  );
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** What to do about a stuck task, by what holds it: try the failed one, or answer, or re-wire. */
function stuckAdvice(w: StartCheckView["waiting"][number]): string {
  const failed = w.waitsOn.find((d) => d.status === "failed" && d.title !== null);
  if (failed) return `Try "${failed.title}" again, or change what it waits for on the Tasks tab.`;
  if (w.waitsOn.some((d) => d.status === "needs_human"))
    return "Answer it in the Inbox, or change what it waits for on the Tasks tab.";
  return "Change what it waits for on the Tasks tab.";
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

/** "about CHF 0.80" for a sum of estimates ("less than CHF 0.01" under a centime, W15-74). */
function about(values: readonly { estimate: MoneyLike }[]): string {
  return aboutChf(values.reduce((s, v) => s + v.estimate.chfMicro, 0));
}

/**
 * What a session started now does (design §3.6): "This session runs "X" (about CHF 0.12) and
 * continues with up to 6 more as they become ready (about CHF 0.80)." The tasks ready now are
 * counted apart from those that become ready ("and 1 more (about CHF 0.40)"): before (later
 * #48), a task ready now was one of "up to N more as they become ready". Null when nothing runs.
 */
export function planSentence(check: StartCheckView): string | null {
  const [first, ...rest] = check.runnable;
  if (!first) return null;
  const head = `This session runs "${first.title}" (${about([first])})`;
  const now = rest.length > 0 ? ` and ${rest.length} more (${about(rest)})` : "";
  if (check.later.length === 0) return `${head}${now}.`;
  return `${head}${now}${now ? ", then" : " and"} continues with up to ${check.later.length} more as they become ready (${about(check.later)}).`;
}

/**
 * '"A" (about CHF 6.00) and "B" (about CHF 7.00)': at most three named, then "and N more"
 * (W15-38: the line named every task).
 */
function namesWithEstimates(tasks: readonly { title: string; estimate: MoneyLike }[]): string {
  const parts = tasks.map((t) => `"${t.title}" (${aboutChf(t.estimate.chfMicro)})`);
  if (parts.length > 3) return `${parts.slice(0, 3).join(", ")} and ${parts.length - 3} more`;
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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
          "{w.title}" waits on {waitsOnText(w.waitsOn)}, so it cannot run. {stuckAdvice(w)}
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
  // budget of CHF 2.40" was untrue for the second kind. Each says which it is. C-45: the tasks
  // larger than the budget are one line (each had its own, saying the same); "the tasks that run
  // first" is what the check says runs before that task (`ahead`), not every task that runs.
  const tooBig = check.overBudget.filter((t) => t.estimate.usdMicro > check.workBudget.usdMicro);
  const [onlyBig] = tooBig;
  if (onlyBig && tooBig.length === 1)
    lines.push({
      key: `b-${onlyBig.taskId}`,
      testId: "start-session-over-budget",
      node: (
        <>
          "{onlyBig.title}" needs <AboutMoney value={onlyBig.estimate} />, more than this session's
          work budget of <Money value={check.workBudget} /> (the budget less a fifth kept for
          reviews). Give the session a larger budget, or the task a smaller one.
        </>
      ),
    });
  else if (tooBig.length > 1)
    lines.push({
      key: "b-too-big",
      testId: "start-session-over-budget",
      node: (
        <>
          {namesWithEstimates(tooBig)} each need more than this session's work budget of{" "}
          <Money value={check.workBudget} /> (the budget less a fifth kept for reviews). Give the
          session a larger budget, or the tasks smaller ones.
        </>
      ),
    });
  // An older daemon does not say what runs before a task: every task that runs, as before.
  const allFirst = check.runnable.reduce((s, r) => s + r.estimate.chfMicro, 0);
  // W15-38: the tasks that may be left for next time are one line (each had the same long
  // sentence), at most three named; "the tasks that run first" is what runs before the first of
  // them, which the others wait behind too.
  const left = check.overBudget.filter((x) => !tooBig.includes(x));
  const [firstLeft] = left;
  if (firstLeft && left.length === 1)
    lines.push({
      key: `b-${firstLeft.taskId}`,
      testId: "start-session-over-budget",
      node: (
        <>
          "{firstLeft.title}" (<AboutMoney value={firstLeft.estimate} />) may be left for next time:
          the tasks that run first take {aboutChf(firstLeft.ahead?.chfMicro ?? allFirst)} of this
          session's work budget of <Money value={check.workBudget} /> (the budget less a fifth kept
          for reviews). Give the session a larger budget to be sure it runs.
        </>
      ),
    });
  else if (firstLeft)
    lines.push({
      key: "b-left",
      testId: "start-session-over-budget",
      node: (
        <>
          {namesWithEstimates(left)} may be left for next time: the tasks that run first take{" "}
          {aboutChf(firstLeft.ahead?.chfMicro ?? allFirst)} of this session's work budget of{" "}
          <Money value={check.workBudget} /> (the budget less a fifth kept for reviews). Give the
          session a larger budget to be sure they run.
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
      ? "The budget must be more than CHF 0.00."
      : "The budget must be an amount in CHF, like 5.00.";
  // W15B-16: CHF with its two decimals (design §5 rule 7), never "CHF 0".
  if (chf <= 0) return "The budget must be more than CHF 0.00.";
  if (monthLeft && chf > monthLeft.chfMicro)
    return `That is more than what is left of your monthly cap (${chfWords(monthLeft.chfMicro)}).`;
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
    if (busy || notice || !identity || stops || problem) return;
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
        {/* After Start only what happened stays (the notice, Open the session, Close): the
            start check read again still said "This session runs …" for a session that would not
            start, above a budget and a note nothing would use (review of P7-16). */}
        {notice ? null : (
          <>
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
                    Give your agent work first: add a task on the Tasks tab, click Make ready on a
                    draft there, or ask in Chat, for example "add a task: write the README".
                  </p>
                ) : null}
                {noReadyTask && intake === "failed" ? (
                  <p className="mt-1" data-testid="start-session-intake">
                    The plan from your brief could not be drafted; the project page says why and has
                    a Retry.
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
                data?.monthLeft ? ` Left this month: ${chfWords(data.monthLeft.chfMicro)}.` : ""
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
          </>
        )}
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
          {/* After a start the dialog says what happened, with Open the session and Close: no
              second Start beside "Started: …" (P7-16; a second start is a new opening of the
              dialog, which then says "Starts after the current session"). */}
          {notice ? null : (
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !identity || stops || !!problem}
              data-testid="confirm-start-session"
            >
              {busy ? "Starting…" : "Start"}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
