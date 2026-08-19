import assert from "node:assert/strict";
import test from "node:test";

import {
  addChange,
  describeChange,
  newSession,
  previewRename,
  regressions,
  revertAll,
  revertChange,
  undoLast,
  validateReferences,
  workingModel,
} from "../lib/edit/session.ts";
import { applyChange } from "../lib/edit/apply.ts";
import { diffLines, summariseDiff } from "../lib/edit/diff.ts";
import { allMeasures } from "../lib/powerbi/model.ts";

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

const change = (over) => ({ id: "c1", at: 0, ...over });

function makeModel() {
  return {
    source: { fileName: "t.pbit", format: "pbit", sizeBytes: 1, extractedAt: "2026-01-01T00:00:00Z" },
    capabilities: {
      model: available(),
      report: available(),
      powerQuery: available(),
      runtime: unavailable("no engine"),
    },
    tables: [
      {
        name: "FactSales",
        kind: "table",
        isHidden: false,
        description: "Sales facts",
        columns: [
          { name: "Amount", table: "FactSales", dataType: "int64", kind: "data", isHidden: false, isKey: false },
          {
            name: "Band",
            table: "FactSales",
            dataType: "string",
            kind: "calculated",
            expression: "IF ( FactSales[Amount] > 10, \"High\", \"Low\" )",
            isHidden: false,
            isKey: false,
          },
        ],
        measures: [
          { name: "Cross Sales", table: "FactSales", expression: "SUM ( FactSales[Amount] )", isHidden: false },
          { name: "Cross Ratio", table: "FactSales", expression: "DIVIDE ( [Cross Sales], 2 )", isHidden: false },
          { name: "Untouched", table: "FactSales", expression: "COUNTROWS ( FactSales )", isHidden: false },
        ],
        partitions: [
          {
            name: "p",
            table: "FactSales",
            mode: "import",
            sourceType: "m",
            expression: 'let Source = Sql.Database("srv","db") in Source',
          },
        ],
      },
      {
        name: "Customer",
        kind: "table",
        isHidden: false,
        columns: [
          { name: "Id", table: "Customer", dataType: "int64", kind: "data", isHidden: false, isKey: true },
        ],
        measures: [],
        partitions: [],
      },
    ],
    relationships: [
      {
        name: "r1",
        fromTable: "FactSales",
        fromColumn: "Amount",
        toTable: "Customer",
        toColumn: "Id",
        fromCardinality: "many",
        toCardinality: "one",
        crossFilteringBehavior: "oneDirection",
        isActive: true,
      },
    ],
    expressions: [],
    pages: [
      {
        name: "s1",
        displayName: "Executive Overview",
        ordinal: 0,
        isHidden: false,
        width: 1,
        height: 1,
        visuals: [
          {
            id: "v1",
            page: "s1",
            type: "card",
            x: 0, y: 0, width: 1, height: 1,
            refs: [{ table: "FactSales", field: "Cross Sales", kind: "measure" }],
          },
          {
            id: "v2",
            page: "s1",
            type: "table",
            x: 0, y: 0, width: 1, height: 1,
            refs: [{ table: "FactSales", field: "Amount", kind: "column" }],
          },
        ],
      },
      {
        name: "s2",
        displayName: "Detail",
        ordinal: 1,
        isHidden: false,
        width: 1,
        height: 1,
        visuals: [
          {
            id: "v3",
            page: "s2",
            type: "card",
            x: 0, y: 0, width: 1, height: 1,
            refs: [{ table: "FactSales", field: "Cross Sales", kind: "measure" }],
          },
        ],
      },
    ],
    warnings: [],
  };
}

const renameMeasure = (from, to, table = "FactSales") =>
  change({ target: { type: "measure", table, name: from }, field: "name", before: from, after: to });

// ---------------------------------------------------------------- Preview

test("preview reports where an object is used before anything changes", () => {
  const model = makeModel();
  const preview = previewRename(model, { type: "measure", table: "FactSales", name: "Cross Sales" }, "Unique Sales");

  assert.deepEqual(preview.pages.sort(), ["Detail", "Executive Overview"]);
  assert.equal(preview.visuals, 2);
  assert.deepEqual(preview.measures, ["FactSales[Cross Ratio]"]);
  assert.deepEqual(preview.blockers, []);

  // The preview must not have altered the model it inspected.
  assert.ok(allMeasures(model).some((m) => m.name === "Cross Sales"));
});

