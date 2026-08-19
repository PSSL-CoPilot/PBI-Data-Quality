/**
 * Optimization opportunities.
 *
 * Distinct from QA: these are not defects, they are things that could be
 * simplified or removed. Nothing here is executed, so an opportunity states
 * what changes structurally and never that the result will be faster.
 *
 * Deletion is never automatic. Every "unused" finding is a candidate for
 * review, because an object can be used by something this build cannot see,
 * such as a bookmark, a tooltip page or another report.
 */
import type { CapabilityId, Model, ObjectType } from "../powerbi/model.ts";
import { allColumns, allMeasures, objectKey } from "../powerbi/model.ts";
import {
  dependencyDepth,
  isColumnUnused,
  isMeasureUnused,
  type DependencyIndex,
} from "../powerbi/graph.ts";
import { countCalls, lineCount, maxNesting } from "../qa/dax.ts";
import { suggestRewrites, type Rewrite } from "./rewrite.ts";
import { allPageComplexity } from "./pages.ts";

export type Impact = "high" | "medium" | "low";
export type OptCategory = "DAX" | "Model" | "Relationship" | "Visual";

export const OPT_CATEGORIES: OptCategory[] = ["DAX", "Model", "Relationship", "Visual"];

export interface OptTarget {
  type: ObjectType;
  key: string;
  name: string;
  table?: string;
  page?: string;
}

export interface OptHit {
  target: OptTarget;
  detail: string;
  impact?: Impact;
  /** Present only where a rewrite could be generated and validated. */
  rewrite?: Rewrite;
}

export interface OptRule {
  id: string;
  title: string;
  category: OptCategory;
  impact: Impact;
  requires: CapabilityId[];
  recommendation: string;
  evaluate(model: Model, index: DependencyIndex): OptHit[];
}

const measureTarget = (m: { table: string; name: string }): OptTarget => ({
  type: "measure",
  key: objectKey("measure", m.table, m.name),
  name: m.name,
  table: m.table,
});
const columnTarget = (c: { table: string; name: string }): OptTarget => ({
  type: "column",
  key: objectKey("column", c.table, c.name),
  name: c.name,
  table: c.table,
});
const tableTarget = (t: { name: string }): OptTarget => ({
  type: "table",
  key: objectKey("table", undefined, t.name),
  name: t.name,
});
const pageTarget = (p: { name: string; displayName: string }): OptTarget => ({
  type: "page",
  key: objectKey("page", undefined, p.name),
  name: p.displayName,
  page: p.name,
});
const relTarget = (r: { name: string; fromTable: string; toTable: string }): OptTarget => ({
  type: "relationship",
  key: objectKey("relationship", undefined, r.name),
  name: r.fromTable + " -> " + r.toTable,
});

const isAutoDateTable = (name: string) =>
  name.startsWith("LocalDateTable_") || name.startsWith("DateTableTemplate_");

const GRID_VISUALS = ["tableEx", "table", "pivotTable", "matrix"];

const MODEL: CapabilityId[] = ["model"];
const REPORT: CapabilityId[] = ["report"];
const MODEL_AND_REPORT: CapabilityId[] = ["model", "report"];

// ----------------------------------------------------------- DAX optimization

