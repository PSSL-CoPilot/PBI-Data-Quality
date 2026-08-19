import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";

import { extract, detectFormat, ExtractionError } from "../lib/powerbi/extract.ts";
import { collectRefs } from "../lib/powerbi/layout.ts";
import { allMeasures, allColumns, objectKey } from "../lib/powerbi/model.ts";

/** Encode a JS value the way Power BI stores its JSON parts: UTF-16LE. */
function utf16(value, withBom = true) {
  const text = (withBom ? "﻿" : "") + JSON.stringify(value);
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

/** A DataModelSchema shaped like the real thing, including TMSL's defaults. */
const DATA_MODEL_SCHEMA = {
  name: "SemanticModel",
  compatibilityLevel: 1567,
  model: {
    culture: "en-US",
    tables: [
      {
        name: "FactSales",
        columns: [
          { name: "Order ID", dataType: "int64", isKey: true },
          { name: "Net Revenue", dataType: "decimal", formatString: "\\$#,0.00" },
          {
            name: "Margin Band",
            dataType: "string",
            type: "calculated",
            expression: ["IF ( FactSales[Net Revenue] > 1000, \"High\", \"Low\" )"],
          },
        ],
        measures: [
          {
            name: "Total Revenue",
            expression: "SUM ( FactSales[Net Revenue] )",
            formatString: "\\$#,0",
            description: "Net revenue recognised in the period.",
          },
          {
            // Expression as an array of lines, which TMSL does constantly.
            name: "Revenue YoY %",
            expression: [
              "VAR CurrentRevenue = [Total Revenue]",
              "VAR PriorRevenue = [Revenue LY]",
              "RETURN ( CurrentRevenue - PriorRevenue ) / PriorRevenue",
            ],
            formatString: "0.0%",
          },
          { name: "Revenue LY", expression: "CALCULATE ( [Total Revenue] )" },
        ],
        partitions: [
          {
            name: "FactSales-partition",
            mode: "import",
            source: { type: "m", expression: ["let", "  Source = Sql.Database(\"srv\", \"db\")", "in", "  Source"] },
          },
        ],
      },
      {
        name: "Customer",
        columns: [{ name: "Email", dataType: "string" }],
        measures: [],
        partitions: [
          {
            name: "Customer-partition",
            source: { type: "query", query: "SELECT Email FROM dbo.Customer" },
          },
        ],
      },
      {
        name: "Date",
        columns: [{ name: "Date", dataType: "dateTime" }],
        measures: [],
        // A calculated table: the DAX lives on the partition source.
        partitions: [
          {
            name: "Date-partition",
            source: { type: "calculated", expression: "CALENDARAUTO ( )" },
          },
        ],
      },
    ],
    relationships: [
      // Every default omitted: must become many-to-one, single direction, active.
      { name: "r1", fromTable: "FactSales", fromColumn: "Order ID", toTable: "Customer", toColumn: "Email" },
      {
        name: "r2",
        fromTable: "FactSales",
        fromColumn: "Order ID",
        toTable: "Date",
        toColumn: "Date",
        crossFilteringBehavior: "bothDirections",
        isActive: false,
      },
    ],
    expressions: [
      { name: "ServerName", kind: "m", expression: "\"srv\" meta [IsParameterQuery=true]" },
    ],
  },
};

function visualContainer(id, measureName, entity, alias) {
  return {
    id,
    x: 10,
    y: 20,
    z: 0,
    width: 300,
    height: 200,
    config: JSON.stringify({
      name: id,
      singleVisual: {
        visualType: "clusteredColumnChart",
        prototypeQuery: {
          Version: 2,
          From: [{ Name: alias, Entity: entity, Type: 0 }],
          Select: [
            {
              Measure: { Expression: { SourceRef: { Source: alias } }, Property: measureName },
              Name: `${entity}.${measureName}`,
            },
          ],
        },
        vcObjects: {
          title: [{ properties: { text: { expr: { Literal: { Value: `'${measureName} by month'` } } } } }],
        },
      },
    }),
  };
}

const REPORT_LAYOUT = {
  id: 1,
  sections: [
    {
      name: "ReportSection1",
      displayName: "Executive Overview",
      ordinal: 0,
      width: 1280,
      height: 720,
      config: JSON.stringify({}),
      visualContainers: [
        visualContainer("v1", "Total Revenue", "FactSales", "f"),
        visualContainer("v2", "Revenue YoY %", "FactSales", "f"),
        // A visual group is layout only and must not become a visual.
        { id: "g1", x: 0, y: 0, z: 0, width: 10, height: 10, config: JSON.stringify({ name: "g1", singleVisualGroup: { displayName: "Group" } }) },
      ],
    },
    {
      name: "ReportSection2",
      displayName: "Hidden Drillthrough",
      ordinal: 1,
      width: 1280,
      height: 720,
      config: JSON.stringify({ visibility: 1 }),
      visualContainers: [visualContainer("v3", "Revenue LY", "FactSales", "f")],
    },
  ],
};

const pbit = () =>
  zipSync({
    Version: utf16("1.30", false),
    DataModelSchema: utf16(DATA_MODEL_SCHEMA),
    "Report/Layout": utf16(REPORT_LAYOUT),
    "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
  });

const pbix = () =>
  zipSync({
    Version: utf16("1.30", false),
    // The real part is a compressed Analysis Services backup; the header is
    // enough to prove we detect and refuse it rather than guessing.
    DataModel: new TextEncoder().encode("This backup was created using XPress9"),
    "Report/Layout": utf16(REPORT_LAYOUT),
  });

test("PBIT yields a full semantic model", async () => {
  const { model, raw } = await extract("Sales.pbit", pbit());

  assert.equal(model.source.format, "pbit");
  assert.equal(model.capabilities.model.available, true);
  assert.equal(model.capabilities.report.available, true);
  assert.equal(model.capabilities.powerQuery.available, true);
  // Nothing is ever executed, so runtime must stay explicitly unavailable.
  assert.equal(model.capabilities.runtime.available, false);

  assert.deepEqual(model.tables.map((t) => t.name), ["FactSales", "Customer", "Date"]);
  assert.equal(allMeasures(model).length, 3);
  assert.equal(allColumns(model).length, 5);

  const yoy = allMeasures(model).find((m) => m.name === "Revenue YoY %");
  assert.match(yoy.expression, /VAR CurrentRevenue/);
  // Array-of-lines expressions must be joined, not stringified.
  assert.match(yoy.expression, /\n/);
  assert.equal(yoy.formatString, "0.0%");
  assert.equal(yoy.table, "FactSales");

  // The original document is retained so export can replay edits onto it.
  assert.equal(raw.modelSchemaPath, "DataModelSchema");
  assert.ok(raw.modelSchema);
  assert.equal(raw.modelSchemaBom, true);
});

test("calculated tables and columns are distinguished from imported ones", async () => {
  const { model } = await extract("Sales.pbit", pbit());

  const date = model.tables.find((t) => t.name === "Date");
  assert.equal(date.kind, "calculated");
  assert.equal(date.expression, "CALENDARAUTO ( )");

  const fact = model.tables.find((t) => t.name === "FactSales");
  assert.equal(fact.kind, "table");

  const band = fact.columns.find((c) => c.name === "Margin Band");
  assert.equal(band.kind, "calculated");
  assert.match(band.expression, /IF \( FactSales/);
  assert.equal(fact.columns.find((c) => c.name === "Order ID").kind, "data");
});

test("Power Query and native SQL partitions are both captured", async () => {
  const { model } = await extract("Sales.pbit", pbit());

  const m = model.tables.find((t) => t.name === "FactSales").partitions[0];
  assert.equal(m.sourceType, "m");
  assert.match(m.expression, /Sql\.Database/);

  // Native queries store the statement under `query`, not `expression`.
  const sql = model.tables.find((t) => t.name === "Customer").partitions[0];
  assert.equal(sql.sourceType, "query");
  assert.equal(sql.expression, "SELECT Email FROM dbo.Customer");

  assert.equal(model.expressions.length, 1);
  assert.equal(model.expressions[0].name, "ServerName");
});

test("omitted relationship properties fall back to TMSL defaults", async () => {
  const { model } = await extract("Sales.pbit", pbit());

  const [r1, r2] = model.relationships;
  assert.equal(r1.fromCardinality, "many");
  assert.equal(r1.toCardinality, "one");
  assert.equal(r1.crossFilteringBehavior, "oneDirection");
  assert.equal(r1.isActive, true, "a relationship with no isActive is active");

  assert.equal(r2.crossFilteringBehavior, "bothDirections");
  assert.equal(r2.isActive, false);
});

test("report pages, visuals and bindings are parsed", async () => {
  const { model } = await extract("Sales.pbit", pbit());

  assert.equal(model.pages.length, 2);
  const [overview, hidden] = model.pages;

  assert.equal(overview.displayName, "Executive Overview");
  assert.equal(overview.isHidden, false);
  // The visual group must not be counted as a visual.
  assert.equal(overview.visuals.length, 2);
  assert.equal(overview.visuals[0].title, "Total Revenue by month");
  assert.equal(overview.visuals[0].type, "clusteredColumnChart");

  assert.equal(hidden.isHidden, true, "visibility 1 means hidden in view mode");

  const ref = overview.visuals[0].refs[0];
  assert.deepEqual(ref, { table: "FactSales", field: "Total Revenue", kind: "measure" });
});

test("bindings outside Select are still found, so renames cannot miss one", () => {
  // A measure referenced only in a filter clause: exactly the binding a
  // Select-only extractor drops and then silently breaks on rename.
  const refs = collectRefs({
    config: JSON.stringify({
      singleVisual: {
        prototypeQuery: {
          From: [{ Name: "f", Entity: "FactSales", Type: 0 }],
          Select: [{ Measure: { Expression: { SourceRef: { Source: "f" } }, Property: "Total Revenue" } }],
          Where: [
            {
              Condition: {
                Comparison: {
                  Left: { Measure: { Expression: { SourceRef: { Source: "f" } }, Property: "Gross Margin %" } },
                },
              },
            },
          ],
          OrderBy: [
            { Expression: { Column: { Expression: { SourceRef: { Source: "f" } }, Property: "Order ID" } } },
          ],
        },
      },
    }),
  });

  const names = refs.map((r) => `${r.kind}:${r.table}[${r.field}]`).sort();
  assert.deepEqual(names, [
    "column:FactSales[Order ID]",
    "measure:FactSales[Gross Margin %]",
    "measure:FactSales[Total Revenue]",
  ]);
});

test("PBIX degrades honestly: report available, model refused with a reason", async () => {
  const { model } = await extract("Sales.pbix", pbix());

  assert.equal(model.source.format, "pbix");
  assert.equal(model.capabilities.report.available, true);
  assert.equal(model.pages.length, 2, "the report layer is fully readable");

  assert.equal(model.capabilities.model.available, false);
  assert.match(model.capabilities.model.reason, /Analysis Services backup/);
  assert.match(model.capabilities.model.reason, /\.pbit/);
  assert.equal(model.capabilities.powerQuery.available, false);

  // No model means no invented model objects. This is the core guardrail.
  assert.deepEqual(model.tables, []);
  assert.deepEqual(model.relationships, []);
  assert.equal(allMeasures(model).length, 0);
});

test("a non-Power-BI archive is rejected rather than half-parsed", async () => {
  const junk = zipSync({ "readme.txt": new TextEncoder().encode("hello") });
  await assert.rejects(() => extract("notes.zip", junk), (error) => {
    assert.ok(error instanceof ExtractionError);
    assert.match(error.detail, /readme\.txt/);
    return true;
  });
});

test("format detection keys off archive parts, not the file extension", () => {
  assert.equal(detectFormat(["DataModelSchema", "Report/Layout"]).format, "pbit");
  assert.equal(detectFormat(["DataModel", "Report/Layout"]).format, "pbix");
  assert.equal(detectFormat(["Sales.SemanticModel/model.bim"]).format, "pbip");
  assert.equal(detectFormat(["nothing/relevant.txt"]), undefined);

  // TMDL is a real PBIP model we cannot read yet: say so, do not claim success.
  const tmdl = detectFormat(["Sales.SemanticModel/definition/tables/Fact.tmdl"]);
  assert.equal(tmdl.format, "pbip");
  assert.match(tmdl.modelUnavailableReason, /TMDL parsing is not implemented/);
});

test("object keys are stable and table-qualified", () => {
  assert.equal(objectKey("measure", "FactSales", "Total Revenue"), "measure:FactSales[Total Revenue]");
  assert.equal(objectKey("table", undefined, "FactSales"), "table:FactSales");
});
