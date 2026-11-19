import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLineage, excludedFromPage, isKpiVisual, listKpis } from "../lib/lineage/graph.ts";

/**
 * A report page with the things that must be told apart:
 *
 *   - two cards that display measures          -> KPIs
 *   - a slicer bound to a column               -> not a KPI
 *   - a slicer that binds a measure            -> still not a KPI
 *   - a textbox and a button                   -> not KPIs
 *   - a table visual binding only columns      -> not a KPI
 *
 * and a measure chain: Unique Sales -> Order Count, both reading Orders,
 * which loads from dbo.Orders.
 */
function model() {
  const visual = (id, type, title, refs) => ({
    id, page: "p1", type, title, x: 0, y: 0, width: 100, height: 60, refs,
  });
  const m = (name, expression) => ({ name, table: "Measures", expression, isHidden: false });
  const col = (name, table) => ({
    name, table, dataType: "string", kind: "data", isHidden: false, isKey: false,
  });

  return {
    source: { fileName: "r.pbit", format: "pbit", sizeBytes: 1, extractedAt: "" },
    capabilities: { model: { available: true }, report: { available: true } },
    relationships: [], expressions: [], roles: [], warnings: [],
    pages: [{
      name: "p1", displayName: "Sales Overview", ordinal: 0, isHidden: false,
      width: 1280, height: 720,
      visuals: [
        visual("v1", "card", "Unique Sales", [{ table: "Measures", field: "Unique Sales", kind: "measure" }]),
        visual("v2", "card", "Total Revenue", [{ table: "Measures", field: "Total Revenue", kind: "measure" }]),
        visual("v3", "slicer", "Region", [{ table: "Orders", field: "Region", kind: "column" }]),
        visual("v4", "slicer", "Sneaky", [{ table: "Measures", field: "Unique Sales", kind: "measure" }]),
        visual("v5", "textbox", "A heading", []),
        visual("v6", "actionButton", "Go", []),
        visual("v7", "tableEx", "Raw rows", [{ table: "Orders", field: "Order_ID", kind: "column" }]),
      ],
    }],
    tables: [
      {
        name: "Orders", kind: "table", isHidden: false, hierarchies: [], measures: [],
        columns: [col("Order_ID", "Orders"), col("Sales_ID", "Orders"), col("Revenue", "Orders"), col("Region", "Orders")],
        partitions: [{
          name: "p", table: "Orders", mode: "import", sourceType: "m", expression: "let x=1 in x",
          nativeQuery: { kind: "native", connector: "GoogleBigQuery.Database", sql: "SELECT Order_ID, Sales_ID, Revenue FROM analytics.orders" },
        }],
      },
      {
        name: "Measures", kind: "table", isHidden: false, hierarchies: [], columns: [],
        measures: [
          m("Unique Sales", "DISTINCTCOUNT(Orders[Sales_ID]) + [Order Count]"),
          m("Order Count", "COUNTROWS(Orders)"),
          m("Total Revenue", "SUM(Orders[Revenue])"),
          m("Unused", "SUM(Orders[Revenue]) * 2"),
        ],
        partitions: [{ name: "mp", table: "Measures", sourceType: "calculated", expression: 'ROW("x",1)' }],
      },
    ],
  };
}

const g = () => buildLineage(model());
const ids = (graph, kind) => graph.nodes.filter((n) => n.kind === kind).map((n) => n.label).sort();

/* ------------------------------------------------------- what is a KPI --- */

test("a card that displays a measure is a KPI", () => {
  const v = model().pages[0].visuals.find((x) => x.id === "v1");
  assert.equal(isKpiVisual(v), true);
});

test("a slicer is never a KPI, even when it binds a measure", () => {
  const visuals = model().pages[0].visuals;
  assert.equal(isKpiVisual(visuals.find((v) => v.id === "v3")), false, "column slicer");
  assert.equal(isKpiVisual(visuals.find((v) => v.id === "v4")), false, "measure-bound slicer");
});

