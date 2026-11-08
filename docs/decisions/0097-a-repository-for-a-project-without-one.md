# 0097 — A project without a repository works in its folder, and its agent can create one

Date: 2026-10-31
Status: accepted (U-037; the owner's addition of 2026-10-31); amended by merged-actions (2026-11-08): Autopilot asks too

## Context

A project may be created without a repository link. Its intake writes the standard docs into
the project's workspace folder (`<data>/projects/<id>/workspace`, ADR 0058), but its tasks ran
with no folder at all: the PR executor (`PrTaskExecutor`) found no repository and ran the
specialist with none, so on an API key every read and write was refused (the run token's paths
were empty), and on a subscription the run worked in an empty folder of its own that nothing
read afterwards. Tasks failed and were retried (U-037).

The owner asked for two things: such projects work in their workspace folder, and the agents
can also create a GitHub repository for a project, with the person's say.

## Decision

**The workspace folder.** A task of a project with no repository link runs in the project's
workspace folder, on both drivers: the PR executor's `workspaceFor` names it, the executor runs
the specialist there (`cwd`, the SDK subprocess's working directory, the sandbox lease's mount),
and the session grant carries the folder so the run token keeps it. The folder is kept as a
local git repository: what was there before a run is committed as its baseline, and what the run
changed is staged afterwards, so the critic's diff of the folder (`git diff HEAD`) is exactly
that run's change set, new files included. A project linked to a local folder (a source scan,
spec A.4) is not given the workspace: that folder is the person's own and a run never writes to
it unasked.

**Creating a repository.** One command, `repo.create`, does it from every place: the project
page's **Create a repository** button, Chat ("create a repository", "make a private GitHub repo
for X", "erstelle ein Repository für X"), and the project's agent.

- It uses the person's GitHub token (`secret:github_token`) through the git host; without a
  token it is refused with the next step (add one in the setup assistant).
- The name comes from the project's name (lower case, dashes), under the token's own account
  unless an organization is named; private unless public is asked for.
- The repository is created empty, the workspace folder is pushed as one first commit on the
  default branch (its local history is not; an empty folder gets a README), and the repository
  becomes the project's repository link (`repos[0]`, what "Repository link" in New project
  sets). From then on tasks run on branches of clones with pull requests. If the push fails,
  the repository is left unlinked and the person is told how to finish or delete it.

**Approval.** Creating a repository is outward-facing (action class `external_send`: something
new on a third party, under the person's account), so it goes through the change card:

- private: medium risk, a yes or a tap (the dialog's Yes, the Inbox card, Chat's yes);
- public: high risk, confirmation in the app on a paired device;
- the project's own agent acts without asking only where the autonomy table frees
  `external_send` (level 4, Autopilot), and only for a private repository; then the change log
  and the sentence tell the person.

When a session plans code work (a specialist whose entry edits files and runs commands: coder,
tester, ops-deploy, migration-specialist) on a project without a repository, the agent proposes
one: below Autopilot a durable Inbox card (key `repo:create:<project>`, options "Create the
repository" and "Not now", the card naming the repository, the account or organization and
"private"); at Autopilot the command itself. The answer runs the same command with the
person's answer as the confirmation, through the change log. "Not now" is remembered on the
project (`settings.repo_proposal`), so the agent does not ask again (U-031's lesson); the
button stays. The session goes on in the workspace folder either way. Nothing is created without
a yes below Autopilot, and nothing here deletes a repository: that always needs a person.

## Consequences

- The proposal is a card of its own, not the command executor's pending confirmation, because
  those live ten minutes in the daemon that showed them (U-029) while an agent's proposal may
  wait for days; its answer still runs through the executor.
- A fine-grained token limited to selected repositories may not create one; the refusal says
  which permission is missing.
- The cloud runner builds its own executor without the workspace: a cloud run of a project
  without a repository still has no folder (its workspace is on the PC). Creating a repository
  is the way to give such a project cloud runs.

## Amendment: Autopilot asks too ('merged-actions', 2026-11-08)

The owner's decision of 2026-11-02, "Autopilot asks before creating a repository (no silent
creation)", recorded here as decided. The exception above is gone: a private repository is
medium risk for every actor at every autonomy level (`repo.ts` `riskOf`), so the project's agent,
in a session's plan (`RepoProposals.consider`) or in the chat (whose command tools run as the
agent), files the card and creates nothing until the person's yes; a public one stays high. The
proposal card is one per project at every level, and says what and why in two sentences
(design §5), its title the question: 'Create a repository for "<project>"? Code work is planned
for it, and it has none: its tasks run in the project's folder on this computer.'. The Inbox
words it from its key (`repoOfferCard` in `request-words.ts`): the question with the project's
name read now as its title, the second sentence as its body, and a line under each answer; before
(review of merged-actions), the title was the text's first sentence, cut at the first ": ", ". "
or "? ", so a project named "Birds: a counter" read 'Create a repository for "Birds'. The offer
holds no work, so
the project's status line does not count it as a question (`holdsTask`, C-60). Before, at level 4
the agent created a private repository with no card from either path (the composed tests
`repo-create.test.ts` "at Autopilot (level 4) the agent asks too" and "the chat agent's
repo.create at Autopilot files a card" failed then).

## Amendment: one card per repository ('leftovers7-merge', 2026-11-08)

The agent's offer and a `repo.create` asked in Chat could both be open for one project, and
nothing withdrew the offer once a repository was linked, so its "Create the repository" then
failed with a warning. Now a repository linked by any path withdraws the open offer ("Closed: it
no longer needs you."), an offer answered after a link changes nothing and warns of nothing, and
a `repo.create` from Chat or voice while the offer is open is refused in one sentence that points
to the offer (the project page's own Create goes on and withdraws the offer). The command's card
reads as its question with Yes and No, not as the generic "a GitHub repository for X".

The review found the other order still gave two cards: a `repo.create` card filed first (Chat, or
one the project page's dialog previewed and the person closed) and the agent's offer filed beside
it at the next plan. So, whatever the order: the agent files no offer while a `repo.create` card
for the project waits in the Inbox (that card is the one card), and a repository linked by any
path closes every open card that asks for one, the offer and the `repo.create` cards alike
("Closed: it no longer needs you."), with the confirmation waiting behind such a card dropped, so
no later Yes runs it and none posts a warning.
