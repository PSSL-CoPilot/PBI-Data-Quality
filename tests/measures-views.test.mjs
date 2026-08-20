import assert from "node:assert/strict";
import test from "node:test";

import { bestKpiName, inferKpiNames } from "../lib/powerbi/kpi.ts";
import {
  analyseMeasureSources,
  groupMeasuresByPage,
  groupMeasuresBySourceTable,
  measuresNotOnAnyPage,
} from "../lib/powerbi/sources.ts";
import { tableReferenceCounts } from "../lib/qa/dax.ts";
import { rewriteAsChange, runOptimization, safeRewrites } from "../lib/optimize/engine.ts";

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

const measure = (name, expression, table = "Measures") => ({
  name,
  table,
  expression,
  isHidden: false,
});

const table = (name, measures = [], columns = []) => ({
  name,
  kind: "table",
  isHidden: false,
  columns: columns.map((c) => ({
    name: c,
    table: name,
    dataType: "int64",
    kind: "data",
    isHidden: false,
    isKey: false,
  })),
  measures,
  partitions: [],
});

const card = (id, measureName, x, y, extra = {}) => ({
  id,
  page: "s1",
  type: "card",
  x,
  y,
  width: 200,
  height: 90,
  refs: [{ table: "Measures", field: measureName, kind: "measure" }],
  ...extra,
});

const caption = (id, text, x, y) => ({
  id,
  page: "s1",
  type: "textbox",
  x,
  y,
  width: 200,
  height: 30,
  text,
  refs: [],
});

function makeModel({ tables = [], pages = [], relationships = [] } = {}) {
  return {
    source: { fileName: "t.pbit", format: "pbit", sizeBytes: 1, extractedAt: "2026-01-01T00:00:00Z" },
    capabilities: {
      model: available(),
      report: available(),
      powerQuery: available(),
      runtime: unavailable("no engine"),
    },
    tables,
    relationships,
    expressions: [],
    pages,
    warnings: [],
  };
}

const page = (name, displayName, visuals, isHidden = false) => ({
  name,
  displayName,
  ordinal: 0,
  isHidden,
  width: 1280,
  height: 720,
  visuals: visuals.map((v) => ({ ...v, page: name })),
});

// ------------------------------------------------------- Source table analysis

test("measures are grouped by the table their DAX reads, not their home table", () => {
  const model = makeModel({
    tables: [
      table("Orders", [], ["Order ID", "Amount"]),
      table("Customer", [], ["Customer ID"]),
      table("Measures", [
        measure("M Total Orders", "COUNTROWS ( Orders )"),
        measure("M Order Revenue", "SUM ( Orders[Amount] )"),
        measure("M Customer Count", "DISTINCTCOUNT ( Customer[Customer ID] )"),
      ]),
    ],
  });

  const groups = groupMeasuresBySourceTable(model, analyseMeasureSources(model));
  const byTable = Object.fromEntries(groups.map((g) => [g.table, g.measures.map((m) => m.name)]));

  assert.deepEqual(byTable.Orders, ["M Order Revenue", "M Total Orders"]);
  assert.deepEqual(byTable.Customer, ["M Customer Count"]);
  assert.equal(byTable.Measures, undefined, "the home table must not become a group of its own");
  assert.equal(groups.find((g) => g.table === "Orders").movedIn, 2);
});

test("a measure is attributed through the measures it calls", () => {
  const model = makeModel({
    tables: [
      table("Orders", [], ["Amount"]),
      table("Measures", [
        measure("Base", "SUM ( Orders[Amount] )"),
        measure("Derived", "[Base] * 2"),
      ]),
    ],
  });

  const sources = analyseMeasureSources(model);
  const derived = sources.get("Measures[Derived]");
  assert.equal(derived.primary, "Orders");
  // Its own DAX names no table, so the attribution came from the closure.
  assert.deepEqual(derived.direct, []);
  assert.equal(derived.confidence, "medium");
});

test("no primary table is claimed when references are evenly split", () => {
  const model = makeModel({
    tables: [
      table("Orders", [], ["Amount"]),
      table("Customer", [], ["Id"]),
      table("Measures", [measure("Mixed", "SUM ( Orders[Amount] ) + DISTINCTCOUNT ( Customer[Id] )")]),
    ],
  });

  const analysis = analyseMeasureSources(model).get("Measures[Mixed]");
  assert.equal(analysis.primary, undefined);
  assert.equal(analysis.confidence, "low");
  assert.deepEqual(analysis.all.sort(), ["Customer", "Orders"]);
  assert.match(analysis.reason, /no single table dominates/);
});

test("a variable named like a table is not counted as a reference", () => {
  assert.deepEqual([...tableReferenceCounts("VAR Orders = 1 RETURN Orders", ["Orders"])], []);
  assert.deepEqual(
    [...tableReferenceCounts("VARIANCE ( Orders[Amount] )", ["Orders"])],
    [["Orders", 1]],
    "VARIANCE must not be mistaken for a VAR declaration"
  );
});

// -------------------------------------------------------------- Report groups

