/**
 * GraphQL documents for GitHub Projects V2 (the REST API has no projects endpoints any more).
 * Every operation is named so a fake endpoint in tests can dispatch on `operationName`.
 * Inputs follow the public schema: createProjectV2, createProjectV2Field,
 * updateProjectV2Field, addProjectV2DraftIssue, updateProjectV2DraftIssue,
 * updateProjectV2ItemFieldValue, clearProjectV2ItemFieldValue, archiveProjectV2Item,
 * unarchiveProjectV2Item.
 */
import type { ProjectFieldKind, ProjectOptionColor } from "./types.ts";

export const GQL_OWNER_PROJECTS = `query MirrorOwnerProjects($login: String!, $query: String!) {
  repositoryOwner(login: $login) {
    id
    ... on ProjectV2Owner {
      projectsV2(first: 50, query: $query) {
        nodes { id number title url closed }
      }
    }
  }
}`;

export const GQL_CREATE_PROJECT = `mutation MirrorCreateProject($ownerId: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title }) {
    projectV2 { id number title url closed }
  }
}`;

export const GQL_FIELDS = `query MirrorFields($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
    }
  }
}`;

export const GQL_CREATE_FIELD = `mutation MirrorCreateField($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2FieldCommon { id name dataType } }
  }
}`;

export const GQL_UPDATE_FIELD_OPTIONS = `mutation MirrorUpdateFieldOptions($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2FieldCommon { id name dataType } }
  }
}`;

export const GQL_ITEMS = `query MirrorItems($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          content {
            __typename
            ... on DraftIssue { id title body }
            ... on Issue { id title body }
            ... on PullRequest { id title body }
          }
          fieldValues(first: 50) {
            nodes {
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
            }
          }
        }
      }
    }
  }
}`;

export const GQL_ADD_DRAFT = `mutation MirrorAddDraft($projectId: ID!, $title: String!, $body: String) {
  addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
    projectItem { id content { ... on DraftIssue { id } } }
  }
}`;

export const GQL_UPDATE_DRAFT = `mutation MirrorUpdateDraft($draftIssueId: ID!, $title: String!, $body: String) {
  updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title, body: $body }) {
    draftIssue { id }
  }
}`;

export const GQL_ARCHIVE_ITEM = `mutation MirrorArchiveItem($projectId: ID!, $itemId: ID!) {
  archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
}`;

export const GQL_UNARCHIVE_ITEM = `mutation MirrorUnarchiveItem($projectId: ID!, $itemId: ID!) {
  unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
}`;

/** One field write inside a batched MirrorSetFields mutation. */
export interface FieldWrite {
  fieldId: string;
  /** Text or single-select option id; null clears the value. */
  value: { text: string } | { singleSelectOptionId: string } | null;
}

/**
 * Build one mutation that writes every field of an item (aliases f0..fN). GitHub executes the
 * aliased mutations in order inside one request, which keeps the mirror inside the rate
 * limit: one call per item instead of one per field.
 */
export function buildSetFieldsMutation(writes: FieldWrite[]): {
  query: string;
  variables: Record<string, unknown>;
} {
  const vars: string[] = ["$projectId: ID!", "$itemId: ID!"];
  const ops: string[] = [];
  const variables: Record<string, unknown> = {};
  writes.forEach((w, i) => {
    vars.push(`$f${i}: ID!`);
    variables[`f${i}`] = w.fieldId;
    if (w.value === null) {
      ops.push(
        `f${i}: clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $f${i} }) { projectV2Item { id } }`,
      );
    } else {
      vars.push(`$v${i}: ProjectV2FieldValue!`);
      variables[`v${i}`] = w.value;
      ops.push(
        `f${i}: updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $f${i}, value: $v${i} }) { projectV2Item { id } }`,
      );
    }
  });
  return {
    query: `mutation MirrorSetFields(${vars.join(", ")}) {\n  ${ops.join("\n  ")}\n}`,
    variables,
  };
}

/** GraphQL `dataType` -> contract kind. */
export function fieldKindOf(dataType: unknown): ProjectFieldKind {
  switch (String(dataType)) {
    case "TEXT":
    case "TITLE":
      return "text";
    case "SINGLE_SELECT":
      return "single_select";
    case "NUMBER":
      return "number";
    case "DATE":
      return "date";
    case "ITERATION":
      return "iteration";
    default:
      return "other";
  }
}

export const DEFAULT_OPTION_COLOR: ProjectOptionColor = "GRAY";

/** Where the GraphQL endpoint lives for a REST base URL (api.github.com or GHES `/api/v3`). */
export function graphqlUrlFor(restBaseUrl: string): string {
  const base = restBaseUrl.replace(/\/$/, "");
  if (/\/api\/v3$/.test(base)) return `${base.slice(0, -"/v3".length)}/graphql`;
  return `${base}/graphql`;
}
