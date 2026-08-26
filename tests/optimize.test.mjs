import assert from "node:assert/strict";
import test from "node:test";

import {runOptimization} from "../lib/optimize/engine.ts";
import { rewriteDivision, rewriteRepeatedMeasure, suggestRewrites } from "../lib/optimize/rewrite.ts";
import { pageComplexity } from "../lib/optimize/pages.ts";
import { buildDependencyIndex, dependencyDepth } from "../lib/powerbi/graph.ts";

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

function makeModel({ tables = [], relationships = [], pages = [], capabilities = {} } = {}) {
  return {
    source: { fileName: "t.pbit", format: "pbit", sizeBytes: 1, extractedAt: "2026-01-01T00:00:00Z" },
    capabilities: {
      model: available(),
      report: available(),
      powerQuery: available(),
      runtime: unavailable("no engine"),
      ...capabilities,
    },
    tables,
    relationships,
    expressions: [],
    pages,
    warnings: [],
  };
}

const measure = (name, expression, table = "FactSales") => ({
  name,
  table,
  expression,
  isHidden: false,
  formatString: "0",
  description: "documented",
});

const table = (name, measures = [], columns = [], extra = {}) => ({
  name,
  kind: "table",
  isHidden: false,
  description: "documented",
  columns: columns.map((c) => ({
    name: typeof c === "string" ? c : c.name,
    table: name,
    dataType: (typeof c === "object" && c.dataType) || "string",
    kind: (typeof c === "object" && c.kind) || "data",
    expression: typeof c === "object" ? c.expression : undefined,
    isHidden: false,
    isKey: false,
  })),
  measures,
  partitions: [],
  ...extra,
});

const visual = (id, page, type, refs) => ({
  id,
  page,
  type,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  refs,
});

const page = (name, visuals, isHidden = false) => ({
  name,
  displayName: name,
  ordinal: 0,
  isHidden,
  width: 1280,
  height: 720,
  visuals,
});

// ------------------------------------------------------------ DAX rewriting

test("division is only rewritten when the slash is genuinely the root operator", () => {
  // `a - b / c` means `a - (b / c)`. Splitting on the slash would produce
  // DIVIDE ( a - b, c ), which is a different number. This must never rewrite.
  assert.equal(
    rewriteDivision("VAR Cur = [Total]\nVAR Prior = [LY]\nRETURN Cur - Prior / Prior"),
    undefined
  );
  assert.equal(rewriteDivision("[a] / [b] * [c]"), undefined, "root is *, not /");
  assert.equal(rewriteDivision("[a] / [b] / [c]"), undefined, "two top-level slashes");

  // Parenthesised numerator keeps the slash as the root, so this is safe.
  const safe = rewriteDivision("( [Total] - [LY] ) / [LY]");
  assert.ok(safe);
  assert.equal(safe.suggested, "DIVIDE ( ( [Total] - [LY] ), [LY] )");
  assert.equal(safe.confidence, "high");
  assert.equal(safe.benchmarked, false);
  assert.match(safe.behaviourChange, /BLANK/);
});

test("a rewrite inside VAR/RETURN only touches the returned expression", () => {
  const result = rewriteDivision("VAR Cur = [Total]\nRETURN Cur / [LY]");
  assert.ok(result);
  assert.match(result.suggested, /^VAR Cur = \[Total\]/);
  assert.match(result.suggested, /DIVIDE \( Cur, \[LY\] \)/);
});

test("a repeated measure is hoisted into a variable and every use replaced", () => {
  const result = rewriteRepeatedMeasure("IF ( [Sales] > 0, [Sales], 0 )");
  assert.ok(result);
  assert.equal(result.suggested, "VAR __Sales = [Sales]\nRETURN\n    IF ( __Sales > 0, __Sales, 0 )");
  // Exactly one [Sales] remains: the one in the VAR assignment.
  assert.equal(result.suggested.match(/\[Sales\]/g).length, 1);
  assert.equal(result.benchmarked, false);
});