test("measures are grouped by the page whose visuals bind them", () => {
  const model = makeModel({
    tables: [
      table("Orders", [], ["Amount"]),
      table("Measures", [
        measure("M Unique Sales", "SUM ( Orders[Amount] )"),
        measure("M Unused", "1"),
      ]),
    ],
    pages: [
      page("s1", "Executive Dashboard", [card("v1", "M Unique Sales", 20, 60)]),
      page("s2", "Customer Analysis", []),
    ],
  });

  const groups = groupMeasuresByPage(model);
  assert.deepEqual(groups.map((g) => g.displayName), ["Executive Dashboard", "Customer Analysis"]);
  assert.deepEqual(groups[0].measures.map((m) => m.name), ["M Unique Sales"]);
  assert.deepEqual(groups[1].measures, []);

  // A measure no page binds is still reachable, never dropped.
  assert.deepEqual(measuresNotOnAnyPage(model).map((m) => m.name), ["M Unused"]);
});

test("a binding with no matching measure is reported, not silently ignored", () => {
  const model = makeModel({
    tables: [table("Measures", [])],
    pages: [page("s1", "Dash", [card("v1", "Deleted Measure", 0, 0)])],
  });

  const group = groupMeasuresByPage(model)[0];
  assert.deepEqual(group.measures, []);
  assert.deepEqual(group.unresolved, ["Deleted Measure"]);
});

// ------------------------------------------------------------- KPI inference

test("a caption directly above a card becomes the likely KPI name", () => {
  const model = makeModel({
    tables: [table("Measures", [measure("M Unique Sales", "1")])],
    pages: [
      page("s1", "Dash", [
        caption("c1", "Unique Sales", 20, 20),
        card("v1", "M Unique Sales", 20, 60),
      ]),
    ],
  });

  const guess = bestKpiName(inferKpiNames(model), "Measures", "M Unique Sales");
  assert.equal(guess.label, "Unique Sales");
  assert.equal(guess.source, "caption-above");
  assert.equal(guess.confidence, "medium");
  assert.equal(guess.distance, 10);
});

test("a visual's own title wins over a nearby caption", () => {
  const model = makeModel({
    tables: [table("Measures", [measure("M Unique Sales", "1")])],
    pages: [
      page("s1", "Dash", [
        caption("c1", "Section heading", 20, 20),
        card("v1", "M Unique Sales", 20, 60, { title: "Unique Sales" }),
      ]),
    ],
  });

  const guess = bestKpiName(inferKpiNames(model), "Measures", "M Unique Sales");
  assert.equal(guess.label, "Unique Sales");
  assert.equal(guess.source, "visual-title");
  assert.equal(guess.confidence, "high");
});

test("a distant caption does not become a label", () => {
  const model = makeModel({
    tables: [table("Measures", [measure("M Unique Sales", "1")])],
    pages: [
      page("s1", "Dash", [
        // Far above and far to the side: outside both thresholds.
        caption("c1", "Page banner", 900, 20),
        card("v1", "M Unique Sales", 20, 600),
      ]),
    ],
  });

  assert.equal(bestKpiName(inferKpiNames(model), "Measures", "M Unique Sales"), undefined);
});

test("a visual bound to several measures attributes no caption to any of them", () => {
  const model = makeModel({
    tables: [table("Measures", [measure("A", "1"), measure("B", "2")])],
    pages: [
      page("s1", "Dash", [
        caption("c1", "Revenue", 20, 20),
        {
          id: "v1",
          page: "s1",
          type: "multiRowCard",
          x: 20,
          y: 60,
          width: 200,
          height: 90,
          refs: [
            { table: "Measures", field: "A", kind: "measure" },
            { table: "Measures", field: "B", kind: "measure" },
          ],
        },
      ]),
    ],
  });

  const kpis = inferKpiNames(model);
  assert.equal(bestKpiName(kpis, "Measures", "A"), undefined);
  assert.equal(bestKpiName(kpis, "Measures", "B"), undefined);
});

test("captions that are not KPI names are rejected", () => {
  const model = makeModel({
    tables: [table("Measures", [measure("M Refreshed", "1")])],
    pages: [
      page("s1", "Dash", [
        caption("c1", "Last Refreshed :", 20, 20),
        card("v1", "M Refreshed", 20, 60),
      ]),
    ],
  });

  // The trailing colon is trimmed rather than shown as part of the name.
  assert.equal(bestKpiName(inferKpiNames(model), "Measures", "M Refreshed").label, "Last Refreshed");
});

// ------------------------------------------------------------ One-click apply

test("only opportunities with a validated rewrite can be applied", () => {
  const model = makeModel({
    tables: [
      table("Orders", [], ["Amount"]),
      table("Measures", [
        measure("Ratio", "SUM ( Orders[Amount] ) / COUNTROWS ( Orders )"),
        measure("Deep", "IF ( 1, IF ( 2, IF ( 3, IF ( 4, 1, 2 ), 3 ), 4 ), 5 )"),
      ]),
    ],
    pages: [page("s1", "Dash", [card("v1", "Ratio", 0, 0)])],
  });

  const opt = runOptimization(model);
  const safe = safeRewrites(opt);

  assert.equal(safe.length, 1);
  assert.equal(safe[0].target.name, "Ratio");

  const change = rewriteAsChange(safe[0], "c1", 0);
  assert.equal(change.field, "expression");
  assert.equal(change.target.table, "Measures");
  assert.match(change.after, /DIVIDE \( SUM \( Orders\[Amount\] \), COUNTROWS \( Orders \) \)/);

  // The advisory nesting finding must produce nothing applicable.
  const advisory = opt.opportunities.find((o) => o.ruleId === "OPT-DAX-NESTED-BRANCHING");
  assert.ok(advisory, "the advisory finding exists");
  assert.equal(rewriteAsChange(advisory, "c2", 0), undefined);
});
