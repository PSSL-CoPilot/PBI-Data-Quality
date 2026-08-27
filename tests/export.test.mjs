import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";

import { extract } from "../lib/powerbi/extract.ts";
import { allMeasures } from "../lib/powerbi/model.ts";
import { exportFileName, exportUpdatedFile } from "../lib/export/pbit.ts";
import { addChange, newSession, workingModel } from "../lib/edit/session.ts";

function utf16(value, withBom = true) {
  const text = (withBom ? "\uFEFF" : "") + JSON.stringify(value);
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

const SCHEMA = {
  name: "SemanticModel",
  compatibilityLevel: 1567,
  model: {
    culture: "en-US",
    tables: [
      {
        name: "FactSales",
        // An annotation this build does not model: it must survive export.
        annotations: [{ name: "PBI_ResultType", value: "Table" }],
        lineageTag: "abc-123",
        columns: [
          { name: "Amount", dataType: "int64", lineageTag: "col-1" },
          {
            name: "Band",
            dataType: "string",
            type: "calculated",
            expression: ["IF ( FactSales[Amount] > 10, \"High\", \"Low\" )"],
          },
        ],
        measures: [
          { name: "Cross Sales", expression: "SUM ( FactSales[Amount] )", formatString: "0" },
          { name: "Cross Ratio", expression: "DIVIDE ( [Cross Sales], 2 )" },
        ],
        partitions: [
          { name: "p", mode: "import", source: { type: "m", expression: ["let", "  Source = 1", "in", "  Source"] } },
        ],
      },
      {
        name: "Customer",
        columns: [{ name: "Id", dataType: "int64" }],
        measures: [],
        partitions: [{ name: "cp", source: { type: "query", query: "SELECT Id FROM dbo.Customer" } }],
      },
    ],
    relationships: [
      { name: "r1", fromTable: "FactSales", fromColumn: "Amount", toTable: "Customer", toColumn: "Id" },
    ],
  },
};

const visual = (id, measure, entity = "FactSales") => ({
  id,
  x: 0, y: 0, z: 0, width: 300, height: 200,
  config: JSON.stringify({
    name: id,
    singleVisual: {
      visualType: "card",
      prototypeQuery: {
        From: [{ Name: "f", Entity: entity, Type: 0 }],
        Select: [
          {
            Measure: { Expression: { SourceRef: { Source: "f" } }, Property: measure },
            Name: `${entity}.${measure}`,
            NativeReferenceName: measure,
          },
        ],
      },
      projections: { Values: [{ queryRef: `${entity}.${measure}` }] },
      // A caption that happens to equal the table name: must NOT be rewritten.
      vcObjects: { title: [{ properties: { text: { expr: { Literal: { Value: "'FactSales'" } } } } }] },
    },
  }),
});

const LAYOUT = {
  id: 1,
  sections: [
    {
      name: "s1",
      displayName: "Overview",
      ordinal: 0,
      width: 1280,
      height: 720,
      config: "{}",
      visualContainers: [visual("v1", "Cross Sales"), visual("v2", "Cross Ratio")],
    },
  ],
};

const buildPbit = () =>
  zipSync({
    Version: utf16("1.30", false),
    DataModelSchema: utf16(SCHEMA),
    "Report/Layout": utf16(LAYOUT),
    "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
    DiagramLayout: utf16({ layout: "untouched" }),
    "Report/StaticResources/logo.png": new Uint8Array([1, 2, 3, 4]),
  });

async function sessionWith(changes) {
  const { model, raw } = await extract("Sales.pbit", buildPbit());
  let session = newSession(model);
  for (const change of changes) session = addChange(session, change);
  return { session, raw, model };
}

const rename = (id, type, table, from, to) => ({
  id,
  at: 0,
  target: { type, table, name: from },
  field: "name",
  before: from,
  after: to,
});

test("a renamed measure is really in the exported file", async () => {
  const { session, raw, model } = await sessionWith([
    rename("c1", "measure", "FactSales", "Cross Sales", "Unique Sales"),
  ]);

  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.fileName, "Sales (edited).pbit");

  // Re-open the produced bytes independently of the export's own check.
  const reopened = (await extract(result.fileName, result.bytes)).model;
  const names = allMeasures(reopened).map((m) => m.name).sort();
  assert.deepEqual(names, ["Cross Ratio", "Unique Sales"]);

  // The dependent measure's DAX moved with it.
  assert.equal(
    allMeasures(reopened).find((m) => m.name === "Cross Ratio").expression,
    "DIVIDE ( [Unique Sales], 2 )"
  );

  // And the report binding points at the new name.
  const refs = reopened.pages.flatMap((p) => p.visuals).flatMap((v) => v.refs);
  assert.ok(refs.some((r) => r.field === "Unique Sales"));
  assert.ok(!refs.some((r) => r.field === "Cross Sales"));
});

