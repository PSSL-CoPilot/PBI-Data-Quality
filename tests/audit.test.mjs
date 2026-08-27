/**
 * The export audit is only worth having if it fails when it should.
 *
 * Each test takes a model that passed, breaks exactly one thing in the file
 * that came back, and asserts the audit refuses it and names the right check.
 * A test that only proves a clean export passes would be satisfied by an audit
 * that returns ok unconditionally.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";

import { auditExport } from "../lib/export/audit.ts";
import { extract } from "../lib/powerbi/extract.ts";

function utf16(value, withBom = true) {
  const text = (withBom ? "﻿" : "") + JSON.stringify(value);
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

const SCHEMA = {
  name: "M",
  compatibilityLevel: 1567,
  model: {
    culture: "en-US",
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "Amount", dataType: "int64" },
          { name: "Band", dataType: "string", type: "calculated", expression: ["IF ( Sales[Amount] > 10, \"H\", \"L\" )"] },
        ],
        measures: [
          { name: "Total", expression: "SUM ( Sales[Amount] )", formatString: "0" },
          { name: "Ratio", expression: "DIVIDE ( [Total], 2 )" },
        ],
        partitions: [
          {
            name: "p",
            mode: "import",
            source: {
              type: "m",
              expression: ["let", '  Source = Sql.Database("s","d",[Query="SELECT Amount FROM dbo.Sales"])', "in", "  Source"],
            },
          },
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
      { name: "r1", fromTable: "Sales", fromColumn: "Amount", toTable: "Customer", toColumn: "Id" },
    ],
  },
};

const LAYOUT = {
  id: 1,
  sections: [
    {
      name: "s1",
      displayName: "Overview",
      ordinal: 0,
      width: 1280,
      height: 720,
      visualContainers: [
        {
          id: "v1",
          x: 0, y: 0, z: 0, width: 300, height: 200,
          config: JSON.stringify({
            name: "v1",
            singleVisual: {
              visualType: "card",
              prototypeQuery: {
                From: [{ Name: "s", Entity: "Sales", Type: 0 }],
                Select: [
                  {
                    Measure: { Expression: { SourceRef: { Source: "s" } }, Property: "Total" },
                    Name: "Sales.Total",
                  },
                ],
              },
            },
          }),
        },
      ],
    },
  ],
};

const pbit = (schema = SCHEMA) =>
  zipSync({
    Version: utf16("1.30", false),
    DataModelSchema: utf16(schema),
    "Report/Layout": utf16(LAYOUT),
  });

const load = async (schema) => (await extract("f.pbit", pbit(schema))).model;

/** A deep copy of the fixture schema, for tampering. */
const copy = () => JSON.parse(JSON.stringify(SCHEMA));

const named = (report, name) => report.checks.find((c) => c.name === name);

test("an untouched round trip passes every check", async () => {
  const model = await load();
  const report = auditExport(model, model, model, []);
  assert.equal(report.ok, true, report.problems.join(" | "));
  assert.deepEqual(report.problems, []);
  assert.ok(report.checks.length >= 12);
  assert.ok(report.checks.every((c) => c.detail.length > 0), "every check states what it found");
});

test("a measure dropped on the way out is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables[0].measures.pop();
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(report.ok, false);
  assert.equal(named(report, "Measures").ok, false);
  assert.match(named(report, "Measures").detail, /Ratio/);
});

test("DAX that came back different is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables[0].measures[0].expression = "SUM ( Sales[Band] )";
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(report.ok, false);
  assert.equal(named(report, "Measure DAX").ok, false);
});

test("re-wrapped DAX is not treated as a difference", async () => {
  const expected = await load();
  const rewrapped = copy();
  rewrapped.model.tables[0].measures[0].expression = "SUM (\n    Sales[Amount]\n  )";
  const actual = await load(rewrapped);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Measure DAX").ok, true, "whitespace alone must not fail an export");
});

test("a lost table is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables.pop();
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Tables").ok, false);
  assert.match(named(report, "Tables").detail, /Customer/);
});