const daxRules: OptRule[] = [
  {
    id: "OPT-DAX-REWRITE",
    title: "DAX can be rewritten",
    category: "DAX",
    impact: "medium",
    requires: MODEL,
    recommendation: "Review the suggested expression and apply it if it matches your intent.",
    evaluate: (model) =>
      allMeasures(model).flatMap((measure) =>
        suggestRewrites(measure.expression).map((rewrite) => ({
          target: measureTarget(measure),
          detail: rewrite.reason,
          impact: (rewrite.confidence === "high" ? "medium" : "low") as Impact,
          rewrite,
        }))
      ),
  },
  {
    id: "OPT-DAX-NESTED-BRANCHING",
    title: "Deeply nested branching",
    category: "DAX",
    impact: "medium",
    requires: MODEL,
    recommendation: "Flatten into SWITCH ( TRUE (), ... ), or lift the branches into variables.",
    evaluate: (model) =>
      allMeasures(model)
        .map((m) => ({
          m,
          depth: Math.max(maxNesting(m.expression, "IF"), maxNesting(m.expression, "SWITCH")),
        }))
        .filter(({ depth }) => depth >= 4)
        .map(({ m, depth }) => ({
          target: measureTarget(m),
          detail: `Branching is nested ${depth} levels deep.`,
        })),
  },
  {
    id: "OPT-DAX-FILTER-CALCULATE",
    title: "Many FILTER and CALCULATE calls",
    category: "DAX",
    impact: "medium",
    requires: MODEL,
    recommendation:
      "Reduce to the filters actually needed, and prefer boolean filter arguments over FILTER where possible.",
    evaluate: (model) =>
      allMeasures(model)
        .map((m) => ({
          m,
          filters: countCalls(m.expression, "FILTER"),
          calcs: countCalls(m.expression, "CALCULATE"),
        }))
        .filter(({ filters, calcs }) => filters + calcs >= 5)
        .map(({ m, filters, calcs }) => ({
          target: measureTarget(m),
          detail: `${calcs} CALCULATE and ${filters} FILTER calls in one expression.`,
        })),
  },
  {
    id: "OPT-DAX-COMPLEX",
    title: "Very complex measure",
    category: "DAX",
    impact: "medium",
    requires: MODEL,
    recommendation: "Split into intermediate measures so each part can be reviewed and reused.",
    evaluate: (model) =>
      allMeasures(model)
        .filter((m) => m.expression.length > 900 || lineCount(m.expression) > 25)
        .map((m) => ({
          target: measureTarget(m),
          detail: `${m.expression.length} characters over ${lineCount(m.expression)} lines.`,
        })),
  },
  {
    id: "OPT-DAX-LONG-CHAIN",
    title: "Long dependency chain",
    category: "DAX",
    impact: "low",
    requires: MODEL,
    recommendation:
      "Shorten the chain, or confirm each intermediate measure earns its place on its own.",
    evaluate: (model, index) =>
      allMeasures(model)
        .map((m) => ({ m, depth: dependencyDepth(index, m.name) }))
        .filter(({ depth }) => depth >= 5)
        .map(({ m, depth }) => ({
          target: measureTarget(m),
          detail: `Depends on other measures ${depth} levels deep.`,
        })),
  },
];

// --------------------------------------------------------- Model optimization

const modelRules: OptRule[] = [
  {
    id: "OPT-MOD-UNUSED-MEASURE",
    title: "Measure appears unused",
    category: "Model",
    impact: "medium",
    requires: MODEL_AND_REPORT,
    recommendation:
      "Confirm nothing outside this file uses it, then remove it. Bookmarks and tooltip pages are not visible here.",
    evaluate: (model, index) =>
      allMeasures(model)
        .filter((m) => isMeasureUnused(index, m))
        .map((m) => ({
          target: measureTarget(m),
          detail: "No visual binds it and no other measure references it.",
        })),
  },
  {
    id: "OPT-MOD-UNUSED-COLUMN",
    title: "Column appears unused",
    category: "Model",
    impact: "low",
    requires: MODEL_AND_REPORT,
    recommendation: "Confirm it is not needed, then remove it or exclude it in Power Query.",
    evaluate: (model, index) =>
      allColumns(model)
        .filter((c) => !isAutoDateTable(c.table) && isColumnUnused(index, `${c.table}[${c.name}]`))
        .map((c) => ({
          target: columnTarget(c),
          detail: "Not bound by a visual, referenced in DAX, or used as a relationship key.",
        })),
  },
  {
    id: "OPT-MOD-UNUSED-TABLE",
    title: "Table appears unused",
    category: "Model",
    impact: "high",
    requires: MODEL_AND_REPORT,
    recommendation: "Confirm it is not needed, then remove it to cut refresh time and model size.",
    evaluate: (model, index) =>
      model.tables
        .filter(
          (t) =>
            !isAutoDateTable(t.name) &&
            !index.tablesReferenced.has(t.name) &&
            t.measures.length === 0
        )
        .map((t) => ({
          target: tableTarget(t),
          detail: "Nothing references this table: no relationship, no visual, no DAX.",
        })),
  },
  {
    id: "OPT-MOD-CALCULATED-COLUMN",
    title: "Calculated column",
    category: "Model",
    impact: "low",
    requires: MODEL,
    recommendation:
      "Compute it in Power Query or in the source where possible, which keeps it out of the model.",
    evaluate: (model) =>
      allColumns(model)
        .filter((c) => c.kind === "calculated" && !isAutoDateTable(c.table))
        .map((c) => ({
          target: columnTarget(c),
          detail: "Calculated columns are stored in the model and recomputed on every refresh.",
        })),
  },
  {
    id: "OPT-MOD-HIGH-CARDINALITY",
    title: "High-cardinality column",
    category: "Model",
    impact: "medium",
    requires: MODEL,
    recommendation: "Split or round the column, or remove it if the detail is not needed.",
    // Only where the source actually reported cardinality. PBIT does not, so
    // this stays silent rather than guessing from the column name or type.
    evaluate: (model) =>
      allColumns(model)
        .filter((c) => typeof c.cardinality === "number" && c.cardinality > 1_000_000)
        .map((c) => ({
          target: columnTarget(c),
          detail: `Reported cardinality is ${c.cardinality?.toLocaleString()} distinct values.`,
        })),
  },
  {
    id: "OPT-MOD-AUTO-DATE",
    title: "Automatic date/time tables",
    category: "Model",
    impact: "high",
    requires: MODEL,
    recommendation: "Turn off Auto date/time and use one shared date dimension.",
    evaluate: (model) => {
      const auto = model.tables.filter((t) => isAutoDateTable(t.name));
      return auto.length
        ? [
            {
              target: tableTarget(auto[0]),
              detail: `${auto.length} hidden auto date/time table(s), one per date column.`,
            },
          ]
        : [];
    },
  },
];

