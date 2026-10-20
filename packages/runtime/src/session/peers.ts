/**
 * Peer awareness (spec F): at startup and between tasks an agent reads a short feed of what the
 * other agents on the project are doing (active claims, open pull requests, last handoff, files
 * in flight) and checks its own planned work against it. Overlap on a task or on files triggers
 * a message to the peer before work starts; a task a peer is actively finishing is skipped.
 */
import type { Clock } from "@forerunner/platform";
import type { StateStore, TaskRow } from "@forerunner/state";

export interface PeerClaim {
  taskId: string;
  title: string;
  status: string;
  expiresAt: string | null;
}

export interface PeerPullRequest {
  taskId: string;
  title: string;
  url: string;
}

export interface PeerHandoff {
  at: string;
  summary: string;
  inFlight: string[];
  blocked: string[];
  next: string[];
}

export interface PeerActivity {
  agentId: string;
  agentName: string;
  /** A session of this peer is running or paused right now. */
  online: boolean;
  activeClaims: PeerClaim[];
  openPullRequests: PeerPullRequest[];
  lastHandoff: PeerHandoff | null;
  /** Files the peer has in flight, by task id (from its handoffs and running sessions). */
  inFlightFiles: Record<string, string[]>;
}

export interface PeerFeed {
  generatedAt: string;
  projectId: string | null;
  peers: PeerActivity[];
}

export interface PeerFeedInput {
  store: StateStore;
  clock: Clock;
  agentId: string;
  projectId: string | null | undefined;
  peerIds: string[];
  /** Sessions per peer to scan for in-flight files; default 3. */
  sessionsPerPeer?: number;
}

/** Event type the session runner appends when a task reports the files it changed. */
export const TASK_FILES_EVENT = "task.files";

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function handoffOf(raw: unknown, at: string, summary: string): PeerHandoff | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (!("done" in h) && !("in_flight" in h) && !("next" in h)) return null;
  return {
    at,
    summary,
    inFlight: asStringList(h.in_flight),
    blocked: asStringList(h.blocked),
    next: asStringList(h.next),
  };
}

function filesFromHandoff(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  const m = (raw as Record<string, unknown>).in_flight_files;
  if (!m || typeof m !== "object") return out;
  for (const [taskId, files] of Object.entries(m as Record<string, unknown>)) {
    const list = asStringList(files);
    if (list.length) out[taskId] = list;
  }
  return out;
}

/** Build the feed from the store: claims, open PRs, last handoff and files in flight per peer. */
export async function buildPeerFeed(input: PeerFeedInput): Promise<PeerFeed> {
  const { store, clock, agentId } = input;
  const projectId = input.projectId ?? null;
  const now = clock.nowIso();
  const peers: PeerActivity[] = [];
  const projectTasks: TaskRow[] = projectId
    ? await store.task.list({ project_id: projectId } as never, { limit: 2000 })
    : [];
  for (const pid of input.peerIds) {
    if (pid === agentId) continue;
    const agent = await store.agent.get(pid);
    const activeClaims: PeerClaim[] = projectTasks
      .filter((t) => t.claimed_by === pid && (!t.claim_expires || t.claim_expires > now))
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        expiresAt: t.claim_expires ?? null,
      }));
    const openPullRequests: PeerPullRequest[] = projectTasks
      .filter(
        (t) =>
          t.pr_url &&
          t.status === "in_review" &&
          (t.owner_agent_id === pid || t.author_agent === pid || t.claimed_by === pid),
      )
      .map((t) => ({ taskId: t.id, title: t.title, url: t.pr_url as string }));
    const sessions = await store.session.list(
      (projectId ? { agent_id: pid, project_id: projectId } : { agent_id: pid }) as never,
      { orderBy: "created_at desc", limit: input.sessionsPerPeer ?? 3 },
    );
    const online = sessions.some((s) => s.status === "running" || s.status === "paused");
    const ended = sessions.find((s) => s.ended_at);
    const lastHandoff = ended
      ? handoffOf(ended.handoff, ended.ended_at as string, ended.summary ?? "")
      : null;
    const inFlightFiles: Record<string, string[]> = {};
    for (const s of sessions) {
      for (const [taskId, files] of Object.entries(filesFromHandoff(s.handoff))) {
        inFlightFiles[taskId] = [...new Set([...(inFlightFiles[taskId] ?? []), ...files])];
      }
      if (s.status !== "running" && s.status !== "paused") continue;
      for (const e of await store.event.list(s.id)) {
        if (e.type !== TASK_FILES_EVENT) continue;
        const p = e.payload as { taskId?: unknown; files?: unknown };
        if (typeof p.taskId !== "string") continue;
        const files = asStringList(p.files);
        if (!files.length) continue;
        inFlightFiles[p.taskId] = [...new Set([...(inFlightFiles[p.taskId] ?? []), ...files])];
      }
    }
    peers.push({
      agentId: pid,
      agentName: agent?.name ?? pid,
      online,
      activeClaims,
      openPullRequests,
      lastHandoff,
      inFlightFiles,
    });
  }
  return { generatedAt: now, projectId, peers };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A short markdown section for the planner's brief. Clipped to maxChars. */
