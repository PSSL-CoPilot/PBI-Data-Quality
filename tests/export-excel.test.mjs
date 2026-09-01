import assert from "node:assert/strict";
import { test } from "node:test";

import ExcelJS from "exceljs";
import { strFromU8, unzipSync } from "fflate";

import { buildDocument } from "../lib/export/document.ts";
import { buildWorkbook, documentationFileName } from "../lib/export/workbook.ts";

/**
 * A model with the shapes that make this feature hard:
 *
 *  - a measure stored in `Measures` whose DAX reads `Orders`, which must be
 *    documented under Orders and not under Measures
 *  - a measure reading two tables evenly, which must not be filed under a guess
 *  - a table with native SQL and one whose query folds
 */
function model() {
  const measure = (name, expression) => ({
    name,
    table: "Measures",
    expression,
    isHidden: false,
  });

  const column = (name, table) => ({
    name,
    table,
    dataType: "string",
    kind: "data",
    isHidden: false,
    isKey: false,
  });

  return {
    source: { fileName: "Sales Dashboard.pbit", format: "pbit", sizeBytes: 1024, extractedAt: "" },
    capabilities: { model: { available: true }, report: { available: true } },
    relationships: [
      {
        name: "r",
        fromTable: "Orders",
        fromColumn: "Customer_ID",
        toTable: "Customer",
        toColumn: "Customer_ID",
        fromCardinality: "many",
        toCardinality: "one",
        crossFilteringBehavior: "oneDirection",
        isActive: true,
      },
    ],
    expressions: [],
    roles: [],
    warnings: [],
    pages: [
      {
        name: "p1",
        displayName: "Sales Overview",
        ordinal: 0,
        isHidden: false,
        width: 1280,
        height: 720,
        visuals: [
          {
            id: "v1",
            page: "p1",
            type: "card",
            title: "Revenue this year",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            refs: [{ table: "Measures", field: "Total Revenue", kind: "measure" }],
          },
        ],
      },
    ],
    tables: [
      {
        name: "Orders",
        kind: "table",
        isHidden: false,
        columns: [column("Order_ID", "Orders"), column("Sales_ID", "Orders"), column("Revenue", "Orders")],
        measures: [],
        hierarchies: [],
        partitions: [
          {
            name: "p",
            table: "Orders",
            mode: "import",
            sourceType: "m",
            expression: "let x = 1 in x",
            nativeQuery: {
              kind: "native",
              connector: "Sql.Database",
              sql: "SELECT\n    Order_ID,\n    Sales_ID,\n    Revenue\nFROM dbo.Orders\nWHERE Status = 'Completed'",
            },
          },
        ],
      },
      {
        name: "Customer",
        kind: "table",
        isHidden: false,
        columns: [column("Customer_ID", "Customer"), column("Name", "Customer")],
        measures: [],
        hierarchies: [],
        partitions: [
          {
            name: "p",
            table: "Customer",
            sourceType: "m",
            expression: "let y = 1 in y",
            nativeQuery: { kind: "folded", reason: "Power Query folds this query at refresh time." },
          },
        ],
      },
      {
        name: "Measures",
        kind: "table",
        isHidden: false,
        columns: [],
        hierarchies: [],
        measures: [
          measure("Unique Sales", "DISTINCTCOUNT(Orders[Sales_ID])"),
          measure("Total Revenue", "SUM(Orders[Revenue])"),
          measure("Cross Table", "COUNTROWS(Orders) + COUNTROWS(Customer)"),
        ],
        partitions: [
          { name: "mp", table: "Measures", sourceType: "calculated", expression: 'ROW("x",1)' },
        ],
      },
    ],
  };
}

const built = () => buildDocument(model(), new Date("2026-09-01T00:00:00Z"));

/* -------------------------------------------------------------- document --- */

test("a measure is documented under the table its DAX reads, not its home table", () => {
  const doc = built();
  const orders = doc.tables.find((t) => t.name === "Orders");
  const measures = doc.tables.find((t) => t.name === "Measures");

  assert.deepEqual(
    orders.measures.map((m) => m.name).sort(),
    ["Total Revenue", "Unique Sales"],
    "both Orders-reading measures belong under Orders"
  );
  assert.equal(measures.measures.length, 0, "nothing is filed under the storage table");
  assert.equal(orders.measures[0].homeTable, "Measures", "the home table is still recorded");
});

test("a measure with no dominant table is not filed under a guess", () => {
  const doc = built();
  const names = doc.multiTableMeasures.map((m) => m.name);
  assert.deepEqual(names, ["Cross Table"]);
  assert.deepEqual(doc.multiTableMeasures[0].allTables.sort(), ["Customer", "Orders"]);
});

test("every measure in the model appears exactly once in the document", () => {
  const doc = built();
  const placed = [
    ...doc.tables.flatMap((t) => t.measures),
    ...doc.multiTableMeasures,
    ...doc.unmappedMeasures,
  ].map((m) => `${m.homeTable}[${m.name}]`);

  assert.equal(placed.length, 3);
  assert.equal(new Set(placed).size, 3, "no measure is documented twice");
});

test("native SQL is carried through and a folded query is not invented", () => {
  const doc = built();
  const orders = doc.tables.find((t) => t.name === "Orders");
  const customer = doc.tables.find((t) => t.name === "Customer");

  assert.match(orders.nativeSql, /FROM dbo\.Orders/);
  assert.equal(customer.sqlAvailable, false);
  assert.equal(customer.nativeSql, undefined);
  assert.match(customer.sqlUnavailableReason, /folds/);
});

