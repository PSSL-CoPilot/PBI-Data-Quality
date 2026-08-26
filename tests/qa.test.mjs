import assert from "node:assert/strict";
import test from "node:test";

import { runQa } from "../lib/qa/engine.ts";
import {
  countCalls,
  maxNesting,
  referencedColumns,
  referencedMeasures,
  stripComments,
  timeIntelligenceUsed,
  usesDivisionOperator,
} from "../lib/qa/dax.ts";

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

/** Minimal model builder so each test states only what it is about. */
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

const measure = (name, expression, extra = {}) => ({
  name,
  table: "FactSales",
  expression,
  isHidden: false,
  formatString: "0",
  description: "documented",
  ...extra,
});

const table = (name, measures = [], columns = [], extra = {}) => ({
  name,
  kind: "table",
  isHidden: false,
  description: "documented",
  columns: columns.map((c) => ({
    name: c.name ?? c,
    table: name,
    dataType: c.dataType ?? "string",
    kind: "data",
    isHidden: false,
    isKey: false,
  })),
  measures,
  partitions: [],
  ...extra,
});

// ------------------------------------------------------------- DAX utilities

test("comments and strings never trigger text scans", () => {
  // Each of these would be a false positive for a naive `/` search.
  assert.equal(usesDivisionOperator("DIVIDE ( [a], [b] ) // fallback is 50/50"), false);
  assert.equal(usesDivisionOperator('DIVIDE ( [a], [b] ) -- ratio a/b'), false);
  assert.equal(usesDivisionOperator('IF ( [x] = "n/a", 0, [y] )'), false);
  assert.equal(usesDivisionOperator("/* uses a/b */ DIVIDE ( [a], [b] )"), false);

  // And the real thing is still caught.
  assert.equal(usesDivisionOperator("[Revenue] / [Prior]"), true);
  assert.equal(usesDivisionOperator("( [a] - [b] )/[b]"), true);
});

test("stripComments preserves line structure", () => {
  const stripped = stripComments("line1 // gone\nline2");
  assert.equal(stripped.split("\n").length, 2);
  assert.match(stripped, /line1/);
  assert.doesNotMatch(stripped, /gone/);
});

test("nesting depth distinguishes nested calls from sibling calls", () => {
  assert.equal(maxNesting("IF ( a, IF ( b, IF ( c, 1, 2 ), 3 ), 4 )", "IF"), 3);
  // Siblings are not nesting.
  assert.equal(maxNesting("IF ( a, 1, 2 ) + IF ( b, 3, 4 ) + IF ( c, 5, 6 )", "IF"), 1);
  assert.equal(maxNesting("SUM ( x )", "IF"), 0);
  assert.equal(countCalls("IF(a,1,2) + IF(b,3,4)", "IF"), 2);
});

test("reference extraction separates measures from columns", () => {
  const expression = "DIVIDE ( [Total Revenue], 'Date Table'[Year] ) + FactSales[Net]";
  assert.deepEqual(referencedMeasures(expression), ["Total Revenue"]);
  assert.deepEqual(referencedColumns(expression), [
    { table: "Date Table", column: "Year" },
    { table: "FactSales", column: "Net" },
  ]);
});

test("time intelligence functions are recognised", () => {
  assert.deepEqual(timeIntelligenceUsed("CALCULATE ( [x], SAMEPERIODLASTYEAR ( 'Date'[Date] ) )"), [
    "SAMEPERIODLASTYEAR",
  ]);
  assert.deepEqual(timeIntelligenceUsed("SUM ( x )"), []);
});

// ------------------------------------------------------------------- Scoring

test("an unreadable model scores null, never 100", () => {
  const model = makeModel({
    capabilities: {
      model: unavailable("This .pbix stores its semantic model in the binary DataModel part."),
    },
    pages: [{ name: "p1", displayName: "Page 1", ordinal: 0, isHidden: false, width: 1, height: 1, visuals: [] }],
  });

  const result = runQa(model);
  const dax = result.categories.find((c) => c.category === "DAX");

  assert.equal(dax.score, null, "DAX cannot score 100 when no DAX was readable");
  assert.equal(dax.rulesRun, 0);
  assert.ok(dax.rulesSkipped > 0);
  assert.match(dax.reason, /binary DataModel/);

  // Report rules that need only the report layer still ran.
  const report = result.categories.find((c) => c.category === "Report");
  assert.ok(report.rulesRun > 0, "report-only rules still run on a PBIX");

  assert.ok(result.skipped.length > 0);
  assert.notEqual(result.overall, null, "the report category still yields an overall score");
});

