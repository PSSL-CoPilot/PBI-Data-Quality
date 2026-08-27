import assert from "node:assert/strict";
import { test } from "node:test";

import { findUsage, UsageIndex } from "../lib/powerbi/usage.ts";

/** A model with the binding shapes that actually turn up in a Layout. */
function model() {
  const visual = (id, refs) => ({
    id,
    page: "p1",
    type: "card",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    refs,
  });

  return {
    tables: [],
    relationships: [],
    pages: [
      {
        name: "p1",
        displayName: "Sales",
        ordinal: 0,
        isHidden: false,
        width: 1280,
        height: 720,
        visuals: [
          visual("v1", [{ table: "Orders", field: "Revenue", kind: "measure" }]),
          visual("v2", [{ field: "Revenue", kind: "measure" }]),
          visual("v3", [{ table: "Other", field: "Revenue", kind: "measure" }]),
          visual("v4", [{ table: "Orders", field: "Revenue", kind: "column" }]),
        ],
      },
      {
        name: "p2",
        displayName: "Detail",
        ordinal: 1,
        isHidden: false,
        width: 1280,
        height: 720,
        visuals: [visual("v5", [{ table: "Orders", field: "Revenue", kind: "measure" }])],
      },
    ],
    capabilities: { model: { available: true }, report: { available: true } },
    source: { fileName: "t.pbit", format: "pbit", sizeBytes: 0 },
  };
}

/** The index must agree with the walk it replaces, or it is just a faster bug. */
const cases = [
  ["measure", "Orders", "Revenue"],
  ["measure", undefined, "Revenue"],
  ["measure", "Other", "Revenue"],
  ["column", "Orders", "Revenue"],
  ["measure", "Orders", "Missing"],
  ["measure", "Nothing", "Revenue"],
];

test("the index returns exactly what findUsage returns", () => {
  const m = model();
  const index = new UsageIndex(m);

  for (const [kind, table, field] of cases) {
    const walked = findUsage(m, kind, table, field);
    const indexed = index.find(kind, table, field);

    assert.equal(
      indexed.visualCount,
      walked.visualCount,
      `visual count differs for ${kind}/${table}/${field}`
    );
    assert.deepEqual(
      indexed.pages.slice().sort(),
      walked.pages.slice().sort(),
      `pages differ for ${kind}/${table}/${field}`
    );
    assert.deepEqual(
      indexed.hits.map((h) => h.visual.id).sort(),
      walked.hits.map((h) => h.visual.id).sort(),
      `hits differ for ${kind}/${table}/${field}`
    );
  }
});

test("a qualified lookup still sees a binding that names no table", () => {
  const index = new UsageIndex(model());
  // v1 names Orders, v2 names nothing; both are Revenue and both must count.
  assert.deepEqual(
    index.find("measure", "Orders", "Revenue").hits.map((h) => h.visual.id).sort(),
    ["v1", "v2", "v5"]
  );
});

test("a qualified lookup does not see another table's binding", () => {
  const index = new UsageIndex(model());
  assert.equal(
    index.find("measure", "Orders", "Revenue").hits.some((h) => h.visual.id === "v3"),
    false
  );
});

test("kind is respected, so a column never answers a measure lookup", () => {
  const index = new UsageIndex(model());
  assert.equal(
    index.find("measure", "Orders", "Revenue").hits.some((h) => h.visual.id === "v4"),
    false
  );
});
