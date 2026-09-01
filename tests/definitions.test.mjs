import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeMeasure,
  describeTable,
  readSqlFacts,
  UNAVAILABLE,
} from "../lib/export/definitions.ts";

/* ------------------------------------------------------------------ SQL --- */

test("a select list, source object and filter are read from SQL", () => {
  const facts = readSqlFacts(`SELECT
    Order_ID,
    Customer_ID,
    Revenue
FROM dbo.Orders
WHERE Status = 'Completed'`);

  assert.equal(facts.object, "dbo.Orders");
  assert.deepEqual(facts.columns, ["Order_ID", "Customer_ID", "Revenue"]);
  assert.equal(facts.where, "Status = 'Completed'");
  assert.equal(facts.selectsEverything, false);
});

test("aliases, qualifiers and brackets collapse to the resulting column name", () => {
  const facts = readSqlFacts("SELECT o.[Order Id] AS OrderId, c.Name FROM dbo.Orders o");
  assert.deepEqual(facts.columns, ["OrderId", "Name"]);
});

test("a comma inside a function call does not split the select list", () => {
  const facts = readSqlFacts("SELECT ISNULL(a, 0) AS A, COALESCE(b, c, 0) AS B FROM t");
  assert.deepEqual(facts.columns, ["A", "B"]);
});

test("a table named inside a string or comment is not mistaken for the source", () => {
  const facts = readSqlFacts(`-- FROM dbo.WrongTable
SELECT x FROM dbo.RightTable WHERE note = 'FROM dbo.AlsoWrong'`);
  assert.equal(facts.object, "dbo.RightTable");
});

test("joins and SELECT * are detected", () => {
  const facts = readSqlFacts("SELECT * FROM dbo.A INNER JOIN dbo.B ON A.id = B.id");
  assert.equal(facts.selectsEverything, true);
  assert.deepEqual(facts.joins, ["dbo.B"]);
});

/* ---------------------------------------------------------------- table --- */

const tableWith = (sql, extra = {}) => ({
  name: "Orders",
  kind: "table",
  isHidden: false,
  columns: [{ name: "a" }, { name: "b" }],
  measures: [],
  hierarchies: [],
  partitions: [
    {
      name: "p",
      table: "Orders",
      sourceType: "m",
      expression: "let x = 1 in x",
      nativeQuery: sql ? { kind: "native", sql } : { kind: "folded", reason: "folded" },
    },
  ],
  ...extra,
});

test("a table definition states the source, its filter and its columns", () => {
  const text = describeTable(
    tableWith("SELECT Order_ID, Customer_ID, Revenue FROM dbo.Orders WHERE Status = 'Completed'")
  );
  assert.match(text, /dbo\.Orders/);
  assert.match(text, /where Status = 'Completed'/);
  assert.match(text, /Order_ID, Customer_ID and Revenue/);
});

test("a folded table says so rather than inventing a statement", () => {
  const text = describeTable(tableWith(null));
  assert.match(text, /Power Query/);
  assert.doesNotMatch(text, /SELECT/i);
});

test("an author's own description always wins over a generated one", () => {
  const text = describeTable(tableWith("SELECT a FROM dbo.X", { description: "Hand written." }));
  assert.equal(text, "Hand written.");
});

test("a calculation group is described as one, because it changes every measure", () => {
  const text = describeTable(
    tableWith(null, {
      calculationGroup: { precedence: 1, items: [{ name: "YTD", expression: "..." }] },
    })
  );
  assert.match(text, /Calculation group/);
  assert.match(text, /YTD/);
});

/* -------------------------------------------------------------- measure --- */

const cases = [
  ["SUM ( Orders[Revenue] )", "Calculates the total Revenue from the Orders table."],
  [
    "DISTINCTCOUNT(Orders[Customer_ID])",
    "Calculates the distinct number of Customer_ID values from the Orders table.",
  ],
  ["AVERAGE(Orders[Revenue])", "Calculates the average Revenue value from the Orders table."],
  ["MIN(Orders[Revenue])", "Returns the lowest Revenue value in the Orders table."],
  ["MAX(Orders[Revenue])", "Returns the highest Revenue value in the Orders table."],
  ["COUNTROWS(Orders)", "Counts the number of rows in the Orders table."],
  [
    'COUNTROWS(FILTER(Orders, Orders[Status] = "Completed"))',
    "Counts Orders records where Status is Completed.",
  ],
  ["RELATED(Customer[Name])", "Returns the Name value from the related Customer table."],
];

for (const [dax, expected] of cases) {
  test(`describes ${dax}`, () => {
    assert.equal(describeMeasure(dax, ["Orders"]), expected);
  });
}

