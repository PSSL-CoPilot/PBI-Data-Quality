import assert from "node:assert/strict";
import test from "node:test";

import {
  analyseSql,
  dialectFromConnector,
  maskSql,
  SQL_RULE_CATALOGUE,
} from "../lib/optimize/sql.ts";

const find = (sql, ctx = {}) => analyseSql(sql, { dialect: "sqlserver", ...ctx });
const ids = (sql, ctx) => find(sql, ctx).map((f) => f.ruleId);
const one = (sql, id, ctx) => find(sql, ctx).find((f) => f.ruleId === id);

// ------------------------------------------------------------------ masking --

test("comments and string literals cannot raise findings", () => {
  // Each of these would be a false positive for a naive text search.
  assert.deepEqual(ids("SELECT a FROM t WHERE b = 1 -- SELECT * FROM everything"), []);
  assert.deepEqual(ids("SELECT a FROM t WHERE b = 1 /* ORDER BY x */"), []);
  assert.deepEqual(
    ids("SELECT a FROM t WHERE note = 'we used to SELECT * here'"),
    [],
    "a statement inside a literal is data, not code"
  );
});

test("masking preserves offsets so rewrites splice correctly", () => {
  const sql = "SELECT a FROM t -- note\nWHERE b = 1";
  assert.equal(maskSql(sql).length, sql.length);
  assert.equal(maskSql(sql).split("\n").length, sql.split("\n").length);
});

// ------------------------------------------------------------------ dialect --

test("the dialect comes from the connector that produced the query", () => {
  assert.equal(dialectFromConnector("Sql.Database"), "sqlserver");
  assert.equal(dialectFromConnector("PostgreSQL.Database"), "postgres");
  assert.equal(dialectFromConnector("GoogleBigQuery.Database"), "bigquery");
  assert.equal(dialectFromConnector("Odbc.Query"), "generic");
});

test("a SQL Server rule is not applied to another dialect", () => {
  const sql = "SELECT a FROM t WITH (NOLOCK) WHERE b = 1";
  assert.ok(ids(sql, { dialect: "sqlserver" }).includes("SQL-NOLOCK"));
  assert.ok(
    !ids(sql, { dialect: "postgres" }).includes("SQL-NOLOCK"),
    "NOLOCK means nothing to PostgreSQL"
  );
});

test("selecting every column costs more where the source bills by bytes scanned", () => {
  const sql = "SELECT * FROM dbo.Orders WHERE Active = 1";
  assert.equal(one(sql, "SQL-SELECT-STAR", { dialect: "sqlserver" }).impact, "medium");
  const bq = one(sql, "SQL-SELECT-STAR", { dialect: "bigquery" });
  assert.equal(bq.impact, "high");
  assert.match(bq.detail, /BigQuery/);
});

// ------------------------------------------------------------------ rewrites --

test("SELECT * expands to the columns the model actually loaded", () => {
  const sql = "SELECT * FROM dbo.Orders WHERE Active = 1";
  const finding = one(sql, "SQL-SELECT-STAR", { columns: ["OrderID", "Order Date", "Amount"] });

  assert.equal(finding.rewrite.confidence, "high");
  assert.equal(
    finding.rewrite.suggested,
    "SELECT OrderID, [Order Date], Amount FROM dbo.Orders WHERE Active = 1"
  );
  assert.ok(finding.rewrite.behaviourChange, "the trade-off is stated, not hidden");
});

test("SELECT * is advisory when the columns are unknown", () => {
  const finding = one("SELECT * FROM dbo.Orders WHERE x = 1", "SQL-SELECT-STAR");
  assert.equal(finding.rewrite, undefined, "nothing is invented without the column list");
});

test("a trailing ORDER BY is removed, but not one that decides which rows arrive", () => {
  const removable = one("SELECT a FROM t WHERE b = 1 ORDER BY a", "SQL-ORDER-BY");
  assert.equal(removable.rewrite.suggested, "SELECT a FROM t WHERE b = 1");

  // With TOP the ordering selects the rows, so removing it changes the result.
  assert.equal(
    one("SELECT TOP 10 a FROM t ORDER BY a DESC", "SQL-ORDER-BY"),
    undefined,
    "ORDER BY with a row limit must be left alone"
  );
  assert.equal(
    one("SELECT a FROM t ORDER BY a LIMIT 5", "SQL-ORDER-BY", { dialect: "postgres" }),
    undefined
  );
});

test("YEAR(col) = literal becomes a half-open date range", () => {
  const finding = one("SELECT a FROM t WHERE YEAR(OrderDate) = 2026", "SQL-NON-SARGABLE-YEAR");
  assert.equal(
    finding.rewrite.suggested,
    "SELECT a FROM t WHERE OrderDate >= '2026-01-01' AND OrderDate < '2027-01-01'"
  );
  assert.equal(finding.rewrite.confidence, "medium");
  assert.match(finding.rewrite.behaviourChange, /text/i, "the string-column caveat is stated");
});

test("DISTINCT is dropped only when GROUP BY already deduplicates", () => {
  const finding = one("SELECT DISTINCT a, COUNT(*) FROM t GROUP BY a", "SQL-REDUNDANT-DISTINCT");
  assert.equal(finding.rewrite.suggested, "SELECT a, COUNT(*) FROM t GROUP BY a");

  assert.equal(
    one("SELECT DISTINCT a FROM t", "SQL-REDUNDANT-DISTINCT"),
    undefined,
    "DISTINCT without GROUP BY is doing real work"
  );
});

// ----------------------------------------------------------------- advisory --