// -------------------------------------------------- Relationship optimization

const relationshipRules: OptRule[] = [
  {
    id: "OPT-REL-MANY-TO-MANY",
    title: "Many-to-many relationship",
    category: "Relationship",
    impact: "high",
    requires: MODEL,
    recommendation: "Introduce a bridge dimension with unique keys.",
    evaluate: (model) =>
      model.relationships
        .filter((r) => r.fromCardinality === "many" && r.toCardinality === "many")
        .map((r) => ({
          target: relTarget(r),
          detail: `${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}] is many-to-many.`,
        })),
  },
  {
    id: "OPT-REL-BIDIRECTIONAL",
    title: "Bidirectional filtering",
    category: "Relationship",
    impact: "medium",
    requires: MODEL,
    recommendation:
      "Switch to single direction and use CROSSFILTER in the measures that need the other direction.",
    evaluate: (model) =>
      model.relationships
        .filter((r) => r.crossFilteringBehavior === "bothDirections")
        .map((r) => ({
          target: relTarget(r),
          detail: `${r.fromTable} and ${r.toTable} filter each other in both directions.`,
        })),
  },
  {
    id: "OPT-REL-INACTIVE",
    title: "Inactive relationship",
    category: "Relationship",
    impact: "low",
    requires: MODEL,
    recommendation: "Remove it unless a measure activates it with USERELATIONSHIP.",
    evaluate: (model) =>
      model.relationships
        .filter((r) => !r.isActive)
        .map((r) => ({
          target: relTarget(r),
          detail: `${r.fromTable} to ${r.toTable} is inactive.`,
        })),
  },
  {
    id: "OPT-REL-AMBIGUOUS-PATH",
    title: "Ambiguous filter path",
    category: "Relationship",
    impact: "high",
    requires: MODEL,
    recommendation:
      "Deactivate one relationship in the loop, or split the shared dimension, so one path remains.",
    evaluate: (model) => {
      // A cycle among active relationships means two tables are connected by
      // more than one path, which is what makes the filter direction ambiguous.
      const parent = new Map<string, string>();
      const find = (x: string): string => {
        if (!parent.has(x)) parent.set(x, x);
        const p = parent.get(x) as string;
        if (p === x) return x;
        const root = find(p);
        parent.set(x, root);
        return root;
      };

      const hits: OptHit[] = [];
      for (const rel of model.relationships.filter((r) => r.isActive)) {
        const a = find(rel.fromTable);
        const b = find(rel.toTable);
        if (a === b) {
          hits.push({
            target: relTarget(rel),
            detail: `Closes a loop: ${rel.fromTable} and ${rel.toTable} were already connected by another path.`,
          });
        } else {
          parent.set(a, b);
        }
      }
      return hits;
    },
  },
  {
    id: "OPT-REL-ORPHAN-TABLE",
    title: "Disconnected table",
    category: "Relationship",
    impact: "medium",
    requires: MODEL,
    recommendation:
      "Relate it to the model, or confirm it is a deliberate parameter or disconnected slicer table.",
    evaluate: (model) => {
      if (model.tables.length < 2) return [];
      const connected = new Set(model.relationships.flatMap((r) => [r.fromTable, r.toTable]));
      return model.tables
        .filter((t) => !connected.has(t.name) && !isAutoDateTable(t.name) && t.columns.length > 0)
        .map((t) => ({
          target: tableTarget(t),
          detail: "No relationship connects this table to the rest of the model.",
        }));
    },
  },
];

