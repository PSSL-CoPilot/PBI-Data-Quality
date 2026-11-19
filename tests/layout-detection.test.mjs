import assert from "node:assert/strict";
import { test } from "node:test";

import { zipSync } from "fflate";

import { detectFormat, extract, looksLikePbir } from "../lib/powerbi/extract.ts";

/** UTF-16LE with a BOM, which is how Power BI writes its JSON parts. */
function utf16(value, withBom = true) {
  const text = (withBom ? "﻿" : "") + JSON.stringify(value);
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}

const SCHEMA = {
  name: "M",
  compatibilityLevel: 1567,
  model: {
    culture: "en-US",
    tables: [
      {
        name: "Orders",
        columns: [{ name: "Revenue", dataType: "double" }],
        measures: [{ name: "Total Revenue", expression: "SUM ( Orders[Revenue] )" }],
        partitions: [{ name: "p", source: { type: "m", expression: "let x = 1 in x" } }],
      },
    ],
    relationships: [],
  },
};

const LAYOUT = {
  id: 0,
  sections: [
    { name: "s1", displayName: "Sales", ordinal: 0, width: 1280, height: 720, visualContainers: [] },
  ],
};

const build = (files) => new Uint8Array(zipSync(files));

/* ------------------------------------------------------ casing tolerance --- */

test("a layout part stored with different casing is still found", async () => {
  /*
   * `has("Report/Layout")` was an exact, case-sensitive match, so an archive
   * written by a tool that cased it differently reported "no report layout
   * part" — indistinguishable from a file that genuinely has no report.
   */
  for (const name of ["Report/Layout", "Report/layout", "report/Layout", "REPORT/LAYOUT"]) {
    const bytes = build({ Version: utf16("1.30", false), DataModelSchema: utf16(SCHEMA), [name]: utf16(LAYOUT) });
    const { model } = await extract("t.pbit", bytes);
    assert.equal(model.capabilities.report.available, true, `layout named ${name} was not found`);
    assert.equal(model.pages.length, 1, `layout named ${name} produced no pages`);
  }
});

test("a leading slash on the part name does not hide it", async () => {
  const bytes = build({ Version: utf16("1.30", false), DataModelSchema: utf16(SCHEMA), "/Report/Layout": utf16(LAYOUT) });
  const { model } = await extract("t.pbit", bytes);
  assert.equal(model.capabilities.report.available, true);
  assert.equal(model.pages.length, 1);
});

/* ----------------------------------------------------------------- PBIR --- */

const PBIR_FILES = {
  Version: utf16("1.30", false),
  DataModelSchema: utf16(SCHEMA),
  "Report/definition/pages/pages.json": utf16({ pageOrder: ["p1"], activePageName: "p1" }),
  "Report/definition/pages/p1/page.json": utf16({ name: "p1", displayName: "Sales", width: 1280, height: 720 }),
  "Report/definition/pages/p1/visuals/v1/visual.json": utf16({ name: "v1", position: { x: 0, y: 0, width: 200, height: 100 } }),
};

test("a PBIR archive is recognised as PBIR", () => {
  assert.equal(looksLikePbir(Object.keys(PBIR_FILES)), true);
  assert.equal(looksLikePbir(["Report/Layout", "DataModelSchema"]), false);
});

test("a PBIR report says so by name instead of claiming there is no report", async () => {
  const { model } = await extract("t.pbit", build(PBIR_FILES));

  assert.equal(model.capabilities.report.available, false);
  const reason = model.capabilities.report.reason;

  assert.match(reason, /PBIR/, "the format is named");
  assert.match(reason, /definition\/pages/, "where the pages actually live is stated");
  assert.match(reason, /pages are present/i, "it does not claim the file has no pages");
  assert.doesNotMatch(
    reason,
    /contains no report layout part/,
    "the generic fallback must not be used when the cause is known"
  );
});

test("the model is still read from a PBIR file, so only the report is lost", async () => {
  const { model } = await extract("t.pbit", build(PBIR_FILES));
  assert.equal(model.capabilities.model.available, true);
  assert.equal(model.tables.length, 1);
  assert.equal(model.tables[0].measures.length, 1);
});

/* --------------------------------------------------------- archive parts --- */

test("every archive part name is retained for diagnosis", async () => {
  const { raw } = await extract("t.pbit", build(PBIR_FILES));
  assert.deepEqual(raw.partNames.sort(), Object.keys(PBIR_FILES).sort());
});

test("a genuinely report-less archive still gets the generic reason", async () => {
  const bytes = build({ Version: utf16("1.30", false), DataModelSchema: utf16(SCHEMA) });
  const { model } = await extract("t.pbit", bytes);
  assert.equal(model.capabilities.report.available, false);
  assert.match(model.capabilities.report.reason, /contains no report layout part/);
});

test("detectFormat returns the real part name, not the one searched for", () => {
  const detected = detectFormat(["DataModelSchema", "Report/layout"]);
  assert.equal(detected.layoutPath, "Report/layout", "the archive's own spelling must be used");
});
