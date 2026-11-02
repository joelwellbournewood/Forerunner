import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fromPosix, join } from "@forerunner/platform";
import type { HumanRequestRow, ProjectRow, StateStore } from "@forerunner/state";
import { ANSWER_CARD_KEYS, intakeAnswer } from "../wiring/request-answers.ts";
import { plainRows } from "../wiring/state-ports.ts";
import type { DecisionView } from "./api-types.ts";
import { shownHumanName } from "./human-name.ts";

/**
 * The project's decisions as the Overview lists them (design §3.4, §5 "Decision"): plain
 * question and answer pairs with who answered and when, the plan the person approved, and the
 * decision records in the project's folder. Before, the list showed the card's instructions as
 * the question, the form's JSON as the answer, the options not chosen and the person's id;
 * an approved plan and its decision record were missing ("No decisions yet").
 */
export async function decisionViews(
  store: StateStore,
  project: ProjectRow,
  docsDirs: readonly string[],
): Promise<DecisionView[]> {
  const names = new Map<string, string>();
  const nameOf = async (humanId: string | null): Promise<string> => {
    if (!humanId) return "you";
    if (!names.has(humanId))
      names.set(humanId, shownHumanName((await store.human.get(humanId))?.name) || "you");
    return names.get(humanId) as string;
  };
  const out: DecisionView[] = [];
  for (const d of await store.decision.current(project.id)) {
    const who = await nameOf(d.decided_by);
    for (const [i, pair] of plainRows(d).entries())
      out.push({
        id: i === 0 ? d.id : `${d.id}:${i}`,
        projectId: d.project_id,
        kind: "answer",
        question: pair.question,
        options: [],
        chosen: pair.chosen,
        decidedBy: d.decided_by,
        decidedByName: who,
        rationale: d.rationale,
        supersedes: d.supersedes ?? null,
        path: null,
        createdAt: d.created_at,
      });
  }
  // The plan the person approved (or turned down) is a decision too.
  const plans = (
    (await store.humanRequest.list(
      { project_id: project.id, kind: "approval", status: "answered" } as never,
      { limit: 200 },
    )) as HumanRequestRow[]
  ).filter((r) => {
    const key = (r.change_card as Record<string, unknown> | null)?.key;
    return typeof key === "string" && key.startsWith(ANSWER_CARD_KEYS.intakePrefix);
  });
  for (const r of plans) {
    const read = intakeAnswer(r.answer);
    if (!read) continue;
    out.push({
      id: r.id,
      projectId: project.id,
      kind: "plan",
      question: `The plan for ${project.name}`,
      options: [],
      chosen:
        read === "approve"
          ? "Approved."
          : read === "reject"
            ? "Rejected; nothing was written."
            : "You asked for changes.",
      decidedBy: r.answered_by ?? r.human_id ?? "",
      decidedByName: await nameOf(r.answered_by ?? r.human_id ?? null),
      rationale: "",
      supersedes: null,
      path: null,
      createdAt: r.answered_at ?? r.updated_at,
    });
  }
  // The decision records written to the project's folder (docs/decisions/*.md).
  for (const record of decisionRecords(docsDirs))
    out.push({
      id: `record:${record.path}`,
      projectId: project.id,
      kind: "record",
      question: record.title,
      options: [],
      chosen: record.path,
      decidedBy: "",
      decidedByName: null,
      rationale: "",
      supersedes: null,
      path: record.path,
      createdAt: record.updatedAt,
    });
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The decision records in the first docs root that has docs/decisions (newest name first). */
function decisionRecords(
  roots: readonly string[],
): { path: string; title: string; updatedAt: string }[] {
  for (const root of roots) {
    const dir = join(root, fromPosix("docs/decisions"));
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
        .sort()
        .reverse();
    } catch {
      continue;
    }
    return names.slice(0, 20).map((n) => {
      const file = join(dir, n);
      let title = n.replace(/\.md$/, "").replace(/^\d+-/, "").replace(/-/g, " ");
      let updatedAt = new Date(0).toISOString();
      try {
        const head = readFileSync(file, "utf8").slice(0, 2000);
        const h = /^#\s+(.+)$/m.exec(head);
        if (h?.[1]) title = h[1].replace(/^\d+\s*[-:.]?\s*/, "").trim();
        updatedAt = new Date(statSync(file).mtimeMs).toISOString();
      } catch {
        // an unreadable record keeps its file name as its title
      }
      return { path: `docs/decisions/${n}`, title, updatedAt };
    });
  }
  return [];
}
