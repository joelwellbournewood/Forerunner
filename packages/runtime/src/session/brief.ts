/**
 * The state brief: a compact, structured summary handed to the principal agent at session start
 * instead of raw history (spec E, N). Rendered under a token cap (default 2,000).
 */
export interface BriefTask {
  id: string;
  title: string;
  status: string;
  riskTier: number;
  priority: number;
  claimedBy: string | null;
  attempt: number;
  prUrl: string | null;
}

export interface BriefMessage {
  id: string;
  from: string;
  type: string;
  body: string;
  requiresAck: boolean;
  createdAt: string;
}

export interface BriefRequest {
  id: string;
  kind: string;
  why: string;
  blocking: boolean;
  options: string[];
}

export interface BriefFinding {
  id: string;
  taskId: string | null;
  severity: string;
  description: string;
  requiredAction: string;
}

export interface BriefBudget {
  monthSpentUsdMicro: number;
  monthCapUsdMicro: number;
  projectSpentUsdMicro: number;
  projectCapUsdMicro: number;
  sessionCapUsdMicro: number;
  planUsageShare: number | null;
}

export interface StateBrief {
  generatedAt: string;
  agent: { id: string; name: string };
  human: { id: string; name: string; timezone: string };
  project: {
    id: string;
    name: string;
    goal: string;
    stage: string;
    autonomy: number;
    summary: Record<string, unknown>;
  } | null;
  version: { app: string; latestRelease: string | null; updateAvailable: boolean };
  git: { fetched: boolean; detail: string };
  sharedState: { synced: boolean; detail: string };
  inbox: { unread: BriefMessage[]; unreadCount: number; unacknowledgedSent: number };
  humanRequests: { open: BriefRequest[]; openCount: number };
  findings: { open: BriefFinding[]; openCount: number };
  budget: BriefBudget;
  lastSession: {
    id: string;
    endedAt: string | null;
    summary: string;
    handoff: Record<string, unknown> | null;
  } | null;
  changesSinceLastSession: { tasks: BriefTask[]; count: number };
  tasks: {
    ready: BriefTask[];
    readyCount: number;
    claimedByMe: BriefTask[];
    claimedByOthers: BriefTask[];
  };
  peers: { agentId: string; agentName: string; activeClaims: number; lastHandoff: string | null }[];
  queue: { items: { kind: string; text: string; priority: number }[]; count: number };
  warnings: string[];
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "n/a");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface RenderOptions {
  maxTokens?: number;
  countTokens?: (text: string) => number;
}

/** Render the brief as markdown; lists shrink until the whole thing fits the token cap. */
export function renderStateBrief(b: StateBrief, opts: RenderOptions = {}): string {
  const cap = opts.maxTokens ?? 2000;
  const count = opts.countTokens ?? ((t: string) => Math.ceil(t.length / 4));
  let limits = { msgs: 8, reqs: 8, findings: 8, tasks: 10, changes: 8, queue: 6, bodyChars: 200 };
  for (let i = 0; i < 12; i++) {
    const text = render(b, limits);
    if (count(text) <= cap) return text;
    limits = {
      msgs: Math.max(1, Math.floor(limits.msgs / 2)),
      reqs: Math.max(1, Math.floor(limits.reqs / 2)),
      findings: Math.max(1, Math.floor(limits.findings / 2)),
      tasks: Math.max(2, Math.floor(limits.tasks / 2)),
      changes: Math.max(1, Math.floor(limits.changes / 2)),
      queue: Math.max(1, Math.floor(limits.queue / 2)),
      bodyChars: Math.max(60, Math.floor(limits.bodyChars / 2)),
    };
  }
  return render(b, {
    msgs: 1,
    reqs: 1,
    findings: 1,
    tasks: 2,
    changes: 1,
    queue: 1,
    bodyChars: 60,
  });
}