test("text boxes and buttons are not KPIs", () => {
  const visuals = model().pages[0].visuals;
  assert.equal(isKpiVisual(visuals.find((v) => v.id === "v5")), false);
  assert.equal(isKpiVisual(visuals.find((v) => v.id === "v6")), false);
});

test("a visual binding only columns reports no number, so it is not a KPI", () => {
  const v = model().pages[0].visuals.find((x) => x.id === "v7");
  assert.equal(isKpiVisual(v), false);
});

test("only the two real KPIs are listed", () => {
  assert.deepEqual(listKpis(model()).map((k) => k.label).sort(), ["Total Revenue", "Unique Sales"]);
});

test("what was excluded is reported rather than silently dropped", () => {
  const types = excludedFromPage(model(), "p1").map((e) => e.type).sort();
  assert.deepEqual(types, ["actionButton", "slicer", "tableEx", "textbox"]);
  const slicer = excludedFromPage(model(), "p1").find((e) => e.type === "slicer");
  assert.equal(slicer.count, 2);
  assert.match(slicer.reason, /filter or navigation/i);
});

/* ----------------------------------------------------------- the chain --- */

test("the full chain source -> table -> measure -> KPI is present", () => {
  const graph = g();
  assert.deepEqual(ids(graph, "source"), ["analytics.orders"]);
  assert.deepEqual(ids(graph, "table"), ["Orders"]);
  assert.deepEqual(ids(graph, "kpi"), ["Total Revenue", "Unique Sales"]);
  assert.ok(ids(graph, "measure").includes("Unique Sales"));
});

test("arrows run in the direction the data moves", () => {
  const graph = g();
  const kind = (k) => graph.edges.filter((e) => e.kind === k);

  const loads = kind("loads")[0];
  assert.ok(loads.from.startsWith("source:"), "source feeds the table");
  assert.ok(loads.to.startsWith("table:"));

  const feeds = kind("feeds")[0];
  assert.ok(feeds.from.startsWith("table:"), "table feeds the measure");
  assert.ok(feeds.to.startsWith("measure:"));

  const displays = kind("displays")[0];
  assert.ok(displays.from.startsWith("measure:"), "measure feeds the KPI");
  assert.ok(displays.to.startsWith("kpi:"));
});

test("a measure that calls another pulls it into the graph, callee feeding caller", () => {
  const graph = g();
  assert.ok(ids(graph, "measure").includes("Order Count"), "the called measure is included");

  const call = graph.edges.find((e) => e.kind === "calls");
  assert.ok(call, "no call edge found");
  assert.match(call.from, /Order Count/, "the callee is the source of the arrow");
  assert.match(call.to, /Unique Sales/, "the caller is the target");
});

test("a measure no KPI reaches is left out", () => {
  // "Unused" is a real measure, but nothing on the page displays it.
  assert.equal(ids(g(), "measure").includes("Unused"), false);
});

/* --------------------------------------------------------- KPI to KPI --- */

test("KPIs whose measures depend on each other are linked", () => {
  // Unique Sales calls [Order Count]; nothing links it to Total Revenue.
  const graph = buildLineage({
    ...model(),
    pages: [{
      ...model().pages[0],
      visuals: [
        { id: "a", page: "p1", type: "card", title: "Unique Sales", x: 0, y: 0, width: 1, height: 1,
          refs: [{ table: "Measures", field: "Unique Sales", kind: "measure" }] },
        { id: "b", page: "p1", type: "card", title: "Order Count", x: 0, y: 0, width: 1, height: 1,
          refs: [{ table: "Measures", field: "Order Count", kind: "measure" }] },
      ],
    }],
  });

  const related = graph.edges.filter((e) => e.kind === "related");
  assert.equal(related.length, 1, "exactly one KPI-to-KPI link");
  assert.match(related[0].reason, /calls/);
});