test("non-sargable and scan-forcing patterns are reported without a rewrite", () => {
  for (const [sql, id] of [
    ["SELECT a FROM t WHERE UPPER(Name) = 'X'", "SQL-NON-SARGABLE-FUNCTION"],
    ["SELECT a FROM t WHERE Name LIKE '%smith'", "SQL-LEADING-WILDCARD"],
    ["SELECT a FROM t WHERE CustomerId = '42'", "SQL-IMPLICIT-CONVERSION"],
    ["SELECT a FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)", "SQL-CORRELATED-SUBQUERY"],
    ["SELECT a FROM (SELECT * FROM u) x WHERE a = 1", "SQL-NESTED-SELECT-STAR"],
  ]) {
    const finding = one(sql, id);
    assert.ok(finding, `${id} should fire`);
    assert.equal(finding.rewrite, undefined, `${id} must stay advisory`);
  }
});

test("a query with no filter is reported, and a limited one is not", () => {
  assert.ok(one("SELECT a FROM dbo.BigTable", "SQL-NO-FILTER"));
  assert.equal(one("SELECT a FROM t WHERE x = 1", "SQL-NO-FILTER"), undefined);
  assert.equal(one("SELECT TOP 100 a FROM t", "SQL-NO-FILTER"), undefined);
});

test("many joins are reported only past a threshold", () => {
  const four = "SELECT a FROM t JOIN b ON 1=1 JOIN c ON 1=1 JOIN d ON 1=1 WHERE x=1";
  assert.equal(one(four, "SQL-MANY-JOINS"), undefined);
  const six = four.replace("WHERE", "JOIN e ON 1=1 JOIN f ON 1=1 JOIN g ON 1=1 WHERE");
  assert.ok(one(six, "SQL-MANY-JOINS"));
});

// ------------------------------------------------------------------ honesty --

test("every rule explains itself and cites a source", () => {
  for (const rule of SQL_RULE_CATALOGUE) {
    assert.ok(rule.why.length > 30, `${rule.id} needs a real explanation`);
    assert.ok(rule.recommendation.length > 10, `${rule.id} needs a recommendation`);
    assert.match(rule.source.url, /^https:\/\/learn\.microsoft\.com\//, `${rule.id} source`);
  }
});

test("no rule claims a measured speed-up", () => {
  const prose = SQL_RULE_CATALOGUE.map((r) => `${r.why} ${r.recommendation}`).join(" ");
  // Nothing here is executed or timed, so nothing may promise a time saving.
  assert.doesNotMatch(prose, /\b\d+\s*(x|times)\s*faster\b/i);
  assert.doesNotMatch(prose, /\bwill be faster\b/i);
  assert.doesNotMatch(prose, /\bspeeds? up\b/i);
});

test("a clean query produces nothing", () => {
  assert.deepEqual(
    ids("SELECT OrderID, Amount FROM dbo.Orders WHERE OrderDate >= '2026-01-01'"),
    []
  );
});

// ------------------------------------------------------- applying a rewrite --

test("applying a SQL rewrite edits the M and refreshes the derived statement", async () => {
  const { extract } = await import("../lib/powerbi/extract.ts");
  const { runOptimization, rewriteAsChange, safeRewrites } = await import(
    "../lib/optimize/engine.ts"
  );
  const { newSession, addChange, workingModel } = await import("../lib/edit/session.ts");
  const { zipSync } = await import("fflate");

  const u16 = (v, bom = true) => {
    const t = (bom ? "\uFEFF" : "") + JSON.stringify(v);
    const o = new Uint8Array(t.length * 2);
    const d = new DataView(o.buffer);
    for (let i = 0; i < t.length; i++) d.setUint16(i * 2, t.charCodeAt(i), true);
    return o;
  };

  const schema = {
    name: "M",
    compatibilityLevel: 1567,
    model: {
      culture: "en-US",
      tables: [
        {
          name: "Orders",
          columns: [{ name: "OrderID", dataType: "int64" }, { name: "Amount", dataType: "decimal" }],
          measures: [],
          partitions: [
            {
              name: "p",
              mode: "import",
              source: {
                type: "m",
                expression: [
                  "let",
                  '    Source = Sql.Database("srv", "Sales", [Query="SELECT *#(lf)FROM dbo.Orders#(lf)WHERE Active = 1"])',
                  "in",
                  "    Source",
                ],
              },
            },
          ],
        },
      ],
      relationships: [],
    },
  };

  const { model } = await extract(
    "t.pbit",
    zipSync({
      Version: u16("1.30", false),
      DataModelSchema: u16(schema),
      "Report/Layout": u16({ id: 1, sections: [] }),
    })
  );

  const star = safeRewrites(runOptimization(model)).find((o) => o.ruleId === "SQL-SELECT-STAR");
  assert.ok(star, "the SELECT * rewrite is offered");

  const change = rewriteAsChange(star, "c1", 0, model);
  assert.equal(change.target.type, "partition");
  // The change carries the whole M expression, which is what export writes back.
  assert.match(change.after, /Sql\.Database/);
  assert.match(change.after, /SELECT OrderID, Amount/);

  const after = workingModel(addChange(newSession(model), change)).model.tables[0].partitions[0];

  // The derived statement must be recomputed, or every SQL view keeps showing
  // the query that was just replaced.
  assert.match(after.nativeQuery.sql, /^SELECT OrderID, Amount/);
  assert.doesNotMatch(after.nativeQuery.sql, /SELECT \*/);

  // And the finding must be gone on a re-run, which is what "optimized" means.
  const again = runOptimization(after ? workingModel(addChange(newSession(model), change)).model : model);
  assert.ok(!again.opportunities.some((o) => o.ruleId === "SQL-SELECT-STAR"));
});
