import { SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";
import { buildSetFieldsMutation, graphqlUrlFor } from "../src/githost/github-graphql.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import {
  FORERUNNER_TASK_ID_FIELD,
  type GitHost,
  type ProjectFieldSpec,
  type ProjectItemInfo,
} from "../src/githost/types.ts";
import { FakeProjectsGraphql } from "./helpers/fake-projects-graphql.ts";

const FIELDS: ProjectFieldSpec[] = [
  {
    name: "Status",
    kind: "single_select",
    options: [
      { name: "Draft", color: "GRAY" },
      { name: "Ready", color: "BLUE" },
      { name: "Done", color: "GREEN", description: "closed" },
    ],
  },
  { name: "specialist", kind: "text" },
  { name: "cost", kind: "text" },
  { name: FORERUNNER_TASK_ID_FIELD, kind: "text" },
];

function normalize(items: ProjectItemInfo[]) {
  return items
    .map((i) => ({
      taskId: i.forerunnerTaskId,
      title: i.title,
      body: i.body,
      archived: i.archived,
      kind: i.kind,
      fields: Object.fromEntries(
        Object.entries(i.fields)
          .filter(([k]) => k !== "Title")
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    }))
    .sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
}

/** The same script every host must agree on (memory host parity). */
async function script(host: GitHost): Promise<ProjectItemInfo[]> {
  const p = await host.ensureProject("acme", "Board");
  await host.ensureFields(p.id, FIELDS);
  const a = await host.upsertItem(p.id, {
    forerunnerTaskId: "t1",
    title: "First",
    body: "b1",
    fields: { Status: "Ready", specialist: "coder", cost: "CHF 1.00" },
  });
  await host.upsertItem(p.id, {
    forerunnerTaskId: "t2",
    title: "Second",
    body: "b2",
    fields: { Status: "Draft", specialist: null, cost: "CHF 0.00" },
  });
  // Update, archive, then the same upsert again (must unarchive and update).
  await host.upsertItem(p.id, {
    forerunnerTaskId: "t1",
    title: "First (renamed)",
    body: "b1'",
    fields: { Status: "Done", cost: "CHF 2.50" },
  });
  await host.archiveItem(p.id, a.item.id);
  await host.upsertItem(p.id, {
    forerunnerTaskId: "t1",
    title: "First (renamed)",
    body: "b1'",
    fields: { Status: "Ready" },
  });
  return host.listProjectItems(p.id);
}

describe("GitHubHost projects (GraphQL)", () => {
  let fake: FakeProjectsGraphql;
  beforeAll(async () => {
    fake = new FakeProjectsGraphql({ owners: ["acme"] });
    await fake.start();
  });
  afterAll(() => fake.stop());

  const host = () => new GitHubHost({ token: "tok", baseUrl: fake.url });

  it("derives the GraphQL endpoint from the REST base", () => {
    expect(graphqlUrlFor("https://api.github.com")).toBe("https://api.github.com/graphql");
    expect(graphqlUrlFor("https://ghe.example.test/api/v3/")).toBe(
      "https://ghe.example.test/api/graphql",
    );
    expect(graphqlUrlFor("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/graphql");
  });

  it("ensureProject looks the board up by owner and title and creates it once", async () => {
    const gh = host();
    const n = fake.requests.length;
    const p = await gh.ensureProject("acme", "Board A");
    expect(fake.ops().slice(n)).toEqual(["MirrorOwnerProjects", "MirrorCreateProject"]);
    expect(fake.requests[n]?.variables).toEqual({ login: "acme", query: "Board A" });
    expect(fake.requests[n]?.headers.authorization).toBe("Bearer tok");
    expect(fake.requests[n]?.query).toContain("repositoryOwner(login: $login)");
    expect(fake.requests[n + 1]?.variables).toEqual({ ownerId: "O_acme", title: "Board A" });
    expect(fake.requests[n + 1]?.query).toContain(
      "createProjectV2(input: { ownerId: $ownerId, title: $title })",
    );
    expect(p.id).toMatch(/^PVT_/);
    expect(p.url).toContain("/acme/projects/");

    const again = await gh.ensureProject("acme", "Board A");
    expect(again.id).toBe(p.id);
    expect(fake.ops().slice(n + 2)).toEqual(["MirrorOwnerProjects"]);
    await expect(gh.ensureProject("nobody", "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("ensureFields creates missing fields, extends Status options and is a no-op afterwards", async () => {
    const gh = host();
    const p = await gh.ensureProject("acme", "Board B");
    const n = fake.requests.length;
    const fields = await gh.ensureFields(p.id, FIELDS);
    const ops = fake.ops().slice(n);
    expect(ops[0]).toBe("MirrorFields");
    expect(ops.filter((o) => o === "MirrorCreateField")).toHaveLength(3);
    expect(ops.filter((o) => o === "MirrorUpdateFieldOptions")).toHaveLength(1);
    expect(ops.at(-1)).toBe("MirrorFields");
    const update = fake.requests
      .slice(n)
      .find((r) => r.operationName === "MirrorUpdateFieldOptions");
    // Existing options keep their place; the missing ones are appended with colour and description.
    expect(update).toBeDefined();
    const sent = (update?.variables.options ?? []) as { name: string }[];
    expect(sent.map((o) => o.name)).toEqual(["Todo", "In Progress", "Done", "Draft", "Ready"]);
    expect(update?.variables.options).toContainEqual({
      name: "Done",
      color: "GREEN",
      description: "closed",
    });
    const create = fake.requests
      .slice(n)
      .find((r) => r.operationName === "MirrorCreateField" && r.variables.name === "specialist");
    expect(create?.variables).toEqual({
      projectId: p.id,
      name: "specialist",
      dataType: "TEXT",
      options: null,
    });
    const status = fields.find((f) => f.name === "Status");
    expect(status?.kind).toBe("single_select");
    expect(status?.options.map((o) => o.name)).toContain("Draft");
    expect(fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(["specialist", "cost", FORERUNNER_TASK_ID_FIELD]),
    );

    const m = fake.requests.length;
    await gh.ensureFields(p.id, FIELDS);
    expect(fake.ops().slice(m)).toEqual(["MirrorFields"]);
  });

  it("upsertItem is idempotent by forerunner_task_id and batches field writes in one mutation", async () => {
    const gh = host();
    const p = await gh.ensureProject("acme", "Board C");
    await gh.ensureFields(p.id, FIELDS);
    const n = fake.requests.length;
    const first = await gh.upsertItem(p.id, {
      forerunnerTaskId: "task-1",
      title: "Write docs",
      body: "body",
      fields: { Status: "Ready", specialist: "writer", cost: "CHF 0.10" },
    });
    expect(first.created).toBe(true);
    expect(fake.ops().slice(n)).toEqual(["MirrorItems", "MirrorAddDraft", "MirrorSetFields"]);
    const add = fake.requests[n + 1];
    expect(add?.variables).toEqual({ projectId: p.id, title: "Write docs", body: "body" });
    const set = fake.requests[n + 2];
    expect(set?.query).toMatch(/mutation MirrorSetFields\(/);
    expect(set?.query.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(4);
    expect(set?.variables.itemId).toBe(first.item.id);
    const values = Object.entries(set?.variables ?? {})
      .filter(([k]) => k.startsWith("v"))
      .map(([, v]) => v);
    expect(values).toContainEqual({ text: "task-1" });
    expect(values).toContainEqual({ text: "writer" });
    expect(
      values.some(
        (v) => typeof (v as { singleSelectOptionId?: string }).singleSelectOptionId === "string",
      ),
    ).toBe(true);

    // Same content again: nothing goes over the wire.
    const m = fake.requests.length;
    const second = await gh.upsertItem(p.id, {
      forerunnerTaskId: "task-1",
      title: "Write docs",
      body: "body",
      fields: { Status: "Ready", specialist: "writer", cost: "CHF 0.10" },
    });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(fake.requests.length).toBe(m);

    // One field and the title changed: one draft update and one single-field mutation.
    await gh.upsertItem(p.id, {
      forerunnerTaskId: "task-1",
      title: "Write the docs",
      body: "body",
      fields: { Status: "Done", specialist: "writer", cost: "CHF 0.10" },
    });
    expect(fake.ops().slice(m)).toEqual(["MirrorUpdateDraft", "MirrorSetFields"]);
    expect(fake.requests.at(-1)?.query.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(1);
    // Clearing a value is a clear mutation, not an empty string.
    await gh.setItemFields(p.id, first.item.id, { specialist: null });
    expect(fake.requests.at(-1)?.query).toContain("clearProjectV2ItemFieldValue");

    // A fresh adapter (new process) finds the same item by listing instead of creating a twin.
    const other = host();
    const k = fake.requests.length;
    const found = await other.upsertItem(p.id, {
      forerunnerTaskId: "task-1",
      title: "Write the docs",
      body: "body",
      fields: { Status: "Done" },
    });
    expect(found.created).toBe(false);
    expect(found.item.id).toBe(first.item.id);
    expect(fake.ops().slice(k)).toEqual(["MirrorItems"]); // nothing differed: no write, no field load
    expect(fake.projects.get(p.id)?.items).toHaveLength(1);
  });

  it("archives and unarchives through the item mutations and pages item listings", async () => {
    const fake2 = new FakeProjectsGraphql({ owners: ["acme"], pageSize: 2 });
    await fake2.start();
    try {
      const gh = new GitHubHost({ token: "tok", baseUrl: fake2.url });
      const p = await gh.ensureProject("acme", "Board D");
      await gh.ensureFields(p.id, FIELDS);
      for (const id of ["a", "b", "c"])
        await gh.upsertItem(p.id, { forerunnerTaskId: id, title: id, fields: { Status: "Ready" } });
      const item = await gh.findItem(p.id, "b");
      const n = fake2.requests.length;
      await gh.archiveItem(p.id, item?.id ?? "");
      expect(fake2.requests[n]?.operationName).toBe("MirrorArchiveItem");
      expect(fake2.requests[n]?.variables).toEqual({ projectId: p.id, itemId: item?.id });
      expect(fake2.projects.get(p.id)?.items.find((i) => i.id === item?.id)?.isArchived).toBe(true);
      await gh.upsertItem(p.id, { forerunnerTaskId: "b", title: "b", fields: { Status: "Ready" } });
      expect(fake2.ops().slice(n + 1)).toEqual(["MirrorUnarchiveItem"]);

      const fresh = new GitHubHost({ token: "tok", baseUrl: fake2.url });
      const m = fake2.requests.length;
      const items = await fresh.listProjectItems(p.id);
      expect(items.map((i) => i.forerunnerTaskId).sort()).toEqual(["a", "b", "c"]);
      const pages = fake2.requests.slice(m).filter((r) => r.operationName === "MirrorItems");
      expect(pages).toHaveLength(2);
      expect(pages[1]?.variables.after).toBe("c:2");
    } finally {
      await fake2.stop();
    }
  });

  it("waits for Retry-After and RATE_LIMITED answers on the simulated clock, then gives up when too long", async () => {
    const clock = new SimulatedClock("2026-02-01T00:00:00Z");
    const gh = new GitHubHost({ token: "tok", baseUrl: fake.url, clock, maxRateLimitWaitSec: 60 });
    fake.canned.push({
      status: 403,
      headers: { "retry-after": "2" },
      body: { message: "You have exceeded a secondary rate limit" },
    });
    const pending = gh.ensureProject("acme", "Board E");
    while (clock.pendingTimers() === 0) await new Promise((r) => setTimeout(r, 5));
    await clock.advance(2_100);
    expect((await pending).title).toBe("Board E");

    // RATE_LIMITED inside a 200 body, with the primary limit headers.
    fake.canned.push({
      status: 200,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(clock.now() / 1000) + 30),
      },
      body: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
    });
    const pending2 = gh.ensureProject("acme", "Board E");
    while (clock.pendingTimers() === 0) await new Promise((r) => setTimeout(r, 5));
    await clock.advance(31_000);
    expect((await pending2).title).toBe("Board E");

    // Longer than we are willing to wait: a retryable provider_rate_limit error, no sleep.
    fake.canned.push({
      status: 429,
      headers: { "retry-after": "600" },
      body: { message: "slow down" },
    });
    await expect(gh.ensureProject("acme", "Board E")).rejects.toMatchObject({
      code: "provider_rate_limit",
      retryable: true,
      details: { retryAfterMs: 600_000 },
    });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("maps GraphQL and HTTP errors to codes and refuses unknown fields before any request", async () => {
    const gh = host();
    const p = await gh.ensureProject("acme", "Board F");
    await gh.ensureFields(p.id, FIELDS);
    fake.canned.push({
      status: 200,
      body: {
        data: null,
        errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs project scope" }],
      },
    });
    await expect(gh.ensureProject("acme", "Board F")).rejects.toMatchObject({
      code: "tool_not_allowed",
    });
    fake.canned.push({ status: 401, body: { message: "Bad credentials" } });
    await expect(gh.ensureProject("acme", "Board F")).rejects.toMatchObject({
      code: "provider_auth",
    });
    fake.canned.push({ status: 500, body: { message: "boom" } });
    fake.canned.push({ status: 502, body: { message: "boom" } });
    expect((await gh.ensureProject("acme", "Board F")).id).toBe(p.id);
    await expect(gh.findItem("PVT_nope", "x")).rejects.toMatchObject({ code: "not_found" });

    const item = await gh.upsertItem(p.id, { forerunnerTaskId: "z", title: "z" });
    const n = fake.requests.length;
    await expect(gh.setItemFields(p.id, item.item.id, { nope: "x" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(gh.setItemFields(p.id, item.item.id, { Status: "Nope" })).rejects.toMatchObject({
      code: "validation",
    });
    expect(fake.requests.length).toBe(n);
  });

  it("buildSetFieldsMutation aliases every write and clears with the clear mutation", () => {
    const m = buildSetFieldsMutation([
      { fieldId: "F1", value: { text: "a" } },
      { fieldId: "F2", value: null },
      { fieldId: "F3", value: { singleSelectOptionId: "O1" } },
    ]);
    expect(m.query).toContain(
      "$f0: ID!, $v0: ProjectV2FieldValue!, $f1: ID!, $f2: ID!, $v2: ProjectV2FieldValue!",
    );
    expect(m.query).toContain("f1: clearProjectV2ItemFieldValue");
    expect(m.variables).toEqual({
      f0: "F1",
      v0: { text: "a" },
      f1: "F2",
      f2: "F3",
      v2: { singleSelectOptionId: "O1" },
    });
  });

  it("memory host parity: the in-memory host and the GitHub adapter agree on the same script", async () => {
    const memory = await script(new MemoryGitHost());
    const github = await script(host());
    expect(normalize(memory)).toEqual(normalize(github));
    const t1 = normalize(memory).find((i) => i.taskId === "t1");
    expect(t1).toMatchObject({
      title: "First (renamed)",
      body: "b1'",
      archived: false,
      kind: "draft",
      fields: { Status: "Ready", cost: "CHF 2.50", specialist: "coder", forerunner_task_id: "t1" },
    });
  });
});
