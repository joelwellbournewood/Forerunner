import { ForerunnerError } from "@forerunner/platform";
import {
  ONLY_YOU_TAKE_OVER,
  TOOK_OVER_KEY,
  takeOverAsk,
  takeOverUndoneSentence,
  tookOverNoPullRequestSentence,
  tookOverSentence,
} from "@forerunner/runtime/sources/repository-words";
import { ANSWER_CARD_KEYS } from "@forerunner/runtime/wiring/request-answers";
import type { JsonValue } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type {
  CommandContext,
  CommandDef,
  CommandOutcome,
  RepoPreview,
  RepoTakeOverFacts,
  Risk,
} from "../types.ts";
import { asObject, authorOf, patchProjectSettings, resolveProject } from "./shared.ts";

/**
 * repo.create (U-037, ADR 0097): a GitHub repository for a project that has none, created with
 * the person's GitHub token through the git host, private unless asked otherwise, named after
 * the project; the project's workspace is pushed as the first commit and the repository becomes
 * the project's repository link, so later runs use the branch-and-pull-request path.
 *
 * Creating a repository is outward-facing (an `external_send`: something new on a third party,
 * under the person's account), so it goes through the change card. A private repository is
 * medium risk for every actor at every autonomy level: the person confirms the card in the app
 * or the Inbox. A public one is high risk: confirmation in the app on a paired device. No level
 * lets an agent create one alone (the owner's decision of 2026-11-02, "Autopilot asks before
 * creating a repository"): before, the project's agent at Autopilot (level 4) rated a private
 * repository low and created it with no card, from a session's plan or from the chat. Nothing
 * here can delete a repository; that always needs a person.
 */
const params = z.object({
  /** Project id or name; the active project when left out. */
  project: z.string().optional(),
  /** Repository name; from the project's name when left out. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, "letters, digits, '.', '_' and '-' only, up to 100")
    .optional(),
  /** An organization to create it under; the token's own account when left out. */
  owner: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "a GitHub account or organization name")
    .optional(),
  private: z.boolean().default(true),
});
export type RepoCreateParams = z.infer<typeof params>;

function ports(ctx: CommandContext) {
  const repos = ctx.ports.repos;
  if (!repos) {
    throw new ForerunnerError(
      "unavailable",
      "creating a repository needs the git host; this install has none wired",
    );
  }
  return repos;
}

/**
 * R-repooffer (leftovers7-merge): a repository asked for in Chat (or by voice) while the agent's
 * offer for the same project is open in the Inbox files no second card: the answer points to
 * the offer. The project page's own Create goes on (the offer is then withdrawn once the
 * repository is linked, `RepoCreator`).
 */
async function assertNoOpenOffer(
  ctx: CommandContext,
  project: { id: string; name: string },
): Promise<void> {
  if (ctx.source === "ui") return;
  // The repository offer's card key, as its producer files it (TM-10).
  const key = `${ANSWER_CARD_KEYS.repoCreatePrefix}${project.id}`;
  const open = await ctx.store.humanRequest
    .list({ status: "open", project_id: project.id } as never, { limit: 200 })
    .catch(() => []);
  if (open.some((r) => (r.change_card as { key?: unknown } | null)?.key === key))
    throw new ForerunnerError(
      "validation",
      `A card in your Inbox already asks to create a repository for "${project.name}": answer it there.`,
      { details: { projectId: project.id, reason: "offer_open" } },
    );
}

function where(p: RepoPreview): string {
  return p.accountKind === "organization"
    ? `the organization ${p.owner}`
    : `your GitHub account ${p.owner}`;
}

function sentenceOf(p: RepoPreview, files?: number): string {
  const what = `the ${p.private ? "private" : "public"} GitHub repository ${p.fullName} under ${where(p)}`;
  return files === undefined
    ? `Create ${what} for ${p.projectName}, push its workspace as the first commit and link it to the project.`
    : `Created ${what} for ${p.projectName}, pushed its workspace (${files} file${files === 1 ? "" : "s"}) as the first commit and linked it to the project.`;
}

/** Who confirms: the person, always (medium); on a paired device for a public one (high). */
function riskOf(p: RepoCreateParams): Risk {
  return p.private ? "medium" : "high";
}