test("two KPIs showing the same measure are linked as moving together", () => {
  const base = model();
  const graph = buildLineage({
    ...base,
    pages: [{
      ...base.pages[0],
      visuals: [
        { id: "a", page: "p1", type: "card", title: "Revenue A", x: 0, y: 0, width: 1, height: 1,
          refs: [{ table: "Measures", field: "Total Revenue", kind: "measure" }] },
        { id: "b", page: "p1", type: "kpi", title: "Revenue B", x: 0, y: 0, width: 1, height: 1,
          refs: [{ table: "Measures", field: "Total Revenue", kind: "measure" }] },
      ],
    }],
  });

  const related = graph.edges.filter((e) => e.kind === "related");
  assert.equal(related.length, 1);
  assert.match(related[0].reason, /Both display/);
});

test("unrelated KPIs are not linked", () => {
  const related = g().edges.filter((e) => e.kind === "related");
  // Unique Sales and Total Revenue share no measure and neither calls the other.
  assert.deepEqual(related, []);
});

/* ------------------------------------------------------------- scoping --- */

test("focusing one KPI keeps only its own lineage", () => {
  const all = g();
  const target = all.nodes.find((n) => n.kind === "kpi" && n.label === "Total Revenue");
  const focused = buildLineage(model(), { focusKpi: target.id });

  assert.deepEqual(ids(focused, "kpi"), ["Total Revenue"]);
  assert.deepEqual(ids(focused, "measure"), ["Total Revenue"], "only the measure it displays");
  assert.ok(ids(focused, "table").includes("Orders"), "its table is still shown");
});

test("every edge points at nodes that exist", () => {
  const graph = g();
  const present = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    assert.ok(present.has(e.from), `dangling edge source: ${e.from}`);
    assert.ok(present.has(e.to), `dangling edge target: ${e.to}`);
  }
});

test("every edge carries a reason, so no arrow is unexplained", () => {
  for (const e of g().edges) {
    assert.ok(e.reason && e.reason.length > 0, `edge ${e.from}->${e.to} has no reason`);
  }
});

/* ------------------------------------------------ layout regression --- */

test("same-column arcs are not clipped by the canvas width", async () => {
  const { layoutLineage } = await import("../lib/lineage/layout.ts");
  // Two KPIs showing the same measure produce a related arc that bows out to
  // the right of the last column. The canvas must be wide enough to show it;
  // before this it was sized from the columns alone and cut the arc off.
  const base = model();
  const graph = buildLineage({
    ...base,
    pages: [{
      ...base.pages[0],
      visuals: [
        { id: "a", page: "p1", type: "card", title: "A", x: 0, y: 0, width: 1, height: 1,
          refs: [{ table: "Measures", field: "Total Revenue", kind: "measure" }] },
        { id: "b", page: "p1", type: "card", title: "B", x: 0, y: 0, width: 1, height: 1,
          refs: [{ table: "Measures", field: "Total Revenue", kind: "measure" }] },
      ],
    }],
  });

  const L = layoutLineage(graph);
  const arcs = L.edges.filter((e) => e.sameColumn);
  assert.ok(arcs.length > 0, "expected a same-column arc");

  for (const arc of arcs) {
    // Every coordinate in the path must fall inside the canvas.
    const xs = [...arc.d.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    const maxX = Math.max(...xs);
    assert.ok(maxX <= L.width, `arc reaches x=${maxX} but canvas is only ${L.width} wide`);
  }
});

test("every node sits inside the canvas bounds", async () => {
  const { layoutLineage, NODE_W, NODE_H } = await import("../lib/lineage/layout.ts");
  const L = layoutLineage(g());
  for (const n of L.nodes) {
    assert.ok(n.x >= 0 && n.x + NODE_W <= L.width, `${n.label} escapes horizontally`);
    assert.ok(n.y >= 0 && n.y + NODE_H <= L.height, `${n.label} escapes vertically`);
  }
});
