import { ForerunnerError } from "@forerunner/platform";
import { ANSWER_CARD_KEYS } from "@forerunner/runtime/wiring/request-answers";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, RepoPreview, Risk } from "../types.ts";
import { resolveProject } from "./shared.ts";

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