test("the validation gate passes on a well-formed model", () => {
  const doc = built();
  assert.ok(
    doc.validation.ok,
    "failed: " + doc.validation.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")
  );
});

test("report usage is recorded for a measure bound by a visual", () => {
  const doc = built();
  const revenue = doc.allMeasures.find((m) => m.name === "Total Revenue");
  assert.deepEqual(revenue.pages, ["Sales Overview"]);
  assert.equal(revenue.visualCount, 1);
});

test("the file name follows the requested pattern", () => {
  assert.equal(
    documentationFileName("Sales Dashboard.pbit"),
    "Sales Dashboard - Power BI Documentation.xlsx"
  );
});

/* -------------------------------------------------------------- workbook --- */

/** Build the real .xlsx, then re-open it and read it back. */
async function reopen() {
  const bytes = await buildWorkbook(built(), ExcelJS);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return { wb, bytes };
}

test("the workbook is a real xlsx with the four expected sheets", async () => {
  const { wb, bytes } = await reopen();
  assert.ok(bytes.byteLength > 5000, `suspiciously small: ${bytes.byteLength} bytes`);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Model Overview", "Table & Measure Docs", "Measure Catalogue", "Table Catalogue"]
  );
});

test("the documentation sheet contains every table and its SQL and DAX", async () => {
  const { wb } = await reopen();
  const ws = wb.getWorksheet("Table & Measure Docs");

  const text = [];
  ws.eachRow((row) => row.eachCell((cell) => text.push(String(cell.text ?? ""))));
  const all = text.join("\n");

  assert.match(all, /ORDERS/, "the Orders section header");
  assert.match(all, /CUSTOMER/);
  assert.match(all, /FROM dbo\.Orders/, "the actual source SQL");
  assert.match(all, /DISTINCTCOUNT\(Orders\[Sales_ID\]\)/, "the actual DAX");
  assert.match(all, /Calculates the distinct number of Sales_ID values/, "the definition");
  assert.match(all, /MULTI-TABLE MEASURES/);
});

test("SQL and DAX cells keep their line breaks and use a monospace font", async () => {
  const { wb } = await reopen();
  const ws = wb.getWorksheet("Table Catalogue");

  let sqlCell;
  ws.eachRow((row) => {
    const cell = row.getCell(5);
    if (String(cell.text ?? "").includes("FROM dbo.Orders")) sqlCell = cell;
  });

  assert.ok(sqlCell, "the SQL cell was not found");
  assert.ok(String(sqlCell.text).includes("\n"), "line breaks were flattened");
  assert.equal(sqlCell.font.name, "Consolas");
  assert.equal(sqlCell.alignment.wrapText, true);
  assert.equal(sqlCell.alignment.vertical, "top");
});

test("every sheet freezes its header and offers a filter where it should", async () => {
  const { wb } = await reopen();
  for (const name of ["Table & Measure Docs", "Measure Catalogue", "Table Catalogue"]) {
    const ws = wb.getWorksheet(name);
    assert.equal(ws.views[0].state, "frozen", `${name} does not freeze panes`);
    assert.ok(ws.autoFilter, `${name} has no autofilter`);
  }
});

test("the catalogues link back into the documentation sheet", async () => {
  const { wb } = await reopen();
  const ws = wb.getWorksheet("Table Catalogue");

  const links = [];
  ws.eachRow((row) => {
    const cell = row.getCell(1);
    if (cell.value && typeof cell.value === "object" && "formula" in cell.value) {
      links.push(cell.value.formula);
    }
  });

  assert.ok(links.length >= 3, `expected a link per table, got ${links.length}`);
  for (const link of links) {
    assert.match(
      link,
      /^HYPERLINK\("#'Table & Measure Docs'!A\d+","[^"]+"\)$/,
      `bad link: ${link}`
    );
  }
});

test("an in-workbook jump is not written as an external relationship", async () => {
  /*
   * ExcelJS's { text, hyperlink } cell writes TargetMode="External" with a
   * target of "#'Sheet'!A1", which Excel does not reliably resolve — the link
   * renders and goes nowhere. A HYPERLINK formula needs no relationship at
   * all, so any relationship part here means the regression is back.
   */
  const bytes = await buildWorkbook(built(), ExcelJS);
  const files = unzipSync(bytes);

  const relParts = Object.keys(files).filter((name) => name.includes("worksheets/_rels"));
  assert.deepEqual(relParts, [], `unexpected worksheet relationships: ${relParts}`);

  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith(".rels")) continue;
    assert.doesNotMatch(
      strFromU8(data),
      /TargetMode="External"/,
      `${name} points outside the workbook`
    );
  }
});

test("the measure catalogue has one row per measure and no placeholder text", async () => {
  const { wb } = await reopen();
  const ws = wb.getWorksheet("Measure Catalogue");

  const names = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    names.push(String(row.getCell(1).text));
  });

  assert.deepEqual(names.sort(), ["Cross Table", "Total Revenue", "Unique Sales"]);

  const all = [];
  ws.eachRow((row) => row.eachCell((cell) => all.push(String(cell.text ?? ""))));
  const joined = all.join("\n");
  assert.doesNotMatch(joined, /\bTODO\b|\bTBD\b|\bLorem\b|\bplaceholder\b/i);
});

test("a measure with no dominant table says so rather than naming one", async () => {
  const { wb } = await reopen();
  const ws = wb.getWorksheet("Measure Catalogue");

  let primary;
  ws.eachRow((row, n) => {
    if (n > 1 && String(row.getCell(1).text) === "Cross Table") {
      primary = String(row.getCell(3).text);
    }
  });

  assert.equal(primary, "Multiple source tables");
});