test("a rename onto an existing name is blocked, not applied", () => {
  const model = makeModel();
  const preview = previewRename(model, { type: "measure", table: "FactSales", name: "Cross Sales" }, "Untouched");
  assert.equal(preview.blockers.length, 1);
  assert.match(preview.blockers[0], /already exists/);

  const result = applyChange(model, renameMeasure("Cross Sales", "Untouched"));
  assert.match(result.error, /already exists/);
});

// ----------------------------------------------------------------- Renames

test("renaming a measure updates its DAX users and every report binding", () => {
  const model = makeModel();
  const result = applyChange(model, renameMeasure("Cross Sales", "Unique Sales"));

  assert.equal(result.error, undefined);
  assert.equal(result.updated.reportBindings, 2);
  assert.equal(result.updated.daxExpressions, 1);

  const measures = allMeasures(result.model);
  assert.ok(measures.some((m) => m.name === "Unique Sales"));
  assert.equal(
    measures.find((m) => m.name === "Cross Ratio").expression,
    "DIVIDE ( [Unique Sales], 2 )"
  );
  // An unrelated measure must be left byte-for-byte alone.
  assert.equal(measures.find((m) => m.name === "Untouched").expression, "COUNTROWS ( FactSales )");

  const bound = result.model.pages.flatMap((p) => p.visuals).flatMap((v) => v.refs);
  assert.equal(bound.filter((r) => r.field === "Unique Sales").length, 2);
  assert.equal(bound.filter((r) => r.field === "Cross Sales").length, 0);

  // The input model is never mutated.
  assert.ok(allMeasures(model).some((m) => m.name === "Cross Sales"));
});

test("renaming a column updates DAX, relationships and bindings", () => {
  const model = makeModel();
  const result = applyChange(
    model,
    change({
      target: { type: "column", table: "FactSales", name: "Amount" },
      field: "name",
      before: "Amount",
      after: "Net Amount",
    })
  );

  assert.equal(result.error, undefined);
  assert.equal(result.updated.relationships, 1);
  assert.equal(result.updated.reportBindings, 1);

  const band = result.model.tables[0].columns.find((c) => c.name === "Band");
  assert.match(band.expression, /FactSales\[Net Amount\]/);
  assert.equal(result.model.relationships[0].fromColumn, "Net Amount");
  assert.equal(
    allMeasures(result.model).find((m) => m.name === "Cross Sales").expression,
    "SUM ( FactSales[Net Amount] )"
  );
});

test("renaming a table reports references it could not resolve", () => {
  const model = makeModel();
  const result = applyChange(
    model,
    change({
      target: { type: "table", name: "FactSales" },
      field: "name",
      before: "FactSales",
      after: "Sales",
    })
  );

  assert.equal(result.error, undefined);
  assert.equal(result.model.tables[0].name, "Sales");
  assert.equal(result.model.relationships[0].fromTable, "Sales");
  assert.equal(
    allMeasures(result.model).find((m) => m.name === "Cross Sales").expression,
    "SUM ( Sales[Amount] )"
  );

  // COUNTROWS ( FactSales ) takes the table unqualified, which cannot be
  // rewritten safely. It must be surfaced, not silently left dangling.
  assert.ok(result.unresolved.length > 0);
  assert.ok(result.unresolved.some((note) => /Untouched/.test(note)));
});

test("moving a measure to another table retargets its report bindings", () => {
  const model = makeModel();
  const result = applyChange(
    model,
    change({
      target: { type: "measure", table: "FactSales", name: "Cross Sales" },
      field: "homeTable",
      before: "FactSales",
      after: "Customer",
    })
  );

  assert.equal(result.error, undefined);
  assert.equal(result.model.tables.find((t) => t.name === "Customer").measures.length, 1);
  assert.equal(result.model.tables.find((t) => t.name === "FactSales").measures.length, 2);
  assert.equal(result.updated.reportBindings, 2);
});

// ------------------------------------------------------------ Field edits

