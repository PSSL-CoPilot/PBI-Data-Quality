import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLineage, kpiNamer, listKpis } from "../lib/lineage/graph.ts";
import { commonTitle, isGlossaryPage, nameKpi, readGlossary } from "../lib/lineage/kpiname.ts";

/* ----------------------------------------------------- the shared title --- */

test("the KPI name is the words every title shares, not one of the variants", () => {
  assert.equal(
    commonTitle([
      "Churn Percentage",
      "Churn Percentage monthly view",
      "Churn Percentage daily view",
    ]),
    "Churn Percentage"
  );
});

test("a single visual keeps its whole title", () => {
  assert.equal(commonTitle(["Disconnects"]), "Disconnects");
});

test("the prefix is whole words, never a part of one", () => {
  // A character-wise prefix of these is "Churn P", which is not a name.
  assert.equal(commonTitle(["Churn Percentage", "Churn Pct"]), "Churn");
});

test("titles with nothing in common yield no name", () => {
  assert.equal(commonTitle(["Churn", "Attrition Rate"]), undefined);
});

test("a trailing separator is not part of the name", () => {
  assert.equal(commonTitle(["Revenue - monthly", "Revenue - daily"]), "Revenue");
});

test("the measure name is used when the titles share nothing", () => {
  const result = nameKpi(["Churn", "Attrition"], "Churn_Pct", new Map());
  assert.equal(result.name, "Churn_Pct");
  assert.equal(result.source, "measure");
});

/* ---------------------------------------------------------- the glossary --- */

const page = (displayName, texts) => ({
  name: displayName.toLowerCase(),
  displayName,
  ordinal: 0,
  isHidden: false,
  width: 1280,
  height: 720,
  visuals: texts.map((text, i) => ({
    id: `t${i}`,
    page: displayName,
    type: "textbox",
    text,
    x: 0,
    y: i * 40,
    width: 400,
    height: 30,
    refs: [],
  })),
});

const withPages = (pages) => ({
  source: { fileName: "r.pbit", format: "pbit", sizeBytes: 1, extractedAt: "" },
  capabilities: { model: { available: true }, report: { available: true } },
  tables: [], relationships: [], expressions: [], roles: [], warnings: [],
  pages,
});

test("a glossary page is recognised by its name", () => {
  for (const name of ["Glossary", "KPI Definitions", "Data Dictionary", "Terminology"]) {
    assert.equal(isGlossaryPage(name), true, name);
  }
  assert.equal(isGlossaryPage("Sales Overview"), false);
});

test("terms are read from a 'Term: definition' glossary", () => {
  const model = withPages([
    page("Glossary", [
      "Churn Rate: the share of subscribers who left in the period",
      "Disconnects: the count of accounts closed",
    ]),
  ]);
  const terms = [...readGlossary(model).values()].sort();
  assert.deepEqual(terms, ["Churn Rate", "Disconnects"]);
});

test("terms are read from a one-box-per-term glossary", () => {
  const model = withPages([page("KPI Definitions", ["Churn Rate", "Disconnects"])]);
  assert.deepEqual([...readGlossary(model).values()].sort(), ["Churn Rate", "Disconnects"]);
});

test("a definition is never mistaken for a term", () => {
  const model = withPages([
    page("Glossary", [
      "This page explains each measure used in the report. Refer to it when in doubt.",
    ]),
  ]);
  assert.deepEqual([...readGlossary(model).values()], []);
});

test("pages that are not a glossary are ignored", () => {
  const model = withPages([page("Sales Overview", ["Churn Rate: something"])]);
  assert.deepEqual([...readGlossary(model).values()], []);
});

test("the glossary outranks the shared title", () => {
  const glossary = new Map([["churn percentage", "Churn Rate"]]);
  const result = nameKpi(
    ["Churn Percentage monthly", "Churn Percentage daily"],
    "Churn_Pct",
    glossary
  );
  assert.equal(result.name, "Churn Rate", "the report's own word wins");
  assert.equal(result.source, "glossary");
  assert.match(result.reason, /glossary/i);
});