function render(
  b: StateBrief,
  l: {
    msgs: number;
    reqs: number;
    findings: number;
    tasks: number;
    changes: number;
    queue: number;
    bodyChars: number;
  },
): string {
  const lines: string[] = [];
  lines.push(`# State brief (${b.generatedAt})`);
  lines.push(`Agent ${b.agent.name} for ${b.human.name} (${b.human.timezone}).`);
  if (b.project) {
    lines.push(
      `Project: ${b.project.name} — stage ${b.project.stage}, autonomy ${b.project.autonomy}. Goal: ${clip(b.project.goal, l.bodyChars)}`,
    );
    const next = (b.project.summary as { next_steps?: string[] }).next_steps;
    if (next?.length) lines.push(`Next steps from last summary: ${next.slice(0, 3).join("; ")}`);
  } else lines.push("Project: none (cross-project session).");
  lines.push(
    `Version ${b.version.app}${b.version.updateAvailable ? ` (update available: ${b.version.latestRelease})` : ""}. Git: ${b.git.detail}. Shared state: ${b.sharedState.detail}.`,
  );
  lines.push(
    `Budget: month ${usd(b.budget.monthSpentUsdMicro)} of ${usd(b.budget.monthCapUsdMicro)} (${pct(b.budget.monthSpentUsdMicro, b.budget.monthCapUsdMicro)}); project ${usd(b.budget.projectSpentUsdMicro)} of ${usd(b.budget.projectCapUsdMicro)}; this session cap ${usd(b.budget.sessionCapUsdMicro)}${b.budget.planUsageShare !== null ? `; plan usage ${Math.round(b.budget.planUsageShare * 100)}%` : ""}.`,
  );
  if (b.warnings.length) lines.push(`Warnings: ${b.warnings.join(" | ")}`);
  if (b.lastSession)
    lines.push(
      `Last session ${b.lastSession.endedAt ?? "(not ended)"}: ${clip(b.lastSession.summary || "(no summary)", l.bodyChars)}`,
    );
  lines.push(
    `\n## Inbox (${b.inbox.unreadCount} unread, ${b.inbox.unreadCount - Math.min(b.inbox.unreadCount, l.msgs)} not shown; ${b.inbox.unacknowledgedSent} of my messages still unacknowledged)`,
  );
  for (const m of b.inbox.unread.slice(0, l.msgs))
    lines.push(
      `- [${m.type}${m.requiresAck ? ", ack" : ""}] ${m.from}: ${clip(m.body, l.bodyChars)} (${m.id})`,
    );
  lines.push(`\n## Open human requests (${b.humanRequests.openCount})`);
  for (const r of b.humanRequests.open.slice(0, l.reqs))
    lines.push(
      `- ${r.blocking ? "BLOCKING " : ""}${r.kind}: ${clip(r.why, l.bodyChars)}${r.options.length ? ` [${r.options.join("/")}]` : ""} (${r.id})`,
    );
  lines.push(`\n## Open critic findings (${b.findings.openCount})`);
  for (const f of b.findings.open.slice(0, l.findings))
    lines.push(
      `- ${f.severity} on ${f.taskId ?? "session"}: ${clip(f.description, l.bodyChars)} → ${clip(f.requiredAction, l.bodyChars)}`,
    );
  lines.push(
    `\n## Tasks: ${b.tasks.readyCount} ready, ${b.tasks.claimedByMe.length} claimed by me, ${b.tasks.claimedByOthers.length} claimed by peers`,
  );
  for (const t of b.tasks.claimedByMe.slice(0, l.tasks))
    lines.push(
      `- mine: ${t.title} [${t.status}, tier ${t.riskTier}, attempt ${t.attempt}] (${t.id})`,
    );
  for (const t of b.tasks.ready.slice(0, l.tasks))
    lines.push(`- ready: p${t.priority} ${t.title} [tier ${t.riskTier}] (${t.id})`);
  for (const t of b.tasks.claimedByOthers.slice(0, l.tasks))
    lines.push(`- peer ${t.claimedBy}: ${t.title} (${t.id})`);
  lines.push(`\n## Changes since last session (${b.changesSinceLastSession.count})`);
  for (const t of b.changesSinceLastSession.tasks.slice(0, l.changes))
    lines.push(`- ${t.title} → ${t.status}${t.prUrl ? ` ${t.prUrl}` : ""}`);
  if (b.peers.length) {
    lines.push("\n## Peers");
    for (const p of b.peers)
      lines.push(
        `- ${p.agentName}: ${p.activeClaims} active claim(s)${p.lastHandoff ? `; last handoff: ${clip(p.lastHandoff, l.bodyChars)}` : ""}`,
      );
  }
  if (b.queue.count) {
    lines.push(`\n## Next-session queue (${b.queue.count})`);
    for (const q of b.queue.items.slice(0, l.queue))
      lines.push(`- p${q.priority} ${q.kind}: ${clip(q.text, l.bodyChars)}`);
  }
  return lines.join("\n");
}