test("DAX, description and format edits apply without touching references", () => {
  let session = newSession(makeModel());
  session = addChange(
    session,
    change({
      id: "dax",
      target: { type: "measure", table: "FactSales", name: "Cross Sales" },
      field: "expression",
      before: "SUM ( FactSales[Amount] )",
      after: "SUMX ( FactSales, FactSales[Amount] )",
    })
  );
  session = addChange(
    session,
    change({
      id: "m",
      target: { type: "partition", table: "FactSales", name: "p" },
      field: "expression",
      before: "old",
      after: 'let Source = Sql.Database("srv","db2") in Source',
    })
  );

  const { model, failed } = workingModel(session);
  assert.deepEqual(failed, []);
  assert.match(allMeasures(model).find((m) => m.name === "Cross Sales").expression, /SUMX/);
  assert.match(model.tables[0].partitions[0].expression, /db2/);
});

// --------------------------------------------------------------- Session

test("the original is never modified and the working model is derived", () => {
  const original = makeModel();
  let session = newSession(original);
  session = addChange(session, renameMeasure("Cross Sales", "Unique Sales"));

  const { model } = workingModel(session);
  assert.ok(allMeasures(model).some((m) => m.name === "Unique Sales"));
  assert.ok(
    allMeasures(session.original).some((m) => m.name === "Cross Sales"),
    "the uploaded model stays untouched as the source copy"
  );
});

test("undo, revert and revert-all are list operations over the change log", () => {
  let session = newSession(makeModel());
  session = addChange(session, renameMeasure("Cross Sales", "Unique Sales"));
  session = addChange(
    session,
    change({ id: "c2", target: { type: "table", name: "Customer" }, field: "name", before: "Customer", after: "Dim Customer" })
  );
  assert.equal(session.changes.length, 2);

  const afterUndo = undoLast(session);
  assert.equal(afterUndo.changes.length, 1);
  assert.equal(workingModel(afterUndo).model.tables[1].name, "Customer");

  // Reverting the *first* change while keeping the second must still work.
  const afterRevert = revertChange(session, "c1");
  assert.equal(afterRevert.changes.length, 1);
  const reverted = workingModel(afterRevert).model;
  assert.ok(allMeasures(reverted).some((m) => m.name === "Cross Sales"));
  assert.equal(reverted.tables[1].name, "Dim Customer");

  assert.equal(revertAll(session).changes.length, 0);
});

// ------------------------------------------------------------ Validation

test("a rename leaves no broken references behind", () => {
  let session = newSession(makeModel());
  session = addChange(session, renameMeasure("Cross Sales", "Unique Sales"));
  const { model } = workingModel(session);

  assert.deepEqual(regressions(session, model), [], "renaming must not introduce a dangling reference");
  assert.equal(validateReferences(model).ok, true);
});

test("editing DAX to reference a missing measure is caught as a regression", () => {
  let session = newSession(makeModel());
  session = addChange(
    session,
    change({
      target: { type: "measure", table: "FactSales", name: "Cross Ratio" },
      field: "expression",
      before: "DIVIDE ( [Cross Sales], 2 )",
      after: "DIVIDE ( [Does Not Exist], 2 )",
    })
  );

  const { model } = workingModel(session);
  const introduced = regressions(session, model);
  assert.ok(introduced.length > 0);
  assert.match(introduced[0].detail, /Does Not Exist/);
});

test("a change that can no longer apply is reported, not skipped silently", () => {
  let session = newSession(makeModel());
  session = addChange(session, renameMeasure("Nonexistent", "Whatever"));
  const { failed } = workingModel(session);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /no longer exists/);
});

// ------------------------------------------------------------------ Diff

test("the diff marks added and removed lines and keeps common ones", () => {
  const lines = diffLines("VAR a = 1\nRETURN a", "VAR a = 1\nVAR b = 2\nRETURN a + b");
  const summary = summariseDiff(lines);

  assert.equal(summary.unchanged, 1);
  assert.equal(summary.added, 2);
  assert.equal(summary.removed, 1);
  assert.equal(lines[0].kind, "same");
  assert.equal(lines[0].text, "VAR a = 1");
});

test("an unchanged expression produces no additions or removals", () => {
  const summary = summariseDiff(diffLines("SUM ( T[x] )", "SUM ( T[x] )"));
  assert.deepEqual(summary, { added: 0, removed: 0, unchanged: 1 });
});

test("change descriptions read like a source-control log", () => {
  assert.equal(describeChange(renameMeasure("A", "B")), "Measure renamed");
  assert.equal(
    describeChange(change({ target: { type: "partition", table: "T", name: "p" }, field: "expression" })),
    "Query modified"
  );
  assert.equal(
    describeChange(change({ target: { type: "measure", table: "T", name: "m" }, field: "expression" })),
    "DAX modified"
  );
});