// --------------------------------------------------- Visual/page optimization

const visualRules: OptRule[] = [
  {
    id: "OPT-VIS-PAGE-COMPLEXITY",
    title: "Complex page",
    category: "Visual",
    impact: "medium",
    requires: REPORT,
    recommendation: "Split the page, or remove visuals that repeat what another already shows.",
    evaluate: (model) =>
      allPageComplexity(model)
        .filter((p) => !p.isHidden && p.score >= 60)
        .map((p) => ({
          target: pageTarget({ name: p.page, displayName: p.displayName }),
          impact: (p.score >= 80 ? "high" : "medium") as Impact,
          detail: `Complexity ${p.score}/100 (${p.band}): ${p.visuals} visuals, ${p.slicers} slicers, ${p.distinctFields} distinct fields.`,
        })),
  },
  {
    id: "OPT-VIS-MANY-SLICERS",
    title: "Many slicers on one page",
    category: "Visual",
    impact: "low",
    requires: REPORT,
    recommendation: "Move filters into the filter pane, or combine them into a hierarchy slicer.",
    evaluate: (model) =>
      allPageComplexity(model)
        .filter((p) => p.slicers > 6)
        .map((p) => ({
          target: pageTarget({ name: p.page, displayName: p.displayName }),
          detail: `${p.slicers} slicers, each re-querying when any filter changes.`,
        })),
  },
  {
    id: "OPT-VIS-LARGE-GRID",
    title: "Large table or matrix",
    category: "Visual",
    impact: "medium",
    requires: REPORT,
    recommendation: "Reduce the columns shown, or move the detail to a drillthrough page.",
    evaluate: (model) =>
      model.pages.flatMap((page) =>
        page.visuals
          .filter((v) => GRID_VISUALS.includes(v.type) && v.refs.length >= 8)
          .map((v) => ({
            target: {
              type: "visual" as ObjectType,
              key: objectKey("visual", page.name, v.id),
              name: v.title ?? v.type,
              page: page.name,
            },
            detail: `On "${page.displayName}", binds ${v.refs.length} fields.`,
          }))
      ),
  },
  {
    id: "OPT-VIS-REPEATED-MEASURE",
    title: "Complex measure repeated on a page",
    category: "Visual",
    impact: "medium",
    requires: MODEL_AND_REPORT,
    recommendation:
      "Show it once, or split the measure so the shared part is computed in one place.",
    evaluate: (model) =>
      allPageComplexity(model)
        .filter((p) => p.repeatedComplexMeasures.length > 0)
        .map((p) => ({
          target: pageTarget({ name: p.page, displayName: p.displayName }),
          detail: `${p.repeatedComplexMeasures.join(", ")} used by three or more visuals on this page.`,
        })),
  },
];

export const ALL_OPT_RULES: OptRule[] = [
  ...daxRules,
  ...modelRules,
  ...relationshipRules,
  ...visualRules,
];

/** Optimization work that needs a running engine and is therefore not done. */
export const PERFORMANCE_NOT_ASSESSED = [
  "Query and visual render timings",
  "Storage-engine versus formula-engine split per measure",
  "Column dictionary and segment sizes",
  "Refresh duration per table",
];