test("a glossary term is matched exactly, never by prefix", () => {
  // Matching "Revenue Growth %" against a "Revenue" entry would file one KPI
  // under another's name, which is worse than not using the glossary.
  const glossary = new Map([["revenue", "Revenue"]]);
  const result = nameKpi(["Revenue Growth %"], "Rev_Growth", glossary);
  assert.equal(result.name, "Revenue Growth %");
  assert.equal(result.source, "titles");
});

test("the glossary also matches on the measure name", () => {
  const glossary = new Map([["churn pct", "Churn Rate"]]);
  const result = nameKpi([], "Churn Pct", glossary);
  assert.equal(result.name, "Churn Rate");
  assert.equal(result.source, "glossary");
});

/* ------------------------------------------------------- through the app --- */

function report({ glossary = false } = {}) {
  const card = (id, title, field, y) => ({
    id, page: "p1", type: "card", title, x: 0, y, width: 200, height: 100,
    refs: [{ table: "Measures", field, kind: "measure" }],
  });

  const pages = [
    {
      name: "p1", displayName: "Churn", ordinal: 0, isHidden: false, width: 1280, height: 720,
      visuals: [
        card("v1", "Churn Percentage", "Churn Pct", 0),
        card("v2", "Churn Percentage monthly view", "Churn Pct", 120),
        card("v3", "Churn Percentage daily view", "Churn Pct", 240),
        card("v4", "Disconnects", "Disconnect Count", 360),
      ],
    },
  ];
  if (glossary) pages.push(page("Glossary", ["Churn Percentage: share of subscribers lost"]));

  return {
    source: { fileName: "r.pbit", format: "pbit", sizeBytes: 1, extractedAt: "" },
    capabilities: { model: { available: true }, report: { available: true } },
    relationships: [], expressions: [], roles: [], warnings: [],
    pages,
    tables: [
      {
        name: "Subs", kind: "table", isHidden: false, hierarchies: [], measures: [],
        columns: [{ name: "Churned", table: "Subs", dataType: "int64", kind: "data", isHidden: false, isKey: false }],
        partitions: [{ name: "p", table: "Subs", mode: "import", sourceType: "m", expression: "let x=1 in x" }],
      },
      {
        name: "Measures", kind: "table", isHidden: false, hierarchies: [], columns: [],
        measures: [
          { name: "Churn Pct", table: "Measures", expression: "SUM(Subs[Churned])", isHidden: false },
          { name: "Disconnect Count", table: "Measures", expression: "COUNTROWS(Subs)", isHidden: false },
        ],
        partitions: [{ name: "mp", table: "Measures", sourceType: "calculated", expression: 'ROW("x",1)' }],
      },
    ],
  };
}

test("the selector offers KPI names, never the view variants", () => {
  const names = [...new Set(listKpis(report()).map((k) => k.kpiName))].sort();
  assert.deepEqual(names, ["Churn Percentage", "Disconnects"]);
  assert.equal(
    names.some((n) => /monthly|daily|view/i.test(n)),
    false,
    "a variant leaked into the KPI names"
  );
});

test("the diagram's KPI nodes carry the same names the selector offers", () => {
  const graph = buildLineage(report());
  const nodes = graph.nodes.filter((n) => n.kind === "kpi").map((n) => n.label).sort();
  const offered = [...new Set(listKpis(report()).map((k) => k.kpiName))].sort();
  assert.deepEqual(nodes, offered, "the selector and the diagram must agree");
});

test("three views of one KPI stay one KPI with three visuals", () => {
  const graph = buildLineage(report());
  const churn = graph.nodes.find((n) => n.kind === "kpi" && n.label === "Churn Percentage");
  assert.equal(churn.sublabel, "3 visuals");
  assert.equal(graph.nodes.filter((n) => n.kind === "visual").length, 4);
});

test("a glossary page renames the KPI and says where the name came from", () => {
  const graph = buildLineage(report({ glossary: true }));
  const churn = graph.nodes.find((n) => n.kind === "kpi" && /churn/i.test(n.label));
  assert.equal(churn.label, "Churn Percentage");
  assert.equal(churn.sublabel, "from the glossary");
  assert.match(churn.detail, /glossary/i);
});

test("the namer is stable, so repeated calls cannot drift", () => {
  const model = report();
  const a = kpiNamer(model).forMeasure("Churn Pct");
  const b = kpiNamer(model).forMeasure("Churn Pct");
  assert.deepEqual(a, b);
});
