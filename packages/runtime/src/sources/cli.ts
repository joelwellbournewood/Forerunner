import type { Command } from "commander";
import type { SourceDiscovery } from "./discovery.ts";
import type { SourceCandidateView, SourceView } from "./types.ts";
import {
  SOURCE_CANDIDATE_STATUSES,
  type SourceCandidateStatus,
  SourceKindSchema,
} from "./types.ts";

/**
 * `fr sources list|add|scan|candidates|accept|remove` (spec A.4): the same `SourceDiscovery`
 * the daemon's `/sources` routes use, as a one-shot over the composed runtime (no background
 * services). A GitHub source names its token by reference (`--credential secret:<name>`,
 * default `secret:github_token`); a value is refused before anything is stored.
 */
export interface SourcesCliRuntime {
  sources: SourceDiscovery;
  human: { id: string };
}

export interface SourcesCliDeps {
  open: () => Promise<SourcesCliRuntime>;
  out: (line: string) => void;
}

export function sourceLine(s: SourceView): string {
  const scan = s.lastScanAt
    ? `scanned ${s.lastScanAt}: ${s.candidates.proposed} proposed, ${s.candidates.accepted} accepted, ${s.candidates.duplicate} duplicate, ${s.candidates.gone} gone, ${s.candidates.installs} with an install`
    : "not scanned yet";
  const cred = s.credentialRef ? ` ${s.credentialRef}` : "";
  const err = s.status === "error" && s.error ? ` (error: ${s.error})` : "";
  return `${s.id}  ${s.kind} ${s.locator}${cred}  ${s.status}${err}  ${scan}`;
}

export function candidateLine(c: SourceCandidateView): string {
  const flags = [
    c.existingInstall ? `existing install (${c.installMarker})` : null,
    c.kind === "folder" && !c.isGit ? "not a git repository" : null,
    c.projectId ? `project ${c.projectId}` : null,
  ].filter((f): f is string => f !== null);
  return `${c.id}  ${c.status.padEnd(9)} ${c.locator}  -> "${c.proposedName}"${flags.length ? `  [${flags.join("; ")}]` : ""}`;
}

export function registerSourcesCli(program: Command, deps: SourcesCliDeps): void {
  const sources = program
    .command("sources")
    .description(
      "Connected sources (GitHub orgs, accounts, repositories, local folders): scan them for projects to propose",
    );

  sources
    .command("list")
    .description("Your connected sources with what the last scan found")
    .option("--json", "machine readable", false)
    .action(async (opts: { json?: boolean }) => {
      const rt = await deps.open();
      const rows = await rt.sources.list({ humanId: rt.human.id });
      if (opts.json) deps.out(JSON.stringify(rows, null, 2));
      else if (rows.length === 0)
        deps.out("No sources connected (fr sources add <kind> <locator>).");
      else for (const s of rows) deps.out(sourceLine(s));
    });

  sources
    .command("add")
    .description(
      `Connect a source: <kind> is ${SourceKindSchema.options.join("|")}; <locator> a login, owner/name or repository URL, or an absolute folder path`,
    )
    .argument("<kind>")
    .argument("<locator>")
    .option("--name <name>", "display name")
    .option(
      "--credential <ref>",
      "secret reference of the GitHub token (secret:<name>, default secret:github_token); never a token value",
    )
    .action(async (kind: string, locator: string, opts: { name?: string; credential?: string }) => {
      const rt = await deps.open();
      const view = await rt.sources.add(
        {
          kind: SourceKindSchema.parse(kind),
          locator,
          ...(opts.name ? { displayName: opts.name } : {}),
          ...(opts.credential ? { credentialRef: opts.credential } : {}),
        },
        { humanId: rt.human.id },
      );
      deps.out(`Connected: ${sourceLine(view)}`);
      deps.out(`Scan it with: fr sources scan ${view.id}`);
    });

  sources
    .command("scan")
    .description(
      "Scan a source: one proposed project per repository or folder; duplicates and existing installs marked",
    )
    .argument("<id>")
    .option("--json", "machine readable", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const rt = await deps.open();
      const result = await rt.sources.scan(id, { humanId: rt.human.id });
      if (opts.json) {
        deps.out(JSON.stringify(result, null, 2));
        return;
      }
      const s = result.summary;
      deps.out(
        `${s.total} found: ${s.proposed} proposed, ${s.accepted} accepted, ${s.duplicate} duplicate, ${s.gone} gone, ${s.installs} with an existing install`,
      );
      for (const c of result.candidates) deps.out(candidateLine(c));
      if (s.proposed > 0)
        deps.out("Accept one with: fr sources accept <candidate id> [--name <project name>]");
    });

  sources
    .command("candidates")
    .description("What the last scan of a source found")
    .argument("<id>")
    .option("--status <status>", `one of ${SOURCE_CANDIDATE_STATUSES.join(", ")}`)
    .option("--json", "machine readable", false)
    .action(async (id: string, opts: { status?: string; json?: boolean }) => {
      const rt = await deps.open();
      const status = opts.status as SourceCandidateStatus | undefined;
      const rows = await rt.sources.candidates(id, { humanId: rt.human.id }, status);
      if (opts.json) deps.out(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) deps.out("No candidates (scan the source first).");
      else for (const c of rows) deps.out(candidateLine(c));
    });

  sources
    .command("accept")
    .description(
      "Create the project a candidate proposes (the same path as the New project dialog, no brief)",
    )
    .argument("<candidateId>")
    .option("--name <name>", "project name (default: the proposed name)")
    .option("--goal <goal>", "one-line goal")
    .action(async (candidateId: string, opts: { name?: string; goal?: string }) => {
      const rt = await deps.open();
      const result = await rt.sources.accept(
        candidateId,
        { ...(opts.name ? { name: opts.name } : {}), ...(opts.goal ? { goal: opts.goal } : {}) },
        { humanId: rt.human.id },
      );
      deps.out(
        `Project created: ${result.project.id} (${result.project.name}) from ${result.candidate.locator}`,
      );
    });

  sources
    .command("remove")
    .description("Disconnect a source and forget its candidates; projects created from it stay")
    .argument("<id>")
    .action(async (id: string) => {
      const rt = await deps.open();
      const result = await rt.sources.remove(id, { humanId: rt.human.id });
      deps.out(
        `Removed source ${result.id} (${result.candidatesRemoved} candidates forgotten; projects kept)`,
      );
    });
}
