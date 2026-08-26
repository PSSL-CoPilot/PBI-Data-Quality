import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("product surface includes the primary QA workflows", async () => {
  const app = await read("src/App.tsx");
  for (const label of [
    "Upload Power BI file",
    "Tables",
    "Measures",
    "Quality",
    "Optimize",
    "Changes",
  ]) {
    assert.match(app, new RegExp(label));
  }
});

test("the UI renders extracted data only, never sample rows", async () => {
  const app = await read("src/App.tsx");

  // The original mockup carried module-level demo arrays. Their return would
  // mean the screen shows numbers that did not come out of the user's file.
  assert.doesNotMatch(app, /^const (measures|tables|issues|STATS)\s*=/m);
  assert.doesNotMatch(app, /Sales_Model_v4|Northstar Analytics|Sales Intelligence/);
  assert.doesNotMatch(app, /Revenue YoY %|FactSales/, "no hardcoded model objects");

  assert.match(app, /extractFile/);
  assert.match(app, /model\.capabilities/);
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

test("the app is static: no server, no backend calls, no bundled secrets", async () => {
  const app = await read("src/App.tsx");
  const history = await read("lib/history.ts");

  // A fetch to an API would reintroduce the server this build deliberately drops.
  assert.doesNotMatch(app, /fetch\(\s*["'`]\/api/);
  assert.doesNotMatch(app, /use client/, "there is no server/client boundary any more");

  // History is local, and must never carry the uploaded file off the machine.
  assert.match(history, /localStorage/);
  assert.doesNotMatch(history, /fetch\(|XMLHttpRequest/);
});

test("version history stores a summary, never the uploaded file", async () => {
  const history = await read("lib/history.ts");
  assert.doesNotMatch(history, /arrayBuffer|Uint8Array|expression/);
  for (const field of ["fileName", "sha256", "overall", "findings"]) {
    assert.match(history, new RegExp(field));
  }
});

test("the Pages base path is derived from the repository, not hardcoded", async () => {
  const config = await read("vite.config.ts");

  // The app is mirrored to repositories whose names differ only in case, and
  // Pages URLs are case-sensitive. A hardcoded prefix silently serves a blank
  // page in every copy but one.
  assert.match(config, /GITHUB_REPOSITORY/);
  assert.match(config, /VITE_BASE/, "a non-Pages host can still override it");
});
