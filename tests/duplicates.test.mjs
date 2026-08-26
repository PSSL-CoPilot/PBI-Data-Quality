import assert from "node:assert/strict";
import test from "node:test";

import { findDuplicateTables, planConsolidation, describeSource } from "../lib/optimize/duplicates.ts";
import { newSession, addChange, workingModel } from "../lib/edit/session.ts";

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

/** A table loaded from SQL Server with the given statement. */
function sqlTable(name, sql, columns, extraSteps = "") {
  const m = [
    "let",
    `    Source = Sql.Database("srv", "Sales", [Query="${sql.replace(/"/g, '""').replace(/\n/g, "#(lf)")}"])`,
    extraSteps,
    "in",
    `    ${extraSteps ? "Stepped" : "Source"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name,
    kind: "table",
    isHidden: false,
    columns: columns.map((c) => ({
      name: c,
      table: name,
      dataType: "string",
      kind: "data",
      isHidden: false,
      isKey: false,
    })),
    measures: [],
    partitions: [
      {
        name: `${name}-p`,
        table: name,
        mode: "import",
        sourceType: "m",
        expression: m,
        nativeQuery: { kind: "native", sql, connector: "Sql.Database" },
      },
    ],
  };
}

function measureTable(name, measures) {
  return {
    name,
    kind: "table",
    isHidden: false,
    columns: [],
    measures: measures.map(([n, e]) => ({ name: n, table: name, expression: e, isHidden: false })),
    partitions: [],
  };
}

function makeModel(tables, pages = [], relationships = []) {
  return {
    source: { fileName: "m.pbit", format: "pbit", sizeBytes: 1, extractedAt: "2026-01-01T00:00:00Z" },
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

// ---------------------------------------------------------------- detection --

test("tables reading the same object with different columns are compatible", () => {
  const model = makeModel([
    sqlTable("UniqueSales_Table", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
    sqlTable("Customer_Table", "SELECT CustomerID FROM dbo.Orders", ["CustomerID"]),
  ]);

  const [group] = findDuplicateTables(model);
  assert.equal(group.verdict, "compatible");
  assert.equal(group.object, "dbo.Orders");
  assert.equal(group.members.length, 3);
  assert.equal(group.removable.length, 2);

  // The union of every member's columns, and nothing invented.
  assert.match(group.consolidatedSql, /SalesID/);
  assert.match(group.consolidatedSql, /Revenue/);
  assert.match(group.consolidatedSql, /CustomerID/);
  assert.match(group.consolidatedSql, /FROM dbo\.Orders/);
});

test("identical queries are an exact duplicate", () => {
  const model = makeModel([
    sqlTable("Orders_A", "SELECT SalesID, Revenue FROM dbo.Orders", ["SalesID", "Revenue"]),
    sqlTable("Orders_B", "SELECT SalesID, Revenue FROM dbo.Orders", ["SalesID", "Revenue"]),
  ]);
  assert.equal(findDuplicateTables(model)[0].verdict, "exact");
});

test("the canonical table takes the source object's name when one matches", () => {
  const model = makeModel([
    sqlTable("Orders", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
  ]);
  const [group] = findDuplicateTables(model);
  assert.equal(group.canonical, "Orders");
  assert.deepEqual(group.removable, ["Revenue_Table"]);
});

// ------------------------------------------------------------------- safety --

test("different filters block a merge, because the rows are not the same rows", () => {
  const model = makeModel([
    sqlTable("All_Orders", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Active_Orders", "SELECT Revenue FROM dbo.Orders WHERE Active = 1", ["Revenue"]),
  ]);

  const [group] = findDuplicateTables(model);
  assert.equal(group.verdict, "unsafe");
  assert.match(group.blockers.join(" "), /different filters/i);
  assert.deepEqual(group.removable, [], "an unsafe group offers nothing to remove");
  assert.equal(group.consolidatedSql, undefined, "and no statement to apply");
  assert.equal(planConsolidation(model, group), undefined, "and no plan at all");
});

test("a different grain blocks a merge", () => {
  const model = makeModel([
    sqlTable("Order_Rows", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Order_Totals", "SELECT SUM(Revenue) FROM dbo.Orders GROUP BY CustomerID", ["Revenue"]),
  ]);
  const [group] = findDuplicateTables(model);
  assert.equal(group.verdict, "unsafe");
  assert.match(group.blockers.join(" "), /grain/i);
});

test("differing Power Query steps block a merge", () => {
  const model = makeModel([
    sqlTable("Plain", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable(
      "Filtered",
      "SELECT Revenue FROM dbo.Orders",
      ["Revenue"],
      "    Stepped = Table.SelectRows(Source, each [Revenue] > 0),"
    ),
  ]);
  const [group] = findDuplicateTables(model);
  assert.equal(group.verdict, "unsafe");
  assert.match(group.blockers.join(" "), /Power Query steps/i);
});

test("tables reading different objects are never grouped", () => {
  const model = makeModel([
    sqlTable("Orders_T", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Customer_T", "SELECT CustomerID FROM dbo.Customer", ["CustomerID"]),
  ]);
  assert.deepEqual(findDuplicateTables(model), []);
});

test("similar names alone are never evidence", () => {
  // Same names as a real duplicate pair, but different databases.
  const a = sqlTable("Orders_A", "SELECT SalesID FROM dbo.Orders", ["SalesID"]);
  const b = sqlTable("Orders_B", "SELECT SalesID FROM dbo.Orders", ["SalesID"]);
  b.partitions[0].expression = b.partitions[0].expression.replace('"Sales"', '"Archive"');

  assert.deepEqual(
    findDuplicateTables(makeModel([a, b])),
    [],
    "a different database is a different table however alike the names look"
  );
});

test("a table whose source object cannot be identified is never grouped", () => {
  const a = sqlTable("Joined_A", "SELECT x FROM dbo.Orders JOIN dbo.Customer ON 1=1", ["x"]);
  const b = sqlTable("Joined_B", "SELECT y FROM dbo.Orders JOIN dbo.Customer ON 1=1", ["y"]);
  assert.deepEqual(findDuplicateTables(makeModel([a, b])), []);
});

// -------------------------------------------------------------- consolidate --

test("consolidation rewrites every dependent measure and column", () => {
  const model = makeModel(
    [
      sqlTable("Orders", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
      sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
      measureTable("Measures", [
        ["Unique Sales", "DISTINCTCOUNT ( Orders[SalesID] )"],
        ["Revenue", "SUM ( Revenue_Table[Revenue] )"],
        ["Ratio", "DIVIDE ( SUM ( Revenue_Table[Revenue] ), DISTINCTCOUNT ( Orders[SalesID] ) )"],
      ]),
    ],
    [
      {
        name: "s1",
        displayName: "Sales",
        ordinal: 0,
        isHidden: false,
        width: 1,
        height: 1,
        visuals: [
          {
            id: "v1",
            page: "s1",
            type: "card",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            refs: [{ table: "Revenue_Table", field: "Revenue", kind: "column" }],
          },
        ],
      },
    ]
  );

  const [group] = findDuplicateTables(model);
  assert.equal(group.canonical, "Orders");

  const plan = planConsolidation(model, group);
  assert.equal(plan.summary.tablesRemovable, 1);
  assert.equal(plan.summary.canonical, "Orders");
  assert.equal(plan.summary.measuresRewritten, 2, "both measures reading Revenue_Table");
  assert.equal(plan.summary.visualsAffected, 1);

  // Apply the plan and confirm nothing still points at the duplicate.
  let session = newSession(model);
  for (const change of plan.changes) session = addChange(session, change);
  const after = workingModel(session).model;

  const dax = after.tables
    .flatMap((t) => t.measures)
    .map((m) => m.expression)
    .join(" ");
  assert.doesNotMatch(dax, /Revenue_Table/, "no measure still reads the duplicate");
  assert.match(dax, /SUM \( Orders\[Revenue\] \)/, "and it reads the canonical table instead");

  // The canonical table's own query now covers both columns.
  const sql = after.tables.find((t) => t.name === "Orders").partitions[0].nativeQuery.sql;
  assert.match(sql, /SalesID/);
  assert.match(sql, /Revenue/);
});

test("an unqualified table reference is reported rather than silently missed", () => {
  const model = makeModel([
    sqlTable("Orders", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
    measureTable("Measures", [
      // COUNTROWS takes the table itself, which cannot be rewritten unambiguously.
      ["Rows", "COUNTROWS ( Revenue_Table )"],
    ]),
  ]);

  const [group] = findDuplicateTables(model);
  const plan = planConsolidation(model, group);
  assert.ok(
    plan.warnings.some((w) => /unqualified/i.test(w)),
    "the reference that could not be rewritten is surfaced"
  );
});

test("nothing is deleted: duplicates are reported, not removed", () => {
  const model = makeModel([
    sqlTable("Orders", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
  ]);

  const [group] = findDuplicateTables(model);
  const plan = planConsolidation(model, group);

  let session = newSession(model);
  for (const change of plan.changes) session = addChange(session, change);
  const after = workingModel(session).model;

  assert.equal(after.tables.length, 2, "the duplicate table still exists after applying");
  assert.ok(
    plan.summary.tablesRemovable === 1,
    "it is reported as removable, which is a decision for the reviewer"
  );
});

test("every consolidation change is an ordinary, undoable change", () => {
  const model = makeModel([
    sqlTable("Orders", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
    measureTable("Measures", [["Revenue", "SUM ( Revenue_Table[Revenue] )"]]),
  ]);

  const plan = planConsolidation(model, findDuplicateTables(model)[0]);
  for (const change of plan.changes) {
    assert.ok(change.id, "has an id so it can be reverted individually");
    assert.ok(change.before !== undefined && change.after !== undefined, "carries both sides");
    assert.notEqual(change.before, change.after, "and actually changes something");
  }
});

// ------------------------------------------------------------------ sources --

test("the source description reads server, database and object", () => {
  const source = describeSource(sqlTable("T", "SELECT a FROM dbo.Orders WHERE x = 1", ["a"]));
  assert.equal(source.connector, "Sql.Database");
  assert.equal(source.server, "srv");
  assert.equal(source.database, "Sales");
  assert.equal(source.object, "dbo.Orders");
  assert.equal(source.grain, "row");
  assert.ok(source.filter, "the filter is captured so it can be compared");
});

test("one incompatible table does not poison the rest of the group", () => {
  // Four tables that are genuinely mergeable, plus a fifth reading the same
  // object through a filter. Grouping on the source alone made the whole set
  // unsafe and lost the recommendation entirely.
  const model = makeModel([
    sqlTable("UniqueSales_Table", "SELECT SalesID FROM dbo.Orders", ["SalesID"]),
    sqlTable("Revenue_Table", "SELECT Revenue FROM dbo.Orders", ["Revenue"]),
    sqlTable("OrderCount_Table", "SELECT OrderID FROM dbo.Orders", ["OrderID"]),
    sqlTable("AverageOrder_Table", "SELECT Amount FROM dbo.Orders", ["Amount"]),
    sqlTable("Active_Orders", "SELECT SalesID FROM dbo.Orders WHERE Active = 1", ["SalesID"]),
  ]);

  const groups = findDuplicateTables(model);
  const mergeable = groups.find((g) => g.verdict !== "unsafe");

  assert.ok(mergeable, "the compatible subset is still recommended");
  assert.equal(mergeable.members.length, 4);
  assert.equal(mergeable.removable.length, 3);
  assert.ok(
    !mergeable.members.includes("Active_Orders"),
    "the filtered table is not swept into a merge that would change its rows"
  );
  assert.match(mergeable.consolidatedSql, /SELECT[\s\S]*SalesID[\s\S]*Revenue[\s\S]*OrderID[\s\S]*Amount/);
});