test("parts this build never parses survive the round trip byte for byte", async () => {
  const originalParts = unzipSync(buildPbit());
  const { session, raw, model } = await sessionWith([
    rename("c1", "measure", "FactSales", "Cross Sales", "Unique Sales"),
  ]);

  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  const exportedParts = unzipSync(result.bytes);

  assert.deepEqual(
    Object.keys(exportedParts).sort(),
    Object.keys(originalParts).sort(),
    "no part is dropped or invented"
  );
  for (const untouched of ["DiagramLayout", "Report/StaticResources/logo.png", "[Content_Types].xml", "Version"]) {
    assert.deepEqual(
      Array.from(exportedParts[untouched]),
      Array.from(originalParts[untouched]),
      `${untouched} must be carried across unchanged`
    );
  }
});

test("model detail the normalized model drops is preserved", async () => {
  const { session, raw, model } = await sessionWith([
    rename("c1", "measure", "FactSales", "Cross Sales", "Unique Sales"),
  ]);
  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);

  const schema = JSON.parse(
    new TextDecoder("utf-16le").decode(unzipSync(result.bytes).DataModelSchema).replace(/^\uFEFF/, "")
  );
  const table = schema.model.tables.find((t) => t.name === "FactSales");

  assert.equal(table.lineageTag, "abc-123", "lineage tags are not modelled but must survive");
  assert.deepEqual(table.annotations, [{ name: "PBI_ResultType", value: "Table" }]);
  assert.equal(table.columns.find((c) => c.name === "Amount").lineageTag, "col-1");
  assert.equal(schema.compatibilityLevel, 1567);
});

test("expressions keep the string-or-array shape the file used", async () => {
  const { session, raw, model } = await sessionWith([
    rename("c1", "table", undefined, "FactSales", "Sales"),
  ]);
  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  const schema = JSON.parse(
    new TextDecoder("utf-16le").decode(unzipSync(result.bytes).DataModelSchema).replace(/^\uFEFF/, "")
  );
  const table = schema.model.tables.find((t) => t.name === "Sales");

  // The calculated column was written as an array of lines originally.
  assert.ok(Array.isArray(table.columns.find((c) => c.name === "Band").expression));
  assert.match(table.columns.find((c) => c.name === "Band").expression.join("\n"), /Sales\[Amount\]/);
  // The measure was a plain string.
  assert.equal(typeof table.measures.find((m) => m.name === "Cross Sales").expression, "string");
});

test("renaming a table updates entity names but not report captions", async () => {
  const { session, raw, model } = await sessionWith([
    rename("c1", "table", undefined, "FactSales", "Sales"),
  ]);
  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  assert.equal(result.ok, true);

  const layoutText = new TextDecoder("utf-16le")
    .decode(unzipSync(result.bytes)["Report/Layout"])
    .replace(/^\uFEFF/, "");
  const layout = JSON.parse(layoutText);
  const config = JSON.parse(layout.sections[0].visualContainers[0].config);

  assert.equal(config.singleVisual.prototypeQuery.From[0].Entity, "Sales");
  assert.equal(config.singleVisual.prototypeQuery.Select[0].Name, "Sales.Cross Sales");
  assert.equal(config.singleVisual.projections.Values[0].queryRef, "Sales.Cross Sales");

  // The title literal also read "FactSales"; captions are not identifiers.
  assert.equal(
    config.singleVisual.vcObjects.title[0].properties.text.expr.Literal.Value,
    "'FactSales'",
    "a visual caption must not be rewritten by a table rename"
  );
});

