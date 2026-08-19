/**
 * Page complexity.
 *
 * A transparent, additive score so a page can be argued with rather than just
 * accepted: every contribution is reported alongside the total. Higher means
 * more complex, which is the opposite direction to the quality scores.
 *
 * This measures structure only. Nothing is rendered or timed, so it is not a
 * prediction of how long the page takes to load.
 */
import type { Model, Page } from "../powerbi/model.ts";
import { allMeasures } from "../powerbi/model.ts";
import { lineCount } from "../qa/dax.ts";

/** Visual types that render a grid and grow expensive with column count. */
const GRID_VISUALS = new Set(["tableEx", "table", "pivotTable", "matrix"]);
const GRID_FIELD_THRESHOLD = 8;

const WEIGHTS = {
  visual: 2,
  slicer: 4,
  largeGrid: 6,
  distinctField: 1,
  repeatedComplexMeasure: 3,
} as const;

export interface ComplexityContribution {
  label: string;
  count: number;
  points: number;
}

export interface PageComplexity {
  page: string;
  displayName: string;
  isHidden: boolean;
  /** 0-100, higher is more complex. */
  score: number;
  band: "simple" | "moderate" | "complex" | "very complex";
  contributions: ComplexityContribution[];
  visuals: number;
  slicers: number;
  distinctFields: number;
  largeGrids: number;
  repeatedComplexMeasures: string[];
}

function band(score: number): PageComplexity["band"] {
  if (score < 30) return "simple";
  if (score < 60) return "moderate";
  if (score < 80) return "complex";
  return "very complex";
}

/** Measures whose DAX is long enough that repeating them across a page matters. */
function complexMeasureNames(model: Model): Set<string> {
  return new Set(
    allMeasures(model)
      .filter((m) => m.expression.length > 400 || lineCount(m.expression) > 12)
      .map((m) => m.name)
  );
}

export function pageComplexity(model: Model, page: Page): PageComplexity {
  const complexMeasures = complexMeasureNames(model);

  const slicers = page.visuals.filter((v) => v.type === "slicer").length;
  const largeGrids = page.visuals.filter(
    (v) => GRID_VISUALS.has(v.type) && v.refs.length >= GRID_FIELD_THRESHOLD
  ).length;

  const distinctFields = new Set(
    page.visuals.flatMap((v) => v.refs.map((r) => `${r.table ?? ""}[${r.field}]`))
  ).size;

  // A complex measure bound by several visuals is queried once per visual.
  const measureUse = new Map<string, number>();
  for (const visual of page.visuals) {
    for (const name of new Set(
      visual.refs.filter((r) => r.kind === "measure").map((r) => r.field)
    )) {
      measureUse.set(name, (measureUse.get(name) ?? 0) + 1);
    }
  }
  const repeatedComplexMeasures = [...measureUse.entries()]
    .filter(([name, uses]) => uses >= 3 && complexMeasures.has(name))
    .map(([name]) => name);

  const contributions: ComplexityContribution[] = [
    { label: "Visuals", count: page.visuals.length, points: page.visuals.length * WEIGHTS.visual },
    { label: "Slicers", count: slicers, points: slicers * WEIGHTS.slicer },
    { label: "Large tables or matrices", count: largeGrids, points: largeGrids * WEIGHTS.largeGrid },
    { label: "Distinct fields bound", count: distinctFields, points: distinctFields * WEIGHTS.distinctField },
    {
      label: "Repeated complex measures",
      count: repeatedComplexMeasures.length,
      points: repeatedComplexMeasures.length * WEIGHTS.repeatedComplexMeasure,
    },
  ];

  const total = contributions.reduce((sum, c) => sum + c.points, 0);
  const score = Math.max(0, Math.min(100, total));

  return {
    page: page.name,
    displayName: page.displayName,
    isHidden: page.isHidden,
    score,
    band: band(score),
    contributions,
    visuals: page.visuals.length,
    slicers,
    distinctFields,
    largeGrids,
    repeatedComplexMeasures,
  };
}

/** Complexity for every page, most complex first. Hidden pages are included
 *  but ranked last, since they do not load for report readers. */
export function allPageComplexity(model: Model): PageComplexity[] {
  return model.pages
    .map((page) => pageComplexity(model, page))
    .sort((a, b) => Number(a.isHidden) - Number(b.isHidden) || b.score - a.score);
}