test("expressions that already use VAR are left alone", () => {
  assert.equal(
    rewriteRepeatedMeasure("VAR x = [Sales]\nRETURN x + [Sales]"),
    undefined,
    "hoisting could collide with an existing variable name"
  );
});

test("no rewrite claims to be faster", () => {
  const all = [
    ...suggestRewrites("( [Total] - [LY] ) / [LY]"),
    ...suggestRewrites("IF ( [Sales] > 0, [Sales], 0 )"),
  ];
  assert.ok(all.length > 0);
  for (const rewrite of all) {
    assert.equal(rewrite.benchmarked, false);
    assert.doesNotMatch(
      `${rewrite.impact} ${rewrite.reason} ${rewrite.recommendation}`,
      /faster|speed|performance gain|optimi[sz]ed performance/i
    );
  }
});

test("comments cannot trigger a rewrite", () => {
  assert.deepEqual(suggestRewrites("DIVIDE ( [a], [b] ) // 50/50 split"), []);
});

// ------------------------------------------------------------- Dependencies

test("dependency depth follows measure chains", () => {
  const model = makeModel({
    tables: [
      table("FactSales", [
        measure("A", "SUM ( FactSales[x] )"),
        measure("B", "[A] * 2"),
        measure("C", "[B] + 1"),
        measure("D", "[C] + [A]"),
      ], ["x"]),
    ],
  });
  const index = buildDependencyIndex(model);
  assert.equal(dependencyDepth(index, "A"), 1);
  assert.equal(dependencyDepth(index, "B"), 2);
  assert.equal(dependencyDepth(index, "D"), 4);
});

test("unused objects are found, and used ones are not flagged", () => {
  const model = makeModel({
    tables: [
      table(
        "FactSales",
        [measure("Used", "SUM ( FactSales[Amount] )"), measure("Orphan", "1")],
        ["Amount", "NeverUsed"]
      ),
    ],
    pages: [page("P1", [visual("v1", "P1", "card", [{ table: "FactSales", field: "Used", kind: "measure" }])])],
  });

  const ids = runOptimization(model).opportunities;
  const unusedMeasures = ids.filter((o) => o.ruleId === "OPT-MOD-UNUSED-MEASURE").map((o) => o.target.name);
  const unusedColumns = ids.filter((o) => o.ruleId === "OPT-MOD-UNUSED-COLUMN").map((o) => o.target.name);

  assert.deepEqual(unusedMeasures, ["Orphan"]);
  assert.ok(unusedColumns.includes("NeverUsed"));
  assert.ok(!unusedColumns.includes("Amount"), "Amount is referenced by the Used measure");
});

// ----------------------------------------------------------- Relationships

test("a relationship loop is reported as an ambiguous path", () => {
  const rel = (name, from, to) => ({
    name,
    fromTable: from,
    fromColumn: "k",
    toTable: to,
    toColumn: "k",
    fromCardinality: "many",
    toCardinality: "one",
    crossFilteringBehavior: "oneDirection",
    isActive: true,
  });

  const looped = makeModel({
    tables: [table("A", [], ["k"]), table("B", [], ["k"]), table("C", [], ["k"])],
    relationships: [rel("r1", "A", "B"), rel("r2", "B", "C"), rel("r3", "A", "C")],
  });
  const ambiguous = runOptimization(looped).opportunities.filter(
    (o) => o.ruleId === "OPT-REL-AMBIGUOUS-PATH"
  );
  assert.equal(ambiguous.length, 1, "the edge closing the loop is reported once");

  const chain = makeModel({
    tables: [table("A", [], ["k"]), table("B", [], ["k"]), table("C", [], ["k"])],
    relationships: [rel("r1", "A", "B"), rel("r2", "B", "C")],
  });
  assert.equal(
    runOptimization(chain).opportunities.filter((o) => o.ruleId === "OPT-REL-AMBIGUOUS-PATH").length,
    0,
    "a chain has exactly one path between any two tables"
  );
});

