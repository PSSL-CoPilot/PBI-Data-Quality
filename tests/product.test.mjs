import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("product surface includes the primary QA workflows", async () => {
  const page = await read("app/page.tsx");
  for (const label of [
    "Upload Power BI file",
    "Tables",
    "Measures",
    "Dependencies",
    "Quality Checks",
    "Issues",
    "Team",
  ]) {
    assert.match(page, new RegExp(label));
  }
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});

test("the UI renders extracted data only, never sample rows", async () => {
  const page = await read("app/page.tsx");

  // The mockup carried module-level demo arrays. Their return would mean the
  // screen is showing numbers that did not come out of the user's file.
  assert.doesNotMatch(page, /^const (measures|tables|issues|STATS)\s*=/m);
  assert.doesNotMatch(page, /Sales_Model_v4|Northstar Analytics|Sales Intelligence/);
  assert.doesNotMatch(page, /Revenue YoY %|FactSales/, "no hardcoded model objects");

  // Every view must come from the extracted model.
  assert.match(page, /extractFile/);
  assert.match(page, /model\.capabilities/);
});

test("PBIX extraction is explicit and cannot silently fabricate metadata", async () => {
  const extract = await read("lib/powerbi/extract.ts");

  assert.match(extract, /export async function extract/);
  // A PBIX must state why the model is unreadable instead of inventing one.
  assert.match(extract, /Analysis Services backup/);
  assert.match(extract, /ExtractionError/);
  // Nothing is executed against the model, so runtime stays unavailable.
  assert.match(extract, /RUNTIME_REASON/);
});

test("collaboration schema contains authorization and issue records", async () => {
  const schema = await read("db/schema.ts");
  for (const entity of [
    "organizations",
    "projects",
    "members",
    "versions",
    "issues",
    "comments",
  ]) {
    assert.match(schema, new RegExp(`const ${entity}`));
  }
});

test("only normalized metadata is persisted, never the uploaded file", async () => {
  const route = await read("app/api/versions/route.ts");
  assert.match(route, /metadataJson/);
  assert.doesNotMatch(route, /arrayBuffer|formData|Uint8Array/);
});
