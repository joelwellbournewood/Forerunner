import { once } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, ForerunnerError, resolve } from "@forerunner/platform";
import type { Command } from "commander";
import {
  AUDIT_EXPORT_FORMATS,
  type AuditExportSource,
  type AuditScopeStore,
  auditExportFilename,
  auditFilterFrom,
  auditScopeFor,
  parseAuditExportQuery,
  writeAuditExport,
} from "../daemon/audit-export.ts";

/**
 * `fr audit export` (spec S.9, ADR 0050): the audit log to a file, through the same module
 * as the daemon's `GET /audit/export`. A one-shot over the store (the runtime is composed
 * without its background services); flags are checked before anything is composed, the
 * rows are the install's human's and their agents', the summaries as stored.
 */
export interface AuditCliRuntime {
  store: AuditScopeStore & { auditLog: AuditExportSource };
  clock: { nowIso(): string };
  human: { id: string };
}

export interface AuditCliDeps {
  open: () => Promise<AuditCliRuntime>;
  out: (line: string) => void;
  /** Where a relative `--out` lands. */
  cwd: () => string;
}

interface ExportFlags {
  agent?: string;
  session?: string;
  from?: string;
  to?: string;
  format?: string;
  out?: string;
  force?: boolean;
}

/** Open for writing; `wx` refuses an existing file unless `--force`, before any row is read. */
async function openForWrite(path: string, force: boolean): Promise<WriteStream> {
  mkdirSync(dirname(path), { recursive: true });
  const file = createWriteStream(path, { flags: force ? "w" : "wx", encoding: "utf8" });
  try {
    await once(file, "open");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ForerunnerError("validation", `${path} exists; pass --force to overwrite it`, {
        details: { path },
      });
    }
    throw e;
  }
  return file;
}

/** One chunk, settled when the file took it: the writer never runs ahead of the disk. */
function writeChunk(file: WriteStream, chunk: string): Promise<void> {
  return new Promise((res, rej) => {
    file.write(chunk, (e) => (e ? rej(e) : res()));
  });
}

function endFile(file: WriteStream): Promise<void> {
  return new Promise((res, rej) => {
    file.end((e?: Error | null) => (e ? rej(e) : res()));
  });
}

export function registerAuditCli(program: Command, deps: AuditCliDeps): void {
  const audit = program
    .command("audit")
    .description("The append-only audit log of tool calls: who, what, when, cost, result");
  audit
    .command("export")
    .description(
      `Write the audit log to a file as ${AUDIT_EXPORT_FORMATS.join(" or ")}: your rows and your agents', the summaries as stored`,
    )
    .option("--agent <id>", "one of your agents only")
    .option("--session <id>", "one session only")
    .option("--from <iso>", "inclusive lower bound on the time of the call (ISO-8601)")
    .option("--to <iso>", "exclusive upper bound on the time of the call (ISO-8601)")
    .option("--format <format>", "jsonl (JSON lines, the default) or csv")
    .option(
      "--out <path>",
      "file to write; default forerunner-audit-<time>.<format> in the current directory",
    )
    .option("--force", "overwrite the file when it exists", false)
    .action(async (opts: ExportFlags) => {
      const q = parseAuditExportQuery({
        agentId: opts.agent,
        sessionId: opts.session,
        from: opts.from,
        to: opts.to,
        format: opts.format,
      });
      const rt = await deps.open();
      const scope = await auditScopeFor(rt.store, rt.human.id, q.agentId, true);
      const path = resolve(
        deps.cwd(),
        opts.out ?? auditExportFilename(q.format, rt.clock.nowIso()),
      );
      const file = await openForWrite(path, opts.force === true);
      try {
        const { rows } = await writeAuditExport(
          rt.store.auditLog,
          { write: (chunk) => writeChunk(file, chunk) },
          { format: q.format, filter: auditFilterFrom(q), scope },
        );
        await endFile(file);
        deps.out(`${rows} row${rows === 1 ? "" : "s"} written to ${path} (${q.format})`);
      } catch (e) {
        file.destroy();
        throw e;
      }
    });
}