// -------------------------------------------------------- Page complexity

test("page complexity is additive and every contribution is reported", () => {
  const refs = (n) => Array.from({ length: n }, (_, i) => ({ table: "T", field: `f${i}`, kind: "column" }));
  const model = makeModel({
    tables: [table("T", [], ["f0"])],
    pages: [
      page("Busy", [
        ...Array.from({ length: 10 }, (_, i) => visual(`v${i}`, "Busy", "card", refs(1))),
        visual("s1", "Busy", "slicer", refs(1)),
        visual("g1", "Busy", "pivotTable", refs(9)),
      ]),
    ],
  });

  const complexity = pageComplexity(model, model.pages[0]);
  assert.equal(complexity.visuals, 12);
  assert.equal(complexity.slicers, 1);
  assert.equal(complexity.largeGrids, 1);

  // The score is exactly the sum of the reported contributions.
  const summed = complexity.contributions.reduce((total, c) => total + c.points, 0);
  assert.equal(complexity.score, Math.min(100, summed));
  assert.ok(["simple", "moderate", "complex", "very complex"].includes(complexity.band));
});

// ------------------------------------------------------------------ Scoring

test("a report-only file scores null for model categories, never 100", () => {
  const model = makeModel({
    capabilities: { model: unavailable("The .pbix model is a binary Analysis Services backup.") },
    pages: [page("P1", [visual("v1", "P1", "card", [])])],
  });

  const result = runOptimization(model);
  const byName = Object.fromEntries(result.categories.map((c) => [c.category, c]));

  assert.equal(byName.DAX.score, null);
  assert.equal(byName.Model.score, null);
  assert.equal(byName.Relationship.score, null);
  assert.match(byName.DAX.reason, /Analysis Services backup/);

  // Visual rules need only the report, so they still ran.
  assert.ok(byName.Visual.rulesRun > 0);
  assert.ok(result.skipped.length > 0);
});

test("the score is the share of examined objects with nothing to improve", () => {
  const model = makeModel({
    tables: [table("FactSales", [measure("Ratio", "( [A] - [B] ) / [B]")], ["x"])],
    pages: [page("P1", [visual("v1", "P1", "card", [{ table: "FactSales", field: "Ratio", kind: "measure" }])])],
  });

  const result = runOptimization(model);
  const dax = result.categories.find((c) => c.category === "DAX");

  // One measure exists, and it has something to improve, so the category is
  // scored against a population of one rather than against a penalty total.
  assert.equal(dax.population, 1);
  assert.ok(dax.affected > 0 && dax.affected <= 1);
  assert.equal(dax.score, Math.round(100 * (1 - dax.affected / dax.population)));
});

test("performance is declared unassessed rather than estimated", () => {
  const result = runOptimization(makeModel());
  assert.ok(result.performanceNotAssessed.length > 0);
  assert.ok(result.performanceNotAssessed.some((s) => /timing/i.test(s)));
  // No category is called Performance: it is not scored at all.
  assert.ok(!result.categories.some((c) => c.category === "Performance"));
});

test("opportunities are ordered by impact and carry a resolvable target", () => {
  const model = makeModel({
    tables: [
      table("FactSales", [measure("Ratio", "( [A] - [B] ) / [B]"), measure("Orphan", "1")], ["x"]),
      table("Lonely", [], ["y"]),
    ],
    pages: [page("P1", [visual("v1", "P1", "card", [{ table: "FactSales", field: "Ratio", kind: "measure" }])])],
  });

  const result = runOptimization(model);
  const rank = { high: 0, medium: 1, low: 2 };
  const impacts = result.opportunities.map((o) => o.impact);
  assert.deepEqual(impacts, [...impacts].sort((a, b) => rank[a] - rank[b]));

  for (const item of result.opportunities) {
    assert.ok(item.target.key.includes(":"));
    assert.ok(item.recommendation.length > 0);
    assert.ok(item.detail.length > 0);
  }
  assert.ok(result.rewrites.every((o) => o.rewrite));
});