export const repoCreate: CommandDef<RepoCreateParams> = {
  name: "repo.create",
  description:
    "Create a GitHub repository for a project that has none (private by default), push its workspace as the first commit and link it to the project.",
  params,
  risk: (p) => riskOf(p),
  maxRisk: "high",
  scope: "project",
  reversible: false,
  undoStrategy:
    "none: delete the repository on GitHub yourself (deleting a repository always needs a person)",
  actionClass: "external_send",
  async plan(p, ctx) {
    const { project, usedActive } = await resolveProject(ctx, p.project);
    await assertNoOpenOffer(ctx, project);
    const preview = await ports(ctx).preview({
      projectId: project.id,
      private: p.private,
      ...(p.name ? { name: p.name } : {}),
      ...(p.owner ? { owner: p.owner } : {}),
    });
    const risk = riskOf(p);
    return buildCard({
      command: "repo.create",
      what: `a GitHub repository for ${project.name}`,
      oldValue: "no repository",
      newValue: `${preview.fullName} (${preview.private ? "private" : "public"}, under ${where(preview)})`,
      scope: "project",
      risk,
      sentence: sentenceOf(preview),
      reversible: false,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
      // R-repooffer: the card a Chat answer waits on reads as its question, with Yes and No
      // that say what they do (before: the generic "a GitHub repository for X", "yes"/"no").
      // Polish owns the wording.
      ask: `Create the ${preview.private ? "private" : "public"} GitHub repository ${preview.fullName} for "${project.name.replace(/\s+/g, " ").trim()}"? Its tasks then run on branches with pull requests.`,
    });
  },
  async run(p, ctx) {
    const { project } = await resolveProject(ctx, p.project);
    const repos = ports(ctx);
    const preview = await repos.preview({
      projectId: project.id,
      private: p.private,
      ...(p.name ? { name: p.name } : {}),
      ...(p.owner ? { owner: p.owner } : {}),
    });
    const created = await repos.create({
      projectId: project.id,
      name: preview.name,
      ...(preview.accountKind === "organization" ? { owner: preview.owner } : {}),
      private: preview.private,
      humanId: ctx.humanId,
      agentId: ctx.actor.kind === "agent" ? ctx.actor.id : ctx.agentId,
    });
    return {
      before: { repos: project.repos },
      after: { repo: created.fullName, url: created.htmlUrl, files: created.files },
      sentence: sentenceOf({ ...preview, fullName: created.fullName }, created.files),
      projectId: project.id,
      reversible: false,
    };
  },
};

/**
 * repo.take_over (d1109-onerepo-link, ADR 0117, OR-07): the repository of this project names a
 * Forerunner project that is not on this computer (its marker, `.forerunner/project.json`);
 * nobody else worked on it for 14 days, so the person takes it over. The take-over is recorded
 * on the project (`settings.took_over`: the ids, the marker's name, when) and this project's
 * docs pull request replaces exactly that marker with its own, saying so in one line; nothing of
 * the other project's on GitHub is pushed to, commented on or closed.
 *
 * It replaces another project's file through a pull request, so it is medium risk for every
 * actor: the person confirms (the Overview's press is the yes; chat reads it back with Yes and
 * No). No agent takes a repository over by itself: an agent outside the person's chat is
 * refused. The facts are read from GitHub at the press, never from the model's words. Undo
 * puts the project back as it was until its docs pull request exists: refused while that pull
 * request is open (close it there first) and once it merged (the repository names this project).
 */
const takeOverParams = z.object({
  /** Project id or name; the active project when left out. */
  project: z.string().optional(),
});
export type RepoTakeOverParams = z.infer<typeof takeOverParams>;

function takeOverPort(ctx: CommandContext) {
  const port = ctx.ports.repositoryTakeOver;
  if (!port) {
    throw new ForerunnerError(
      "unavailable",
      "taking over a repository needs the git host; this install has none wired",
    );
  }
  return port;
}

/** An agent acting on its own (not on the person's words in chat or voice) never takes over. */
function assertThePerson(ctx: CommandContext): void {
  if (ctx.actor.kind === "agent" && ctx.source !== "chat" && ctx.source !== "voice")
    throw new ForerunnerError("autonomy_insufficient", ONLY_YOU_TAKE_OVER, {
      details: { reason: "agent_actor" },
    });
}

