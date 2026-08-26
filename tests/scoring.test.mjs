import assert from "node:assert/strict";
import test from "node:test";

import { affectedShare, categoryScore, overallScore, populationFor } from "../lib/scoring.ts";
import { runQa } from "../lib/qa/engine.ts";

const available = () => ({ available: true });
const unavailable = (reason) => ({ available: false, reason });

/** A report-only model with `pages` pages, each holding `visuals` visuals. */
function reportModel(pages, visualsPerPage) {
  return {
    source: { fileName: "r.pbix", format: "pbix", sizeBytes: 1, extractedAt: "2026-01-01T00:00:00Z" },
    capabilities: {
      model: unavailable("binary DataModel"),
      report: available(),
      powerQuery: unavailable("binary DataModel"),
      runtime: unavailable("no engine"),
    },
    tables: [],
    relationships: [],
    expressions: [],
    pages: Array.from({ length: pages }, (_, p) => ({
      name: `s${p}`,
      displayName: `Page ${p}`,
      ordinal: p,
      isHidden: false,
      width: 1280,
      height: 720,
      visuals: Array.from({ length: visualsPerPage }, (_, v) => ({
        id: `p${p}v${v}`,
        page: `s${p}`,
        type: "card",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        refs: [],
      })),
    })),
    warnings: [],
  };
}

test("an object is counted once, at its worst severity", () => {
  // Three findings on one object is one damaged object, not three.
  const share = affectedShare([
    { key: "measure:T[A]", severity: "low" },
    { key: "measure:T[A]", severity: "high" },
    { key: "measure:T[A]", severity: "low" },
  ]);
  assert.equal(share, 0.6, "the worst severity wins and does not accumulate");
});

test("a score is the share of examined objects that are clean", () => {
  // Half of ten objects damaged at "high" = 10 - 3 clean-equivalents.
  const affected = affectedShare(
    Array.from({ length: 5 }, (_, i) => ({ key: `m${i}`, severity: "high" }))
  );
  assert.equal(affected, 3);
  assert.equal(categoryScore(1, affected, 10), 70);
});

test("nothing to examine scores null, never a free 100", () => {
  assert.equal(categoryScore(0, 0, 10), null, "no rule ran");
  assert.equal(categoryScore(1, 0, 0), null, "no objects to judge");
  assert.equal(categoryScore(1, 0, 5), 100, "rules ran and found nothing");
});

test("overall ignores unassessed categories rather than scoring them zero", () => {
  assert.equal(overallScore([80, null, null]), 80);
  assert.equal(overallScore([null, null]), null);
  assert.equal(overallScore([100, 50]), 75);
});

test("the score does not collapse as a report gets bigger", () => {
  // The regression this replaced: absolute penalties drove a large report to 0
  // while a small one with the identical defect rate scored in the nineties.
  const small = runQa(reportModel(2, 40)).overall;
  const large = runQa(reportModel(16, 40)).overall;

  assert.equal(
    small,
    large,
    `same defect rate must score the same at any size (small ${small}, large ${large})`
  );
  assert.ok(large > 0, "a fully-flagged report is not automatically zero");
});

test("a cleaner report scores higher than a worse one of the same size", () => {
  const clean = runQa(reportModel(10, 5)).overall;
  const busy = runQa(reportModel(10, 40)).overall;
  assert.ok(clean > busy, `clean ${clean} should beat busy ${busy}`);
  assert.equal(clean, 100, "no page over the threshold means nothing to report");
});

test("population is the set of objects a category could have flagged", () => {
  const model = reportModel(7, 1);
  assert.equal(populationFor(model, "Report"), 7, "pages");
  assert.equal(populationFor(model, "Relationship"), 0, "no relationships to judge");
  assert.equal(populationFor(model, "DAX"), 0, "no measures without a model");
});
