import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeMString,
  findNativeQuery,
  replaceNativeQuery,
  tokenizeM,
} from "../lib/powerbi/nativequery.ts";
import { groupMeasuresByPage } from "../lib/powerbi/sources.ts";

const wrap = (body) => `let\n${body}\nin\n    Source`;

// ------------------------------------------------------------ finding SQL --

test("native SQL is found in a Sql.Database Query option", () => {
  const m = wrap('    Source = Sql.Database("srv", "db", [Query="SELECT a FROM t"])');
  const found = findNativeQuery(m);
  assert.equal(found.kind, "native");
  assert.equal(found.query.sql, "SELECT a FROM t");
  assert.equal(found.query.connector, "Sql.Database");
});

test("native SQL is found in Value.NativeQuery, Odbc.Query and OleDb.Query", () => {
  const cases = [
    ['Value.NativeQuery(Src, "SELECT 1", null, [EnableFolding=true])', "Value.NativeQuery"],
    ['Odbc.Query(Conn, "SELECT 2")', "Odbc.Query"],
    ['OleDb.Query(Conn, "SELECT 3")', "OleDb.Query"],
  ];
  for (const [call, connector] of cases) {
    const found = findNativeQuery(wrap(`    Source = ${call}`));
    assert.equal(found.kind, "native", `${connector} should yield a statement`);
    assert.equal(found.query.connector, connector);
  }
});

test("a folded query reports why rather than inventing SQL", () => {
  const m = wrap(
    '    Source = Sql.Database("srv", "db"),\n' +
      '    Data = Source{[Schema="dbo",Item="Orders"]}[Data],\n' +
      "    Filtered = Table.SelectRows(Data, each [Active] = true)"
  );
  const found = findNativeQuery(m);
  assert.equal(found.kind, "folded");
  assert.equal(found.connector, "Sql.Database");
  assert.match(found.reason, /folding/i);
  assert.ok(!("sql" in found), "a folded result must not carry a statement");
});

test("a non-relational source is reported as having no query", () => {
  const found = findNativeQuery('let Source = Excel.Workbook(File.Contents("c:/x.xlsx")) in Source');
  assert.equal(found.kind, "none");
  assert.match(found.reason, /no relational connector/i);
});

test("a Query= inside a comment or a string is never mistaken for the real one", () => {
  // The only real connector here folds, so a comment must not promote it.
  const commented = wrap('    // Query="SELECT fake"\n    Source = Sql.Database("srv", "db")');
  assert.equal(findNativeQuery(commented).kind, "folded");

  const inString = wrap('    Source = Sql.Database("srv", "db"),\n    Note = "Query=""SELECT fake"""');
  assert.equal(findNativeQuery(inString).kind, "folded");
});

// ------------------------------------------------------------- M escaping --

test("M escape sequences are decoded so multi-line SQL reads as SQL", () => {
  const m = wrap('    Source = Sql.Database("s", "d", [Query="SELECT a,#(lf)       b#(lf)FROM t"])');
  const { sql } = findNativeQuery(m).query;
  assert.equal(sql, "SELECT a,\n       b\nFROM t");
  assert.equal(sql.split("\n").length, 3);
});

test("editing SQL rewrites only the statement and survives a round trip", () => {
  const m = wrap('    Source = Sql.Database("s", "d", [Query="SELECT 1"])');

  // Writing back what was read must not alter a single character.
  assert.equal(replaceNativeQuery(m, findNativeQuery(m).query.sql), m);

  const edited = replaceNativeQuery(m, 'SELECT OrderID\nFROM dbo.Orders\nWHERE Name = "q"');
  assert.match(edited, /#\(lf\)/, "newlines are re-encoded the way M expects");
  assert.match(edited, /""q""/, "quotes are doubled");
  // Everything around the statement is untouched.
  assert.match(edited, /Sql\.Database\("s", "d", \[Query=/);
  assert.match(edited, /^let\n/);

  assert.equal(findNativeQuery(edited).query.sql, 'SELECT OrderID\nFROM dbo.Orders\nWHERE Name = "q"');
});

test("a hash in the SQL is escaped so it cannot be read back as an escape", () => {
  const m = wrap('    Source = Sql.Database("s", "d", [Query="SELECT 1"])');
  const edited = replaceNativeQuery(m, "SELECT * FROM #temp");
  assert.equal(findNativeQuery(edited).query.sql, "SELECT * FROM #temp");
});

test("encodeMString escapes the hash before the escapes it introduces", () => {
  assert.equal(encodeMString("a#b"), '"a#(#)b"');
  assert.equal(encodeMString("a\nb"), '"a#(lf)b"');
});

test("the tokenizer keeps comments and identifiers apart from strings", () => {
  const tokens = tokenizeM('let /* c */ x = "s", #"odd name" = 1 in x');
  const kinds = tokens.filter((t) => t.kind === "string").map((t) => t.value);
  assert.deepEqual(kinds, ["s"], "the comment contributes no tokens");
  assert.ok(tokens.some((t) => t.kind === "identifier" && t.value === '#"odd name"'));
});

// ------------------------------------------------- report page → measures --

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

function reportOnlyModel() {
  const visual = (id, type, measures, title) => ({
    id,
    page: "s1",
    type,
    title,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    refs: measures.map((name) => ({ table: "KPIs", field: name, kind: "measure" })),
  });

  return {
    source: { fileName: "r.pbix", format: "pbix", sizeBytes: 1, extractedAt: "2026-01-01T00:00:00Z" },
    capabilities: {
      // Exactly the .pbix case: the report is readable, the model is not.
      model: unavailable("binary DataModel"),
      report: available(),
      powerQuery: unavailable("binary DataModel"),
      runtime: unavailable("no engine"),
    },
    tables: [],
    relationships: [],
    expressions: [],
    pages: [
      {
        name: "s1",
        displayName: "Executive Dashboard",
        ordinal: 0,
        isHidden: false,
        width: 1280,
        height: 720,
        visuals: [
          visual("v1", "card", ["M Unique Sales"], "Unique Sales KPI"),
          visual("v2", "lineChart", ["Gross Margin %", "Revenue"], "Margin Chart"),
        ],
      },
    ],
    warnings: [],
  };
}

test("report bindings survive when the model cannot be read", () => {
  const [page] = groupMeasuresByPage(reportOnlyModel());

  assert.equal(page.displayName, "Executive Dashboard");
  assert.equal(page.visuals.length, 2);

  // This is the regression that made the feature look broken: bindings were
  // found correctly, then dropped because no table could be matched.
  assert.deepEqual(
    page.measures.map((m) => m.name),
    ["Gross Margin %", "M Unique Sales", "Revenue"]
  );
  assert.deepEqual(page.visuals[0].measures.map((m) => m.name), ["M Unique Sales"]);
  assert.deepEqual(page.visuals[1].measures.map((m) => m.name), ["Gross Margin %", "Revenue"]);
  assert.equal(page.visuals[0].title, "Unique Sales KPI");
  assert.equal(page.visuals[0].measures[0].boundTable, "KPIs");
  assert.equal(page.visuals[0].measures[0].measure, undefined, "no DAX without a model");

  // "unresolved" is meaningless without a model and must not be filled in.
  assert.deepEqual(page.unresolved, []);
});