test("a clean model scores 100 and a broken one is penalised by weight", () => {
  const clean = makeModel({
    tables: [table("FactSales", [measure("Revenue", "SUM ( FactSales[Net] )")], [{ name: "Net" }])],
  });
  assert.equal(runQa(clean).categories.find((c) => c.category === "DAX").score, 100);

  const dirty = makeModel({
    tables: [
      table("FactSales", [measure("Ratio", "[Revenue] / [Prior]")], [{ name: "Net" }]),
    ],
  });
  const result = runQa(dirty);
  const dax = result.categories.find((c) => c.category === "DAX");

  const division = result.findings.find((f) => f.ruleId === "DAX-DIVISION");
  assert.ok(division, "unsafe division is found");
  assert.equal(division.severity, "high");
  assert.equal(division.target.key, "measure:FactSales[Ratio]");

  // The model holds exactly one measure, and it is damaged at "high" (0.6 of an
  // object), so 40% of the DAX surface is clean.
  assert.equal(dax.population, 1);
  assert.equal(dax.affected, 0.6);
  assert.equal(dax.score, 40, "the score is a share of the objects examined");
});

test("findings carry a resolvable target for every object type", () => {
  const model = makeModel({
    tables: [
      table("FactSales", [measure("Ratio", "[Revenue] / [Prior]")], [{ name: "Key", dataType: "int64" }]),
      table("Customer", [], [{ name: "Key", dataType: "string" }]),
    ],
    relationships: [
      {
        name: "r1",
        fromTable: "FactSales",
        fromColumn: "Key",
        toTable: "Customer",
        toColumn: "Key",
        fromCardinality: "many",
        toCardinality: "many",
        crossFilteringBehavior: "bothDirections",
        isActive: true,
      },
    ],
    pages: [
      { name: "p1", displayName: "Empty", ordinal: 0, isHidden: false, width: 1, height: 1, visuals: [] },
    ],
  });

  const result = runQa(model);
  const types = new Set(result.findings.map((f) => f.target.type));

  assert.ok(types.has("measure"));
  assert.ok(types.has("relationship"));
  assert.ok(types.has("page"));
  for (const finding of result.findings) {
    assert.ok(finding.target.key.includes(":"), "every target has a stable key");
    assert.ok(finding.recommendation.length > 0);
    assert.ok(finding.detail.length > 0);
  }

  // Data-type mismatch on the join keys must be caught.
  assert.ok(result.findings.some((f) => f.ruleId === "DQ-RELATIONSHIP-TYPE-MISMATCH"));
  assert.ok(result.findings.some((f) => f.ruleId === "REL-MANY-TO-MANY"));
});

test("a visual bound to a missing field is critical", () => {
  const model = makeModel({
    tables: [table("FactSales", [measure("Revenue", "SUM ( FactSales[Net] )")], [{ name: "Net" }])],
    pages: [
      {
        name: "p1",
        displayName: "Overview",
        ordinal: 0,
        isHidden: false,
        width: 1,
        height: 1,
        visuals: [
          {
            id: "v1",
            page: "p1",
            type: "card",
            title: "Deleted measure",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            refs: [{ table: "FactSales", field: "Cross Sales", kind: "measure" }],
          },
        ],
      },
    ],
  });

  const broken = runQa(model).findings.find((f) => f.ruleId === "REP-BROKEN-FIELD");
  assert.ok(broken);
  assert.equal(broken.severity, "critical");
  assert.equal(broken.target.type, "visual");
  assert.match(broken.detail, /Cross Sales/);
});

test("a measure referencing a missing measure is critical", () => {
  const model = makeModel({
    tables: [table("FactSales", [measure("YoY", "DIVIDE ( [Revenue], [Revenue LY] )")], [{ name: "Net" }])],
  });
  const finding = runQa(model).findings.find((f) => f.ruleId === "DQ-MEASURE-MISSING-DEPENDENCY");
  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.detail, /Revenue/);
});

test("page visual count escalates severity rather than duplicating rules", () => {
  const page = (name, count) => ({
    name,
    displayName: name,
    ordinal: 0,
    isHidden: false,
    width: 1,
    height: 1,
    visuals: Array.from({ length: count }, (_, i) => ({
      id: `v${i}`,
      page: name,
      type: "card",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      refs: [],
    })),
  });

  const result = runQa(makeModel({ pages: [page("Busy", 25), page("Crowded", 40)] }));
  const busy = result.findings.find((f) => f.target.name === "Busy" && f.ruleId === "REP-PAGE-TOO-MANY-VISUALS");
  const crowded = result.findings.find((f) => f.target.name === "Crowded" && f.ruleId === "REP-PAGE-TOO-MANY-VISUALS");

  assert.equal(busy.severity, "medium");
  assert.equal(crowded.severity, "high");
});

test("execution-dependent checks are declared, not silently omitted", () => {
  const result = runQa(makeModel());
  assert.ok(result.notAssessed.length > 0);
  assert.ok(result.notAssessed.some((n) => /row counts/i.test(n.check)));
});

test("findings are ordered most severe first", () => {
  const model = makeModel({
    tables: [
      table(
        "FactSales",
        [
          measure("Ratio", "[Revenue] / [Prior]"),
          measure("Plain", "SUM ( FactSales[Net] )", { formatString: undefined }),
        ],
        [{ name: "Net" }]
      ),
    ],
  });
  const severities = runQa(model).findings.map((f) => f.severity);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
  assert.deepEqual(severities, sorted);
});
