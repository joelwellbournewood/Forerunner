import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Badge, Button, ErrorBanner, Loading, Money } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";
import { DecisionsSection } from "./DecisionsSection.tsx";
import { PeersSection } from "./PeersSection.tsx";
import { QueueSection } from "./QueueSection.tsx";

/**
 * Summary tab: the one-screen summary, then what the next session will read (the queue),
 * what the other agents are doing (peers, spec F.6) and the decision log (spec J.4).
 */
export function SummaryTab({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6" data-testid="summary-tab">
      <SummaryCard projectId={projectId} />
      <QueueSection projectId={projectId} />
      <PeersSection projectId={projectId} />
      <DecisionsSection projectId={projectId} />
    </div>
  );
}

function speechAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/** The daemon's cached one-screen summary with a "Read aloud" button (Web Speech). */
function SummaryCard({ projectId }: { projectId: string }) {
  const client = useClient();
  const summary = useAsync(
    (signal) => client.projectSummary(projectId, signal),
    [client, projectId],
  );
  const [speaking, setSpeaking] = useState(false);
  const canSpeak = speechAvailable();

  useEffect(() => {
    return () => {
      if (speechAvailable()) window.speechSynthesis.cancel();
    };
  }, []);

  const speak = () => {
    if (!summary.data || !canSpeak) return;
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(summary.data.spoken);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  };

  if (summary.loading && !summary.data) return <Loading what="summary" />;
  if (summary.error && !summary.data)
    return <ErrorBanner message={summary.error} onRetry={summary.reload} />;
  const data = summary.data;
  if (!data) return null;

  return (
    <div className="space-y-4" data-testid="summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{data.stage}</Badge>
        <Badge tone={data.openQuestions > 0 ? "warn" : "neutral"}>
          {data.openQuestions} open question{data.openQuestions === 1 ? "" : "s"}
        </Badge>
        <span className="text-sm text-neutral-600 dark:text-neutral-400">
          Spent <Money value={data.spend} />
        </span>
        <Button
          className="ml-auto"
          onClick={speak}
          disabled={!canSpeak}
          title={
            canSpeak
              ? "Read the summary aloud"
              : "Speech synthesis is not available in this webview"
          }
          data-testid="read-aloud"
          aria-pressed={speaking}
        >
          {speaking ? "Stop reading" : "Read aloud"}
        </Button>
        <Button variant="ghost" onClick={summary.reload}>
          Refresh
        </Button>
      </div>
      <div>
        <h2 className="font-semibold">Goal</h2>
        <p className="text-sm">{data.goal}</p>
      </div>
      <div>
        <h2 className="font-semibold">Last session</h2>
        {data.lastSession ? (
          <div className="text-sm">
            <p>{data.lastSession.summary}</p>
            <p className="mt-1 text-xs text-neutral-500">
              ended {formatDateTime(data.lastSession.endedAt)} · {data.lastSession.stopReason} ·{" "}
              <Link
                to={`/sessions/${encodeURIComponent(data.lastSession.id)}`}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                open the log
              </Link>
            </p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No session yet.</p>
        )}
      </div>
      <div>
        <h2 className="font-semibold">Next steps</h2>
        {data.nextSteps.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing planned.</p>
        ) : (
          <ol className="list-decimal pl-5 text-sm">
            {data.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
