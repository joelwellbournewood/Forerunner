import type { ChangeLogRow, StateStore } from "@forerunner/state";
import { changeLogView } from "./views.ts";

/**
 * The Changes page's rows with their project and people in words (W15-36, design §5 rule 3:
 * never another person's or a removed project's id), read once per id: the one function behind
 * `GET /changes` and chat's recall of changes (d1109-chat-recall, ADR 0114), so both name a
 * change's who and where alike. A removed project is the archived row its creation's Undo renamed
 * "<name> (removed)". Undo's availability is the route's own (it asks the command loop).
 */
export async function changeRowViews(
  store: Pick<StateStore, "project" | "human" | "agent">,
  rows: readonly ChangeLogRow[],
  nowIso: string,
) {
  const nameOf = new Map<string, Promise<{ name: string; removed: boolean } | null>>();
  const lookup = (key: string, read: () => Promise<{ name: string; removed: boolean } | null>) => {
    let found = nameOf.get(key);
    if (!found) {
      found = read().catch(() => null);
      nameOf.set(key, found);
    }
    return found;
  };
  const projectOf = (id: string) =>
    lookup(`p:${id}`, async () => {
      const p = await store.project.get(id);
      return p ? { name: p.name, removed: p.status === "archived" } : null;
    });
  const humanOf = (id: string) =>
    lookup(`h:${id}`, async () => {
      const h = await store.human.get(id);
      return h ? { name: h.name, removed: false } : null;
    });
  const agentOf = (id: string) =>
    lookup(`a:${id}`, async () => {
      const a = await store.agent.get(id);
      return a ? { name: a.name, removed: false } : null;
    });
  return Promise.all(
    rows.map(async (row) => {
      const project = row.project_id ? await projectOf(row.project_id) : null;
      return {
        ...changeLogView(row, nowIso),
        projectName: project?.name ?? null,
        projectRemoved: project?.removed === true,
        humanName: row.human_id ? ((await humanOf(row.human_id))?.name ?? null) : null,
        agentName: row.agent_id ? ((await agentOf(row.agent_id))?.name ?? null) : null,
      };
    }),
  );
}
