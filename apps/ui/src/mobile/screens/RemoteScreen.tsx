import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { describeStateError, type PlanCommand, type SessionView } from "../../api/state-client.ts";
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  statusTone,
} from "../../components/ui.tsx";
import { chfShort, type MobileChangeCard, renderCard } from "../change-card.ts";
import type { ChangeEntry } from "../change-log.ts";
import { type IntentQuestion, IntentRefused, parseIntent } from "../intent.ts";
import { activeMobileProject, useMobileController, useMobileState } from "../store.tsx";
import { nextLocalTime, startOfTomorrow } from "../time.ts";

/**
 * Remote control (spec R.4, Q): switch project, raise a budget (CHF amount, until a time),
 * start a session on the PC, stop everything. Either say it ("switch to the game, give it
 * 15 francs until tomorrow and start a session on my PC") or use the controls; both make ONE
 * plan, shown as ONE change card, sent as ONE remote command after a tap, logged with Undo.
 */
type UntilChoice = "none" | "tonight" | "tomorrow" | "time";

interface Preview {
  words: string;
  plan: PlanCommand[];
  card: MobileChangeCard;
  source: ChangeEntry["source"];
}

export function RemoteScreen() {
  const controller = useMobileController();
  const location = useLocation();
  const state = useMobileState((s) => s);
  const active = activeMobileProject(state);
  const changeVersion = state.changeLogVersion;
  const [words, setWords] = useState("");
  const [switchTo, setSwitchTo] = useState("");
  const [amount, setAmount] = useState("");
  const [until, setUntil] = useState<UntilChoice>("none");
  const [untilTime, setUntilTime] = useState("06:00");
  const [startSession, setStartSession] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [question, setQuestion] = useState<IntentQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastEntryId, setLastEntryId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);

  const spoken = (location.state as { words?: unknown } | null)?.words;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the words handed over from Chat
  useEffect(() => {
    if (typeof spoken === "string" && spoken.trim()) {
      setWords(spoken);
      say(spoken);
    }
  }, [spoken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the change-log version is the reload key
  useEffect(() => {
    let cancelled = false;
    void controller.api
      .sessions({ status: "running" })
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [controller, changeVersion]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the change-log version is the cache key
  const lastEntry = useMemo(
    () => (lastEntryId ? (controller.changeLog.get(lastEntryId) ?? null) : null),
    [controller, lastEntryId, changeVersion],
  );

  const intentContext = () => ({
    timezone: controller.env.timezone,
    now: controller.env.now(),
    activeProjectId: state.activeProjectId,
    projects: state.projects.map((p) => ({ id: p.id, name: p.name })),
    source: "ui" as const,
  });

  const showPlan = (plan: PlanCommand[], text: string, source: ChangeEntry["source"]) => {
    setError(null);
    setQuestion(null);
    if (plan.length === 0) {
      setError("Nothing to change: pick a project, an amount or a session.");
      return;
    }
    try {
      setPreview({ words: text, plan, card: controller.planCard(plan), source });
    } catch (e) {
      setError(describeStateError(e));
    }
  };

  function say(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const result = parseIntent(trimmed, { ...intentContext(), source: "chat" });
      if (result.question) {
        setPreview(null);
        setQuestion(result.question);
        return;
      }
      showPlan(result.commands, trimmed, "chat");
    } catch (e) {
      setPreview(null);
      setError(
        e instanceof IntentRefused
          ? "That text looks like content from a page or an email; it is not treated as a request."
          : describeStateError(e),
      );
    }
  }

  const buildFromControls = () => {
    const plan: PlanCommand[] = [];
    const parts: string[] = [];
    let projectId = state.activeProjectId;
    if (switchTo && switchTo !== state.activeProjectId) {
      plan.push({ name: "project.switch", params: { project: switchTo } });
      projectId = switchTo;
      parts.push(`switch to ${state.projects.find((p) => p.id === switchTo)?.name ?? switchTo}`);
    }
    const chf = Number(amount.replace(",", "."));
    if (amount.trim() && Number.isFinite(chf) && chf > 0) {
      const params: Record<string, unknown> = { scope: "session", amountChf: chf };
      if (projectId) params.project = projectId;
      const now = controller.env.now();
      const tz = controller.env.timezone;
      if (until === "tonight") params.until = new Date(nextLocalTime(now, 6, 0, tz)).toISOString();
      else if (until === "tomorrow")
        params.until = new Date(startOfTomorrow(now, tz)).toISOString();
      else if (until === "time") {
        const m = /^(\d{1,2}):(\d{2})$/.exec(untilTime);
        if (m) {
          params.until = new Date(nextLocalTime(now, Number(m[1]), Number(m[2]), tz)).toISOString();
        }
      }
      plan.push({ name: "budget.set", params });
      parts.push(
        `give it ${chfShort(Math.round(chf * 1_000_000))}${until === "none" ? "" : ` ${until === "time" ? `until ${untilTime}` : until}`}`,
      );
    }
    if (startSession) {
      const params: Record<string, unknown> = { runner: "pc" };
      if (projectId) params.project = projectId;
      plan.push({ name: "session.start", params });
      parts.push("start a session on my PC");
    }
    showPlan(plan, parts.join(", "), "ui");
  };

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await controller.sendPlan({
        words: preview.words,
        plan: preview.plan,
        card: preview.card,
        source: preview.source,
      });
      setLastEntryId(result.entry.id);
      setPreview(null);
      setWords("");
      setAmount("");
      setSwitchTo("");
      setStartSession(false);
      setUntil("none");
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (entry: ChangeEntry) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.undo(entry.id);
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(false);
    }
  };

  const stopAll = () => {
    showPlan([{ name: "session.stop", params: { scope: "all" } }], "stop everything", "ui");
  };

  const pause = () => {
    showPlan([{ name: "session.pause", params: {} }], "pause the session", "ui");
  };

  return (
    <section aria-labelledby="m-remote-title" className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 id="m-remote-title" className="text-xl font-semibold">
          Remote control
        </h1>
        <Badge tone="info" testId="m-remote-active">
          {active ? active.name : "no active project"}
        </Badge>
        <Link
          to="/changes"
          className="ml-auto text-sm text-blue-700 hover:underline dark:text-blue-300"
        >
          Change log
        </Link>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          say(words);
        }}
      >
        <Field
          label="Say what to change"
          hint='e.g. "switch to the game, give it 15 francs until tomorrow and start a session on my PC"'
        >
          <input
            className={INPUT_CLASS}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            data-testid="m-say"
            aria-label="Say what to change"
          />
        </Field>
        <Button type="submit" variant="primary" data-testid="m-say-submit" disabled={!words.trim()}>
          Show the change card
        </Button>
      </form>

      {question ? (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
          data-testid="m-question"
        >
          <p>{question.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {question.options.map((o) => (
              <Button
                key={o}
                onClick={() => {
                  const next = `${words.trim()} ${o}`.trim();
                  setWords(next);
                  say(next);
                }}
              >
                {o}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <details
        className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        data-testid="m-controls"
      >
        <summary className="cursor-pointer text-sm font-medium">Or use the controls</summary>
        <div className="mt-3 space-y-3">
          <Field label="Switch project">
            <select
              className={INPUT_CLASS}
              value={switchTo}
              onChange={(e) => setSwitchTo(e.target.value)}
              data-testid="m-switch"
            >
              <option value="">(keep {active ? active.name : "the active project"})</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Session budget (CHF)" hint="Raises the session budget of the project">
            <input
              className={INPUT_CLASS}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="15"
              data-testid="m-amount"
            />
          </Field>
          <Field label="Until">
            <select
              className={INPUT_CLASS}
              value={until}
              onChange={(e) => setUntil(e.target.value as UntilChoice)}
              data-testid="m-until"
            >
              <option value="none">until reverted</option>
              <option value="tonight">tonight (06:00)</option>
              <option value="tomorrow">tomorrow (06:00)</option>
              <option value="time">a time…</option>
            </select>
          </Field>
          {until === "time" ? (
            <Field label="Time (HH:MM)">
              <input
                className={INPUT_CLASS}
                value={untilTime}
                onChange={(e) => setUntilTime(e.target.value)}
                data-testid="m-until-time"
              />
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={startSession}
              onChange={(e) => setStartSession(e.target.checked)}
              data-testid="m-start-session"
            />
            Start a session on my PC
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={buildFromControls} data-testid="m-preview">
              Show the change card
            </Button>
            <Button variant="secondary" onClick={pause} data-testid="m-pause">
              Pause
            </Button>
            <Button variant="danger" onClick={stopAll} data-testid="m-stop-all">
              Stop everything
            </Button>
          </div>
        </div>
      </details>

      {preview ? (
        <div
          className="rounded border border-blue-300 bg-blue-50/40 p-3 dark:border-blue-800 dark:bg-blue-950/30"
          data-testid="m-card"
          data-risk={preview.card.impact.risk}
          data-parts={preview.card.parts?.length ?? 1}
        >
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Change card</h2>
            <Badge
              tone={
                preview.card.impact.risk === "high"
                  ? "bad"
                  : preview.card.impact.risk === "medium"
                    ? "warn"
                    : "neutral"
              }
            >
              {preview.card.impact.risk} risk
            </Badge>
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-sm" data-testid="m-card-text">
            {renderCard(preview.card)}
          </pre>
          {preview.card.impact.risk === "high" ? (
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              High risk: the PC will post an approval that you confirm here with your fingerprint or
              face before anything changes.
            </p>
          ) : null}
          <p className="mt-1 text-xs text-neutral-500">
            Commands: {preview.plan.map((c) => c.name).join(", ")}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              onClick={() => void confirm()}
              disabled={busy}
              data-testid="m-confirm"
            >
              {busy ? "Sending…" : "Confirm"}
            </Button>
            <Button variant="secondary" onClick={() => setPreview(null)} data-testid="m-cancel">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {lastEntry ? (
        <div
          className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
          data-testid="m-result"
          data-status={lastEntry.status}
        >
          <div className="flex items-center gap-2">
            <Badge
              tone={statusTone(lastEntry.status === "sent" ? "pending" : lastEntry.status)}
              testId="m-result-status"
            >
              {lastEntry.status === "sent"
                ? "sent to your PC"
                : lastEntry.status === "picked_up"
                  ? "PC picked it up"
                  : lastEntry.status === "done"
                    ? "done on your PC"
                    : lastEntry.status}
            </Badge>
            {controller.changeLog.canUndo(lastEntry) ? (
              <Button
                variant="secondary"
                className="ml-auto"
                onClick={() => void undo(lastEntry)}
                disabled={busy}
                data-testid="m-undo"
              >
                Undo
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-sm">{lastEntry.card.sentence}</p>
          {lastEntry.result !== null && lastEntry.result !== undefined ? (
            <pre
              className="mt-1 overflow-auto text-xs text-neutral-500"
              data-testid="m-result-detail"
            >
              {JSON.stringify(lastEntry.result)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorBanner message={error} testId="m-remote-error" /> : null}

      <div>
        <h2 className="font-semibold">Running sessions</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="m-no-sessions">
            None running.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {sessions.map((s) => (
              <li key={s.id} className="text-sm" data-testid="m-session">
                <Link
                  to={`/sessions/${encodeURIComponent(s.id)}`}
                  className="text-blue-700 hover:underline dark:text-blue-300"
                >
                  {s.agentName} on{" "}
                  {state.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId}
                </Link>{" "}
                <Badge tone={statusTone(s.status)}>{s.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
