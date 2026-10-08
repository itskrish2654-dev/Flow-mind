import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { notionHttpFailure } from "../lib/connectors/notion/provider-error";
import { describeNotionResources, notionContainingDatabaseId, notionResourceLabel } from "../lib/connectors/notion/resources";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const databaseId = "a072917b-a877-8364-9113-07ea21165718";
const dataSourceId = "b072917b-a877-8364-9113-07ea21165718";
const pageId = "c072917b-a877-8364-9113-07ea21165718";

test("Notion data-source choices identify the containing database and page, not an unexplained API title", () => {
  const results = [
    { object: "page", id: pageId, properties: { title: { type: "title", title: [{ plain_text: "Team space" }] } } },
    { object: "data_source", id: dataSourceId, title: [{ plain_text: "People" }],
      parent: { type: "database_id", database_id: databaseId } },
  ];
  const databases = new Map([[databaseId.replaceAll("-", ""), { object: "database", id: databaseId,
    title: [{ plain_text: "Test database" }], parent: { type: "page_id", page_id: pageId } }]]);
  const resources = describeNotionResources(results, databases);
  const source = resources.find((resource) => resource.id === dataSourceId)!;
  assert.equal(source.type, "data_source");
  assert.equal(source.containerTitle, "Test database");
  assert.equal(source.parentPageTitle, "Team space");
  assert.equal(source.locationVerified, true);
  assert.equal(source.canCreateItems, true);
  assert.equal(notionResourceLabel(source), "People · data source in Test database · under Team space");
  assert.equal(notionResourceLabel(resources[0]), "Team space · page");
  assert.ok(!notionResourceLabel(source).includes(databaseId));
});

test("unresolved, untitled, mismatched, and trashed Notion sources cannot be offered for new items", () => {
  const source = { object: "data_source", id: dataSourceId, title: [{ plain_text: "People" }],
    parent: { type: "database_id", database_id: databaseId } };
  const missing = describeNotionResources([source], new Map())[0];
  assert.equal(missing.canCreateItems, false);
  assert.match(notionResourceLabel(missing), /location not verified.*not available for new items/);
  const wrongDatabase = describeNotionResources([source], new Map([[databaseId.replaceAll("-", ""),
    { object: "database", id: pageId, title: [{ plain_text: "Another database" }] }]]))[0];
  assert.equal(wrongDatabase.canCreateItems, false);
  const untitled = describeNotionResources([{ ...source, title: [] }], new Map([[databaseId.replaceAll("-", ""),
    { object: "database", id: databaseId, title: [{ plain_text: "Test database" }] }]]))[0];
  assert.equal(untitled.canCreateItems, false);
  assert.deepEqual(describeNotionResources([{ ...source, in_trash: true }], new Map()), []);
});

test("Notion synced data-source parent resolves only its verified containing database", () => {
  assert.equal(notionContainingDatabaseId({ object: "data_source", parent: { type: "data_source_id", data_source_id: pageId, database_id: databaseId } }), databaseId.replaceAll("-", ""));
  assert.equal(notionContainingDatabaseId({ object: "page", parent: { type: "database_id", database_id: databaseId } }), null);
  assert.equal(notionContainingDatabaseId({ object: "data_source", parent: { type: "page_id", page_id: pageId } }), null);
  assert.equal(notionContainingDatabaseId({ object: "data_source", parent: { type: "database_id", database_id: "not-an-id" } }), null);
});

test("Notion HTTP 400 preserves actionable categories without reflecting provider payload or secrets", () => {
  const sensitive = "Bearer secret-token user@example.com 3f32917b-a877-81f9-a8df-cb4c67c879ea";
  const fields = notionHttpFailure(400, { code: "validation_error", message: `body.properties.Name.title should be defined ${sensitive}` });
  assert.equal(fields.code, "NOTION_VALIDATION_ERROR");
  assert.match(fields.message, /property names, types, and required title/);
  assert.ok(!fields.message.includes(sensitive));
  const parent = notionHttpFailure(400, { code: "validation_error", message: `parent.data_source_id is invalid ${sensitive}` });
  assert.match(parent.message, /selected parent or data source/);
  const malformed = notionHttpFailure(400, { code: `secret-${sensitive}`, message: sensitive });
  assert.equal(malformed.code, "PROVIDER_REJECTED");
  assert.ok(!malformed.message.includes(sensitive));
  assert.equal(notionHttpFailure(429, { code: "rate_limited", message: sensitive }).retryable, true);
});

test("Notion discovery and approvals fail closed when a parent location cannot be verified", () => {
  const discovery = read("lib/connectors/notion/actions.ts");
  const api = read("lib/connectors/notion/api.ts");
  const planner = read("lib/ask-action-planner.ts");
  const connections = read("components/connections-list.tsx");
  const workflows = read("components/automation-workspace.tsx");
  assert.match(discovery, /path: `\/databases\/\$\{id\}`/);
  assert.match(discovery, /\.slice\(0, 12\)/);
  assert.match(api, /notionHttpFailure\(response\.status, body/);
  assert.match(planner, /!source\.canCreateItems/);
  assert.match(planner, /inside database/);
  assert.match(connections, /notionResourceLabel\(resource\)/);
  assert.match(workflows, /resource\.canCreateItems/);
  assert.match(workflows, /notionResourceLabel\(resource\)/);
});
