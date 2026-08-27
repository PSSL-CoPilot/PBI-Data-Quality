/**
 * A synthetic .pbit big enough to feel.
 *
 * Real Power BI files that hurt are not the ones with a hundred objects; they
 * are the ones with a few hundred measures spread over a dozen pages, each
 * page dense with visuals. This produces that shape so a change can be timed
 * against something representative rather than against a toy.
 *
 * Usage: node scripts/make-fixture.mjs [outPath] [scale]
 */
import { writeFileSync } from "node:fs";
import { zipSync } from "fflate";

const out = process.argv[2] ?? "public/__big.pbit";
const scale = Number(process.argv[3] ?? 1);

const TABLES = Math.round(30 * scale);
const COLUMNS_PER_TABLE = 25;
const MEASURES = Math.round(300 * scale);
const PAGES = Math.round(16 * scale);
const VISUALS_PER_PAGE = 55;

/** UTF-16LE with a BOM, which is how Power BI writes both JSON parts. */
function utf16(value, withBom = true) {
  const text = (withBom ? "﻿" : "") + JSON.stringify(value);
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}

const tableName = (i) => `Fact_${String(i).padStart(3, "0")}`;
const columnName = (i) => `Col_${String(i).padStart(2, "0")}`;
const measureName = (i) => `MSR_${String(i).padStart(4, "0")}_Amt`;

/* ---------------------------------------------------------------- model --- */

const tables = [];

for (let t = 0; t < TABLES; t++) {
  const name = tableName(t);
  const columns = Array.from({ length: COLUMNS_PER_TABLE }, (_, c) => ({
    name: columnName(c),
    dataType: c % 5 === 0 ? "int64" : c % 3 === 0 ? "dateTime" : "string",
  }));

  // A native statement in every third table, so the SQL paths get exercised.
  const select = columns.map((c) => `    [${c.name}]`).join(",#(lf)");
  const source =
    t % 3 === 0
      ? {
          type: "m",
          expression: [
            "let",
            `    Source = Sql.Database("warehouse.internal", "Sales", [Query="SELECT#(lf)${select}#(lf)FROM dbo.${name}#(lf)WHERE [Col_00] IS NOT NULL"])`,
            "in",
            "    Source",
          ],
        }
      : {
          // A folded query: no statement in the file, and none may be invented.
          type: "m",
          expression: [
            "let",
            `    Source = Sql.Database("warehouse.internal", "Sales"),`,
            `    Nav = Source{[Schema="dbo",Item="${name}"]}[Data],`,
            `    Filtered = Table.SelectRows(Nav, each [${columnName(0)}] <> null)`,
            "in",
            "    Filtered",
          ],
        };

  tables.push({
    name,
    columns,
    measures: [],
    partitions: [{ name: `${name}-p`, mode: "import", source }],
  });
}

// One shared measures table, which is what most real models end up with.
const measures = [];
for (let m = 0; m < MEASURES; m++) {
  const host = tableName(m % TABLES);
  const column = columnName(m % COLUMNS_PER_TABLE);
  // Every fifth measure calls another, to give the dependency index real work.
  const expression =
    m % 5 === 0 && m > 0
      ? `DIVIDE ( [${measureName(m - 1)}], COUNTROWS ( ${host} ) )`
      : m % 7 === 0
        ? `CALCULATE ( SUM ( ${host}[${column}] ), FILTER ( ${host}, ${host}[${column}] > 0 ) )`
        : `SUM ( ${host}[${column}] )`;

  measures.push({
    name: measureName(m),
    expression,
    ...(m % 4 === 0 ? {} : { formatString: "#,0.00" }),
  });
}

tables.push({
  name: "Measures",
  columns: [],
  measures,
  partitions: [{ name: "measures-p", source: { type: "calculated", expression: 'ROW ( "x", 1 )' } }],
});

const relationships = [];
for (let t = 1; t < TABLES; t++) {
  relationships.push({
    name: `rel-${t}`,
    fromTable: tableName(t),
    fromColumn: columnName(0),
    toTable: tableName(0),
    toColumn: columnName(0),
    fromCardinality: "many",
    toCardinality: "one",
    crossFilteringBehavior: t % 9 === 0 ? "bothDirections" : "oneDirection",
    isActive: t % 11 !== 0,
  });
}

const schema = {
  name: "BigModel",
  compatibilityLevel: 1567,
  model: { culture: "en-US", tables, relationships },
};

/* --------------------------------------------------------------- report --- */

const sections = [];
for (let p = 0; p < PAGES; p++) {
  const visualContainers = [];

  for (let v = 0; v < VISUALS_PER_PAGE; v++) {
    const index = (p * VISUALS_PER_PAGE + v) % MEASURES;
    const title = `KPI ${p + 1}.${v + 1} — ${["Revenue", "Orders", "Margin", "Units"][v % 4]}`;

    visualContainers.push({
      x: (v % 6) * 210,
      y: Math.floor(v / 6) * 120,
      z: v,
      width: 200,
      height: 110,
      config: JSON.stringify({
        name: `p${p}v${v}`,
        singleVisual: {
          visualType: ["card", "barChart", "lineChart", "table"][v % 4],
          prototypeQuery: {
            Version: 2,
            From: [{ Name: "m", Entity: "Measures", Type: 0 }],
            Select: [
              {
                Measure: { Expression: { SourceRef: { Source: "m" } }, Property: measureName(index) },
                Name: `Measures.${measureName(index)}`,
              },
            ],
          },
          vcObjects: {
            title: [{ properties: { text: { expr: { Literal: { Value: `'${title}'` } } } } }],
          },
        },
      }),
    });
  }

  sections.push({
    name: `s${p}`,
    displayName: `Page ${p + 1}`,
    ordinal: p,
    width: 1280,
    height: 720,
    visualContainers,
  });
}

const layout = { id: 0, sections };

const bytes = zipSync({
  Version: utf16("1.30", false),
  DataModelSchema: utf16(schema),
  "Report/Layout": utf16(layout),
  // Parts this build never parses; they must survive an export untouched.
  "Report/StaticResources/note.txt": new TextEncoder().encode("carried across verbatim"),
  DiagramLayout: utf16({ version: 1, diagrams: [] }),
});

writeFileSync(out, bytes);

console.log(
  `${out}: ${TABLES + 1} tables, ${MEASURES} measures, ${PAGES} pages, ` +
    `${PAGES * VISUALS_PER_PAGE} visuals, ${(bytes.length / 1024).toFixed(0)} KB`
);