test("a column that changed data type is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables[0].columns[0].dataType = "string";
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Columns").ok, false);
  assert.match(named(report, "Columns").detail, /data type/i);
});

test("a calculated column whose expression was mangled is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables[0].columns[1].expression = ['IF ( Sales[Amount] > 99, "H", "L" )'];
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Calculated tables and columns").ok, false);
});

test("a relationship that flipped to inactive is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.relationships[0].isActive = false;
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Relationships").ok, false);
  assert.match(named(report, "Relationships").detail, /active/i);
});

test("native SQL that did not land where it was meant to is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables[0].partitions[0].source.expression = [
    "let",
    '  Source = Sql.Database("s","d",[Query="SELECT * FROM dbo.Sales"])',
    "in",
    "  Source",
  ];
  const actual = await load(broken);

  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Native SQL").ok, false);
  assert.match(named(report, "Native SQL").detail, /Sales/);
});

test("a visual left pointing at a measure that no longer exists is caught", async () => {
  const expected = await load();
  const broken = copy();
  broken.model.tables[0].measures[0].name = "Total Renamed";
  const actual = await load(broken);

  // The model renamed but the layout did not: the card now binds nothing.
  const report = auditExport(expected, expected, actual, []);
  assert.equal(named(report, "Report bindings").ok, false);
  assert.match(named(report, "Report bindings").detail, /Total/);
});

test("a rename that left both names behind is caught", async () => {
  const original = await load();
  const withBoth = copy();
  withBoth.model.tables[0].measures.push({ name: "Grand Total", expression: "SUM ( Sales[Amount] )" });
  const actual = await load(withBoth);

  const change = {
    id: "c1",
    at: 0,
    target: { type: "measure", table: "Sales", name: "Total" },
    field: "name",
    before: "Total",
    after: "Grand Total",
  };

  // `expected` no longer contains "Total"; the exported file still does.
  const expected = await load(
    (() => {
      const next = copy();
      next.model.tables[0].measures[0].name = "Grand Total";
      return next;
    })()
  );

  const report = auditExport(original, expected, actual, [change]);
  assert.equal(named(report, "Renamed objects").ok, false);
  assert.match(named(report, "Renamed objects").detail, /still in the exported file/);
});

test("a measure still calling a renamed measure is caught", async () => {
  const model = await load();
  const change = {
    id: "c1",
    at: 0,
    target: { type: "measure", table: "Sales", name: "Total" },
    field: "name",
    before: "Total",
    after: "Grand Total",
  };

  // Ratio in the fixture still says DIVIDE ( [Total], 2 ).
  const report = auditExport(model, model, model, [change]);
  assert.equal(named(report, "Dependent measures").ok, false);
  assert.match(named(report, "Dependent measures").detail, /\[Total\]/);
});

test("a consolidation whose redirect did not land is caught", async () => {
  const model = await load();
  const change = {
    id: "c1",
    at: 0,
    target: { type: "measure", table: "Sales", name: "Total" },
    field: "expression",
    before: "SUM ( Customer[Amount] )",
    after: "SUM ( Sales[Amount] )",
    intent: { kind: "consolidation", canonical: "Sales", replaced: ["Customer"] },
  };

  // Nothing reads Customer, so the redirect is complete.
  const clean = auditExport(model, model, model, [change]);
  assert.equal(named(clean, "Consolidated tables").ok, true);

  const stale = copy();
  stale.model.tables[0].measures[0].expression = "SUM ( Customer[Id] )";
  const actual = await load(stale);
  const report = auditExport(model, model, actual, [change]);
  assert.equal(named(report, "Consolidated tables").ok, false);
  assert.match(named(report, "Consolidated tables").detail, /Customer/);
});

test("a problem already in the uploaded file does not fail the export", async () => {
  const withBadRef = copy();
  withBadRef.model.tables[0].measures.push({ name: "Bad", expression: "[Does Not Exist] + 1" });
  const model = await load(withBadRef);

  const report = auditExport(model, model, model, []);
  assert.equal(named(report, "Broken references").ok, true);
  assert.match(named(report, "Broken references").detail, /left as it was/);
});