test("a leading assignment is stripped, not treated as part of the expression", () => {
  assert.equal(
    describeMeasure("Total Revenue =\nSUM(Orders[Revenue])", ["Orders"]),
    "Calculates the total Revenue from the Orders table."
  );
});

test("a quoted table name with spaces is read correctly", () => {
  assert.equal(
    describeMeasure("SUM('Order Lines'[Qty])", ["Order Lines"]),
    "Calculates the total Qty from the Order Lines table."
  );
});

test("SUMX names both the table it iterates and the column it totals", () => {
  const text = describeMeasure("SUMX(Orders, Orders[Qty] * Orders[Price])", ["Orders"]);
  assert.match(text, /row by row over the Orders table/);
});

test("DIVIDE names both operands", () => {
  const text = describeMeasure("DIVIDE([Revenue], [Orders])", ["Orders"]);
  assert.match(text, /Divides Revenue by Orders/);
});

test("CALCULATE with time intelligence states the period", () => {
  const text = describeMeasure(
    "CALCULATE(SUM(Orders[Revenue]), SAMEPERIODLASTYEAR('Date'[Date]))",
    ["Orders", "Date"]
  );
  assert.match(text, /the same period last year/);
});

test("CALCULATE with a filter states the condition", () => {
  const text = describeMeasure('CALCULATE(SUM(Orders[Revenue]), Orders[Status] = "Completed")', [
    "Orders",
  ]);
  assert.match(text, /total Revenue/);
  assert.match(text, /Status is Completed/);
});

test("an unrecognised expression names its tables and refuses to summarise", () => {
  const text = describeMeasure("Orders[A] * 1.07 + Customer[B] - 3", ["Orders", "Customer"]);
  assert.match(text, /Custom calculation using Orders and Customer data/);
  assert.match(text, /does not match a recognised pattern/);
});

test("an arithmetic combination is not mistaken for its first function call", () => {
  // The bug this guards: reading SUM(...) as the whole expression and calling
  // it "the total Revenue" when it is actually a total divided by something.
  const text = describeMeasure("SUM(Orders[Revenue]) / 12", ["Orders"]);
  assert.doesNotMatch(text, /^Calculates the total Revenue from the Orders table\.$/);
  assert.match(text, /Custom calculation/);
});

test("an empty expression is reported as unavailable, not described", () => {
  assert.equal(describeMeasure("", []), UNAVAILABLE);
});

test("no generated definition claims business meaning", () => {
  // Every phrase here would be an invention rather than a restatement.
  const forbidden = /\b(profit|performance|health|success|KPI target|business value|important)\b/i;
  const samples = [
    "SUM(Orders[Revenue])",
    "DISTINCTCOUNT(Orders[Customer_ID])",
    'CALCULATE(SUM(Orders[Revenue]), Orders[Status] = "Completed")',
    "Orders[A] * 1.07",
  ];
  for (const dax of samples) {
    assert.doesNotMatch(describeMeasure(dax, ["Orders"]), forbidden, `for ${dax}`);
  }
});

/* ------------------------------------------- regressions found in output --- */

test("a FILTER wrapper does not leak its closing bracket into the condition", () => {
  // Produced "Col_00 is greater than 0 )" before the call was unwrapped.
  const text = describeMeasure(
    "CALCULATE ( SUM ( Orders[Revenue] ), FILTER ( Orders, Orders[Revenue] > 0 ) )",
    ["Orders"]
  );
  assert.doesNotMatch(text, /\)/, `stray bracket in: ${text}`);
  assert.match(text, /Revenue is greater than 0/);
});

test("a truncated list does not produce two 'and's", () => {
  // Produced "a, b, c, d, e and f and 19 more" before the join was fixed.
  const many = Array.from({ length: 25 }, (_, i) => `Col_${String(i).padStart(2, "0")}`);
  const text = describeTable(
    tableWith(`SELECT ${many.join(", ")} FROM dbo.Wide`)
  );
  assert.doesNotMatch(text, /and \w+ and \d+ more/, `double and in: ${text}`);
  assert.match(text, /and 19 more/);
});

test("no generated definition contains an unbalanced bracket", () => {
  const samples = [
    "CALCULATE(SUM(Orders[Revenue]), FILTER(Orders, Orders[Status] = \"Completed\"))",
    "CALCULATE(SUM(Orders[Revenue]), Orders[Region] = \"EU\")",
    "CALCULATE([Base], ALL(Orders))",
    "COUNTROWS(FILTER(Orders, Orders[Qty] >= 5))",
  ];
  for (const dax of samples) {
    const text = describeMeasure(dax, ["Orders"]);
    const opens = (text.match(/\(/g) ?? []).length;
    const closes = (text.match(/\)/g) ?? []).length;
    assert.equal(opens, closes, `unbalanced brackets in "${text}" from ${dax}`);
  }
});