test("a DAX edit is written to the model and leaves the report alone", async () => {
  const { session, raw, model } = await sessionWith([
    {
      id: "c1",
      at: 0,
      target: { type: "measure", table: "FactSales", name: "Cross Sales" },
      field: "expression",
      before: "SUM ( FactSales[Amount] )",
      after: "SUMX ( FactSales, FactSales[Amount] )",
    },
  ]);

  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  assert.equal(result.ok, true);

  const reopened = (await extract("x.pbit", result.bytes)).model;
  assert.equal(
    allMeasures(reopened).find((m) => m.name === "Cross Sales").expression,
    "SUMX ( FactSales, FactSales[Amount] )"
  );
});

test("a native query edit is written back under `query`", async () => {
  const { session, raw, model } = await sessionWith([
    {
      id: "c1",
      at: 0,
      target: { type: "partition", table: "Customer", name: "cp" },
      field: "expression",
      before: "SELECT Id FROM dbo.Customer",
      after: "SELECT Id, Name FROM dbo.Customer",
    },
  ]);

  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  assert.equal(result.ok, true);

  const reopened = (await extract("x.pbit", result.bytes)).model;
  const partition = reopened.tables.find((t) => t.name === "Customer").partitions[0];
  assert.equal(partition.sourceType, "query");
  assert.equal(partition.expression, "SELECT Id, Name FROM dbo.Customer");
});

test("an export that would break a reference is refused, not offered", async () => {
  const { session, raw, model } = await sessionWith([
    {
      id: "c1",
      at: 0,
      target: { type: "measure", table: "FactSales", name: "Cross Ratio" },
      field: "expression",
      before: "DIVIDE ( [Cross Sales], 2 )",
      after: "DIVIDE ( [Gone Missing], 2 )",
    },
  ]);

  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  assert.equal(result.ok, false);
  assert.equal(result.bytes, undefined, "no file is handed back when verification fails");
  assert.ok(result.problems.some((p) => /broken reference/i.test(p)));
  assert.ok(result.problems.some((p) => /Gone Missing/.test(p)));
});

test("export is refused when the original archive was not retained", async () => {
  const { session, model } = await sessionWith([
    rename("c1", "measure", "FactSales", "Cross Sales", "Unique Sales"),
  ]);
  const result = await exportUpdatedFile({ parts: {}, modelSchemaBom: false, modelSchemaEncoding: "utf-16le", layoutBom: false, layoutEncoding: "utf-16le" }, model, session.changes);

  assert.equal(result.ok, false);
  assert.match(result.problems[0], /not available/);
});

test("exporting with no changes is refused", async () => {
  const { raw, model } = await sessionWith([]);
  const result = await exportUpdatedFile(raw, model, [], model);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /no changes/i);
});

test("the export is named so it cannot overwrite the original", () => {
  assert.equal(exportFileName("Sales.pbit"), "Sales (edited).pbit");
  assert.equal(exportFileName("Report v2.pbip"), "Report v2 (edited).pbip");
  assert.equal(exportFileName("noextension"), "noextension (edited).pbit");
});

test("several changes at once all land in one exported file", async () => {
  const { session, raw, model } = await sessionWith([
    rename("c1", "measure", "FactSales", "Cross Sales", "Unique Sales"),
    rename("c2", "table", undefined, "Customer", "Dim Customer"),
    {
      id: "c3",
      at: 0,
      target: { type: "measure", table: "FactSales", name: "Cross Ratio" },
      field: "formatString",
      before: "",
      after: "0.00%",
    },
  ]);

  const { model: expected } = workingModel(session);
  const result = await exportUpdatedFile(raw, model, session.changes, workingModel(session).model);
  assert.deepEqual(result.problems, []);

  const reopened = (await extract("x.pbit", result.bytes)).model;
  assert.deepEqual(
    reopened.tables.map((t) => t.name).sort(),
    expected.tables.map((t) => t.name).sort()
  );
  assert.ok(allMeasures(reopened).some((m) => m.name === "Unique Sales"));
  assert.equal(
    allMeasures(reopened).find((m) => m.name === "Cross Ratio").formatString,
    "0.00%"
  );
  assert.equal(result.verified.renamedObjectsFound.length, 2);
});