function untrustedOf(facts: RepoTakeOverFacts): CommandOutcome["untrusted"] | undefined {
  return facts.name ? { source: "repo_file", origin: `repository:${facts.locator}` } : undefined;
}

function factsOf(v: JsonValue | undefined): RepoTakeOverFacts | null {
  const o = asObject(v ?? null);
  if (typeof o.locator !== "string" || !Array.isArray(o.projects)) return null;
  return {
    locator: o.locator,
    projects: o.projects.filter((x): x is string => typeof x === "string"),
    name: typeof o.name === "string" ? o.name : null,
  };
}

export const repoTakeOver: CommandDef<RepoTakeOverParams> = {
  name: "repo.take_over",
  description:
    "Take over the project's GitHub repository from a Forerunner project that is not on this computer, when nobody worked on it for 14 days: the repository then names this project through its docs pull request. Only for the repository the Overview says is also another Forerunner project, and only when the person asks.",
  params: takeOverParams,
  risk: "medium",
  maxRisk: "medium",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy:
    "remove the take-over from the project while its docs pull request does not exist (closed on GitHub, or never opened)",
  actionClass: "external_send",
  async plan(p, ctx) {
    assertThePerson(ctx);
    const { project, usedActive } = await resolveProject(ctx, p.project);
    const facts = await takeOverPort(ctx).check(project.id);
    const e = { ids: facts.projects, name: facts.name };
    const untrusted = untrustedOf(facts);
    return buildCard({
      command: "repo.take_over",
      what: `the repository ${facts.locator}`,
      oldValue: facts.name ? `"${facts.name}"` : "another Forerunner project",
      newValue: `"${project.name.replace(/\s+/g, " ").trim()}"`,
      scope: "project",
      risk: "medium",
      sentence: takeOverAsk(facts.locator, e),
      reversible: true,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
      ask: takeOverAsk(facts.locator, e),
      ...(untrusted ? { untrusted } : {}),
    });
  },
  async run(p, ctx) {
    assertThePerson(ctx);
    const { project } = await resolveProject(ctx, p.project);
    const port = takeOverPort(ctx);
    // Read again at the run: a card answered later still meets the 14-day rule.
    const facts = await port.check(project.id);
    const before = asObject(project.settings)[TOOK_OVER_KEY] ?? null;
    const at = ctx.clock.nowIso();
    const tookOver: JsonValue = { projects: facts.projects, name: facts.name ?? "", at };
    await patchProjectSettings(ctx.store, project.id, { [TOOK_OVER_KEY]: tookOver }, authorOf(ctx));
    const written = await port.writeMarker(project.id);
    const untrusted = untrustedOf(facts);
    const from = { ids: facts.projects, name: facts.name };
    return {
      before: { took_over: before },
      after: {
        took_over: tookOver,
        repository: { locator: facts.locator, projects: facts.projects, name: facts.name },
        pr_url: written.prUrl,
        ...(written.failed ? { pr_failed: true } : {}),
      },
      // C2-left-11: says what it could not do when its docs pull request was not opened.
      sentence: written.failed
        ? tookOverNoPullRequestSentence(facts.locator, from)
        : tookOverSentence(facts.locator, from),
      projectId: project.id,
      ...(untrusted ? { untrusted } : {}),
    };
  },
  async undoBlocked(p, _before, after, ctx) {
    const { project } = await resolveProject(ctx, p.project);
    const a = asObject(after);
    const took = asObject(a.took_over ?? null);
    const since = typeof took.at === "string" ? took.at : "";
    const prUrl = typeof a.pr_url === "string" ? a.pr_url : null;
    return takeOverPort(ctx).undoBlocked(project.id, since, prUrl);
  },
  async undo(p, before, _after, ctx) {
    const { project } = await resolveProject(ctx, p.project);
    const was = asObject(before).took_over ?? null;
    await patchProjectSettings(ctx.store, project.id, { [TOOK_OVER_KEY]: was }, authorOf(ctx));
  },
  undoSentence(_p, _before, after) {
    const facts = factsOf(asObject(after).repository);
    return facts
      ? takeOverUndoneSentence(facts.locator, { ids: facts.projects, name: facts.name })
      : "The repository is no longer taken over.";
  },
};