export function renderPeerFeed(feed: PeerFeed, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 900;
  if (!feed.peers.length) return "";
  const lines = ["## Peers: what the others are doing"];
  for (const p of feed.peers) {
    const parts: string[] = [];
    parts.push(p.online ? "online" : "offline");
    if (p.activeClaims.length)
      parts.push(
        `claims: ${p.activeClaims.map((c) => `${clip(c.title, 40)} (${c.taskId})`).join(", ")}`,
      );
    if (p.openPullRequests.length)
      parts.push(
        `open PRs: ${p.openPullRequests.map((r) => `${clip(r.title, 40)} ${r.url}`).join(", ")}`,
      );
    const files = Object.values(p.inFlightFiles).flat();
    if (files.length) parts.push(`files in flight: ${files.slice(0, 8).join(", ")}`);
    if (p.lastHandoff)
      parts.push(
        `last handoff ${p.lastHandoff.at}: in flight ${p.lastHandoff.inFlight.length}, blocked ${p.lastHandoff.blocked.length}, next ${p.lastHandoff.next.length}`,
      );
    lines.push(`- ${p.agentName}: ${parts.join("; ")}`);
  }
  return clip(lines.join("\n"), max);
}

const PATH_RE = /(?<![\w@])(?:[\w.-]+\/)+[\w.*-]+(?:\.[A-Za-z0-9]+)?/g;
const FILE_RE =
  /(?<![\w/@])[\w-]+\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|ya?ml|toml|rs|py|go|java|kt|css|scss|html|sql|sh|ps1)\b/g;

/** Path-like tokens in a task's text: explicit file and directory mentions. */
export function extractPathHints(text: string, limit = 20): string[] {
  const out = new Set<string>();
  const plain = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  for (const m of plain.matchAll(PATH_RE)) {
    const v = m[0].replace(/[.,;:)]+$/, "");
    if (v.includes("://") || v.startsWith("http")) continue;
    if (v.length >= 3) out.add(v);
  }
  for (const m of plain.matchAll(FILE_RE)) out.add(m[0]);
  return [...out].slice(0, limit);
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when a and b name the same file or one is a directory containing the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export interface PlannedWork {
  taskId: string;
  title: string;
  files?: string[];
}

export type Overlap =
  | { kind: "task_claimed"; peerId: string; peerName: string; taskId: string }
  | { kind: "task_pr_open"; peerId: string; peerName: string; taskId: string; url: string }
  | { kind: "task_in_flight"; peerId: string; peerName: string; taskId: string }
  | { kind: "files"; peerId: string; peerName: string; taskId: string; files: string[] };

/** Overlaps between planned work and the peers' activity, most serious first. */
export function detectOverlap(work: PlannedWork, feed: PeerFeed): Overlap[] {
  const out: Overlap[] = [];
  for (const p of feed.peers) {
    if (p.activeClaims.some((c) => c.taskId === work.taskId))
      out.push({
        kind: "task_claimed",
        peerId: p.agentId,
        peerName: p.agentName,
        taskId: work.taskId,
      });
    const pr = p.openPullRequests.find((r) => r.taskId === work.taskId);
    if (pr)
      out.push({
        kind: "task_pr_open",
        peerId: p.agentId,
        peerName: p.agentName,
        taskId: work.taskId,
        url: pr.url,
      });
    if (p.online && p.lastHandoff?.inFlight.includes(work.taskId) && !pr)
      out.push({
        kind: "task_in_flight",
        peerId: p.agentId,
        peerName: p.agentName,
        taskId: work.taskId,
      });
    if (work.files?.length) {
      for (const [taskId, files] of Object.entries(p.inFlightFiles)) {
        if (taskId === work.taskId) continue;
        const hits = files.filter((f) => work.files?.some((mine) => pathsOverlap(mine, f)));
        if (hits.length)
          out.push({
            kind: "files",
            peerId: p.agentId,
            peerName: p.agentName,
            taskId,
            files: [...new Set(hits)],
          });
      }
    }
  }
  const rank: Record<Overlap["kind"], number> = {
    task_claimed: 0,
    task_pr_open: 1,
    task_in_flight: 2,
    files: 3,
  };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Whether the planned task should be skipped rather than started. */
export function overlapBlocks(o: Overlap): boolean {
  return o.kind === "task_claimed" || o.kind === "task_pr_open" || o.kind === "task_in_flight";
}

/** The message sent to the peer before work starts. */
export function overlapMessage(work: PlannedWork, o: Overlap): string {
  switch (o.kind) {
    case "task_claimed":
      return `I planned to work on "${work.title}" (${work.taskId}) but you hold the claim; I moved on.`;
    case "task_pr_open":
      return `I planned to work on "${work.title}" (${work.taskId}) but your pull request ${o.url} is open for it; I left it to you.`;
    case "task_in_flight":
      return `I planned to work on "${work.title}" (${work.taskId}) but your last handoff lists it as in flight and you are online; I left it to you.`;
    case "files":
      return `Heads-up: I am starting "${work.title}" (${work.taskId}), which touches ${o.files.join(", ")}; you have those in flight on task ${o.taskId}. I will rebase before my PR; tell me if I should wait.`;
  }
}
