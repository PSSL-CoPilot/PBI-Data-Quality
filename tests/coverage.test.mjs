import assert from "node:assert/strict";
import { test } from "node:test";

import { auditModelCoverage } from "../lib/powerbi/coverage.ts";
import { parseTmsl } from "../lib/powerbi/tmsl.ts";

/**
 * TMSL with the vocabulary Power BI Desktop actually writes, rather than the
 * subset a fixture generator remembers. Every construct here changes what the
 * app may truthfully say about a model, so each one has an assertion below.
 */
const REAL_TMSL = {
  name: "Real",
  compatibilityLevel: 1567,
  model: {
    culture: "en-US",
    tables: [
      {
        name: "Sales",
        lineageTag: "a1b2",
        annotations: [{ name: "PBI_ResultType", value: "Table" }],
        columns: [
          {
            name: "Amount",
            dataType: "decimal",
            sourceColumn: "Amount",
            summarizeBy: "sum",
            sortByColumn: "AmountSort",
          },
        ],
        measures: [
          {
            name: "Total Sales",
            expression: "SUM ( Sales[Amount] )",
            kpi: {
              targetExpression: "[Target]",
              statusExpression: "IF([Total Sales]>[Target],1,-1)",
              statusGraphic: "Traffic Light - Single",
            },
          },
        ],
        hierarchies: [
          {
            name: "Product Hierarchy",
            levels: [
              { name: "Item", ordinal: 1, column: "Amount" },
              { name: "Category", ordinal: 0, column: "Amount" },
            ],
          },
        ],
        partitions: [{ name: "p", mode: "import", source: { type: "m", expression: "let x=1 in x" } }],
        refreshPolicy: {
          policyType: "basic",
          rollingWindowGranularity: "month",
          rollingWindowPeriods: 12,
          incrementalGranularity: "day",
          incrementalPeriods: 10,
        },
      },
      {
        name: "Time Intelligence",
        calculationGroup: {
          precedence: 10,
          calculationItems: [
            { name: "YTD", expression: "CALCULATE(SELECTEDMEASURE(), DATESYTD('Date'[Date]))" },
            { name: "PY", expression: "CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR('Date'[Date]))" },
          ],
        },
        columns: [{ name: "Calc Item", dataType: "string" }],
        partitions: [{ name: "cg", source: { type: "calculationGroup" } }],
      },
    ],
    relationships: [
      {
        name: "r1",
        fromTable: "Sales",
        fromColumn: "Amount",
        toTable: "Sales",
        toColumn: "Amount",
        securityFilteringBehavior: "both",
        relyOnReferentialIntegrity: true,
      },
    ],
    roles: [
      {
        name: "Region Manager",
        modelPermission: "read",
        tablePermissions: [{ name: "Sales", filterExpression: "[Region] = USERNAME()" }],
      },
    ],
    expressions: [{ name: "ServerName", kind: "m", expression: '"warehouse.internal"' }],
  },
};

const parsed = () => parseTmsl(REAL_TMSL);

test("a calculation group is read, because it rewrites how every measure evaluates", () => {
  const group = parsed().tables.find((t) => t.calculationGroup);
  assert.ok(group, "the calculation group table was not recognised");
  assert.equal(group.calculationGroup.precedence, 10);
  assert.deepEqual(
    group.calculationGroup.items.map((i) => i.name),
    ["YTD", "PY"]
  );
});

test("hierarchies are read, and their levels come back in declared order", () => {
  const table = parsed().tables.find((t) => t.name === "Sales");
  assert.equal(table.hierarchies.length, 1);
  assert.deepEqual(
    table.hierarchies[0].levels.map((l) => l.name),
    ["Category", "Item"],
    "levels must be sorted by ordinal, not by array position"
  );
});

test("a KPI the model declares is read as a fact, not inferred", () => {
  const measure = parsed()
    .tables.flatMap((t) => t.measures)
    .find((m) => m.name === "Total Sales");
  assert.equal(measure.kpi?.targetExpression, "[Target]");
  assert.equal(measure.kpi?.statusGraphic, "Traffic Light - Single");
});

test("row-level security roles are captured with their filters", () => {
  const { roles } = parsed();
  assert.equal(roles.length, 1);
  assert.equal(roles[0].name, "Region Manager");
  assert.deepEqual(roles[0].tableFilters, [
    { table: "Sales", filterExpression: "[Region] = USERNAME()" },
  ]);
});

test("an incremental refresh policy is read, so grain claims can account for it", () => {
  const table = parsed().tables.find((t) => t.name === "Sales");
  assert.equal(table.refreshPolicy?.policyType, "basic");
  assert.match(table.refreshPolicy.detail, /12 month/);
  assert.match(table.refreshPolicy.detail, /last 10 day/);
});

test("sortByColumn and the relationship security flags survive parsing", () => {
  const { tables, relationships } = parsed();
  assert.equal(tables[0].columns[0].sortByColumn, "AmountSort");
  assert.equal(relationships[0].securityFilteringBehavior, "both");
  assert.equal(relationships[0].relyOnReferentialIntegrity, true);
});

test("no object in the file is dropped on the way into the model", () => {
  const parts = parsed();
  const model = {
    tables: parts.tables,
    relationships: parts.relationships,
    expressions: parts.expressions,
    roles: parts.roles,
    pages: [],
    warnings: [],
    capabilities: {},
    source: { fileName: "t.pbit", format: "pbit", sizeBytes: 0, extractedAt: "" },
  };

  const report = auditModelCoverage(REAL_TMSL, model);
  assert.ok(
    report.complete,
    "counts differ: " +
      report.counts.filter((c) => !c.ok).map((c) => `${c.kind} ${c.inFile}!=${c.inModel}`).join(", ")
  );
});

test("nothing that changes a model's meaning is left unread", () => {
  const parts = parsed();
  const report = auditModelCoverage(REAL_TMSL, {
    tables: parts.tables,
    relationships: parts.relationships,
    expressions: parts.expressions,
    roles: parts.roles,
    pages: [],
    warnings: [],
    capabilities: {},
    source: { fileName: "t.pbit", format: "pbit", sizeBytes: 0, extractedAt: "" },
  });

  /*
   * The remaining unread properties are identifiers and editor bookkeeping.
   * None of them changes what a measure returns or what a reader sees, and all
   * of them survive an export untouched because the original archive is
   * repacked rather than regenerated. Anything NEW appearing here is a gap and
   * should fail until it is either read or consciously added to this list.
   */
  const KNOWN_UNREAD = new Set([
    "table.lineageTag",
    "table.annotations",
    "column.lineageTag",
    "column.annotations",
    "column.sourceColumn",
    "column.changedProperties",
    "column.isNullable",
    "column.isUnique",
    "column.isAvailableInMcp",
    "column.variations",
    "measure.lineageTag",
    "measure.annotations",
    "measure.dataType",
    "measure.isSimpleMeasure",
    "measure.detailRowsDefinition",
    "relationship.joinOnDateBehavior",
  ]);

  const surprises = report.ignored
    .map((i) => `${i.kind}.${i.property}`)
    .filter((id) => !KNOWN_UNREAD.has(id));

  assert.deepEqual(surprises, [], `unread properties nobody has decided about: ${surprises}`);
});
