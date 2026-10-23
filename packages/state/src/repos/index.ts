import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { AuditLogRepo } from "./audit-log.ts";
import { ChangeLogRepo } from "./change-log.ts";
import { CostLedgerRepo } from "./cost-ledger.ts";
import { DecisionRepo } from "./decision.ts";
import { DeviceRepo } from "./device.ts";
import { EventRepo } from "./event.ts";
import { HumanRequestRepo } from "./human-request.ts";
import { LessonRepo } from "./lesson.ts";
import { MessageRepo } from "./message.ts";
import {
  BillingSourceRepo,
  BudgetWindowRepo,
  CommandRepo,
  DataAssetRepo,
  ExtensionRepo,
  ReleaseRepo,
  SecretRefRepo,
  SourceCandidateRepo,
  SourceRepo,
} from "./misc.ts";
import { AgentRepo, HumanRepo } from "./people.ts";
import { MilestoneRepo, ProjectRepo } from "./project.ts";
import { QueueRepo, RemoteCommandRepo } from "./remote.ts";
import { FindingRepo, ReviewRepo } from "./review.ts";
import { RunRepo, SessionRepo } from "./session.ts";
import { TaskRepo } from "./task.ts";

export * from "./audit-log.ts";
export * from "./base.ts";
export * from "./change-log.ts";
export * from "./codec.ts";
export * from "./cost-ledger.ts";
export * from "./decision.ts";
export * from "./device.ts";
export * from "./event.ts";
export * from "./human-request.ts";
export * from "./lesson.ts";
export * from "./message.ts";
export * from "./misc.ts";
export * from "./people.ts";
export * from "./project.ts";
export * from "./remote.ts";
export * from "./review.ts";
export * from "./session.ts";
export * from "./task.ts";

/** Every repository, bound to one Database handle and one Clock. */
export interface Repos {
  human: HumanRepo;
  agent: AgentRepo;
  project: ProjectRepo;
  milestone: MilestoneRepo;
  task: TaskRepo;
  run: RunRepo;
  session: SessionRepo;
  event: EventRepo;
  message: MessageRepo;
  decision: DecisionRepo;
  humanRequest: HumanRequestRepo;
  review: ReviewRepo;
  finding: FindingRepo;
  lesson: LessonRepo;
  command: CommandRepo;
  changeLog: ChangeLogRepo;
  device: DeviceRepo;
  source: SourceRepo;
  sourceCandidate: SourceCandidateRepo;
  costLedger: CostLedgerRepo;
  secretRef: SecretRefRepo;
  extension: ExtensionRepo;
  dataAsset: DataAssetRepo;
  release: ReleaseRepo;
  auditLog: AuditLogRepo;
  queue: QueueRepo;
  remoteCommand: RemoteCommandRepo;
  billingSource: BillingSourceRepo;
  budgetWindow: BudgetWindowRepo;
}

export function createRepos(db: Database, clock: Clock): Repos {
  const finding = new FindingRepo(db, clock);
  return {
    human: new HumanRepo(db, clock),
    agent: new AgentRepo(db, clock),
    project: new ProjectRepo(db, clock),
    milestone: new MilestoneRepo(db, clock),
    task: new TaskRepo(db, clock, finding),
    run: new RunRepo(db, clock),
    session: new SessionRepo(db, clock),
    event: new EventRepo(db, clock),
    message: new MessageRepo(db, clock),
    decision: new DecisionRepo(db, clock),
    humanRequest: new HumanRequestRepo(db, clock),
    review: new ReviewRepo(db, clock),
    finding,
    lesson: new LessonRepo(db, clock),
    command: new CommandRepo(db, clock),
    changeLog: new ChangeLogRepo(db, clock),
    device: new DeviceRepo(db, clock),
    source: new SourceRepo(db, clock),
    sourceCandidate: new SourceCandidateRepo(db, clock),
    costLedger: new CostLedgerRepo(db, clock),
    secretRef: new SecretRefRepo(db, clock),
    extension: new ExtensionRepo(db, clock),
    dataAsset: new DataAssetRepo(db, clock),
    release: new ReleaseRepo(db, clock),
    auditLog: new AuditLogRepo(db, clock),
    queue: new QueueRepo(db, clock),
    remoteCommand: new RemoteCommandRepo(db, clock),
    billingSource: new BillingSourceRepo(db, clock),
    budgetWindow: new BudgetWindowRepo(db, clock),
  };
}
