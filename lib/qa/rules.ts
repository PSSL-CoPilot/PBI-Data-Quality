/**
 * The QA rule catalogue.
 *
 * Every rule declares the capabilities it needs. A rule whose capability is
 * unavailable is reported as *skipped with a reason* — never as passing. That
 * distinction is what keeps a report-only PBIX from scoring 100 on DAX quality
 * because no DAX could be read.
 */
import type { CapabilityId, Model, ObjectType } from "../powerbi/model.ts";
import { allColumns, allMeasures, objectKey } from "../powerbi/model.ts";
import {
  countCalls,
  lineCount,
  maxNesting,
  referencedColumns,
  referencedMeasures,
  stripNoise,
  timeIntelligenceUsed,
  usesDivisionOperator,
} from "./dax.ts";

export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "DAX" | "Model" | "Relationship" | "Report" | "Data";

export const CATEGORIES: Category[] = ["DAX", "Model", "Relationship", "Report", "Data"];

export interface FindingTarget {
  type: ObjectType;
  key: string;
  name: string;
  table?: string;
  page?: string;
}

export interface RuleHit {
  target: FindingTarget;
  detail: string;
  /** Overrides the rule default when the same rule spans severities. */
  severity?: Severity;
}

export interface Rule {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  requires: CapabilityId[];
  recommendation: string;
  evaluate(model: Model): RuleHit[];
}

const measureTarget = (m: { table: string; name: string }): FindingTarget => ({
  type: "measure",
  key: objectKey("measure", m.table, m.name),
  name: m.name,
  table: m.table,
});

const tableTarget = (t: { name: string }): FindingTarget => ({
  type: "table",
  key: objectKey("table", undefined, t.name),
  name: t.name,
});

const pageTarget = (p: { name: string; displayName: string }): FindingTarget => ({
  type: "page",
  key: objectKey("page", undefined, p.name),
  name: p.displayName,
  page: p.name,
});

const relationshipTarget = (r: { name: string; fromTable: string; toTable: string }): FindingTarget => ({
  type: "relationship",
  key: objectKey("relationship", undefined, r.name),
  name: `${r.fromTable} → ${r.toTable}`,
});

/** Power BI's automatic date hierarchy generates one hidden table per date column. */
const isAutoDateTable = (name: string) =>
  name.startsWith("LocalDateTable_") || name.startsWith("DateTableTemplate_");

const MODEL: CapabilityId[] = ["model"];
const REPORT: CapabilityId[] = ["report"];
const MODEL_AND_REPORT: CapabilityId[] = ["model", "report"];

// ---------------------------------------------------------------- DAX quality

const daxRules: Rule[] = [
  {
    id: "DAX-DIVISION",
    title: "Division operator instead of DIVIDE",
    category: "DAX",
    severity: "high",
    requires: MODEL,
    recommendation:
      "Replace `a / b` with `DIVIDE ( a, b )`, adding an explicit alternate result if blank is not wanted.",
    evaluate: (model) =>
      allMeasures(model)
        .filter((m) => usesDivisionOperator(m.expression))
        .map((m) => ({
          target: measureTarget(m),
          detail: "Uses the `/` operator, which errors or returns infinity when the denominator is zero or blank.",
        })),
  },
  {
    id: "DAX-NESTED-IF",
    title: "Deeply nested IF",
    category: "DAX",
    severity: "medium",
    requires: MODEL,
    recommendation: "Flatten the branches into a single SWITCH ( TRUE (), ... ) or split into variables.",
    evaluate: (model) =>
      allMeasures(model)
        .map((m) => ({ m, depth: maxNesting(m.expression, "IF") }))
        .filter(({ depth }) => depth >= 4)
        .map(({ m, depth }) => ({
          target: measureTarget(m),
          detail: `IF is nested ${depth} levels deep, which is hard to read and to verify.`,
        })),
  },
  {
    id: "DAX-IF-CHAIN",
    title: "Long IF chain",
    category: "DAX",
    severity: "medium",
    requires: MODEL,
    recommendation: "Use SWITCH, which evaluates the tested expression once and reads as a table of cases.",
    evaluate: (model) =>
      allMeasures(model)
        .map((m) => ({ m, count: countCalls(m.expression, "IF") }))
        .filter(({ m, count }) => count >= 5 && countCalls(m.expression, "SWITCH") === 0)
        .map(({ m, count }) => ({
          target: measureTarget(m),
          detail: `Calls IF ${count} times with no SWITCH.`,
        })),
  },
  {
    id: "DAX-NESTED-CALCULATE",
    title: "Nested CALCULATE",
    category: "DAX",
    severity: "medium",
    requires: MODEL,
    recommendation:
      "Extract the inner context transitions into separate measures or variables so the filter context is explicit.",
    evaluate: (model) =>
      allMeasures(model)
        .map((m) => ({ m, depth: maxNesting(m.expression, "CALCULATE") }))
        .filter(({ depth }) => depth >= 3)
        .map(({ m, depth }) => ({
          target: measureTarget(m),
          detail: `CALCULATE is nested ${depth} levels deep, making the effective filter context hard to reason about.`,
        })),
  },
  {
    id: "DAX-FILTER-WHOLE-TABLE",
    title: "FILTER over an entire table",
    category: "DAX",
    severity: "medium",
    requires: MODEL,
    recommendation:
      "Filter the specific column instead of the table, or pass a boolean filter argument directly to CALCULATE.",
    evaluate: (model) => {
      const tableNames = new Set(model.tables.map((t) => t.name));
      return allMeasures(model)
        .flatMap((m) => {
          const text = stripNoise(m.expression);
          // FILTER ( <bare table reference> , ... ) — a column would have `[`.
          const hits = [...text.matchAll(/\bFILTER\s*\(\s*([A-Za-z_]\w*)\s*,/gi)]
            .map((match) => match[1])
            .filter((name) => tableNames.has(name));
          return hits.length
            ? [
                {
                  target: measureTarget(m),
                  detail: `FILTER scans the whole ${[...new Set(hits)].join(", ")} table rather than a column.`,
                },
              ]
            : [];
        });
    },
  },
  {
    id: "DAX-COMPLEX-MEASURE",
    title: "Very complex measure",
    category: "DAX",
    severity: "medium",
    requires: MODEL,
    recommendation:
      "Break the expression into named VARs or intermediate measures so each part can be tested on its own.",
    evaluate: (model) =>
      allMeasures(model)
        .filter((m) => m.expression.length > 900 || lineCount(m.expression) > 25)
        .map((m) => ({
          target: measureTarget(m),
          detail: `The expression is ${m.expression.length} characters over ${lineCount(m.expression)} lines.`,
        })),
  },
  {
    id: "DAX-NO-FORMAT",
    title: "Measure has no format string",
    category: "DAX",
    severity: "low",
    requires: MODEL,
    recommendation: "Set an explicit format string so every visual renders the value consistently.",
    evaluate: (model) =>
      allMeasures(model)
        .filter((m) => !m.formatString && !m.isHidden)
        .map((m) => ({
          target: measureTarget(m),
          detail: "No format string is set, so each visual falls back to a default format.",
        })),
  },
];

// -------------------------------------------------------------- Model quality

const modelRules: Rule[] = [
  {
    id: "MOD-NO-DESCRIPTION",
    title: "Measure is undocumented",
    category: "Model",
    severity: "low",
    requires: MODEL,
    recommendation: "Describe the business definition, grain and any assumptions.",
    evaluate: (model) =>
      allMeasures(model)
        .filter((m) => !m.description?.trim() && !m.isHidden)
        .map((m) => ({ target: measureTarget(m), detail: "The measure has no description." })),
  },
  {
    id: "MOD-TABLE-NO-DESCRIPTION",
    title: "Table is undocumented",
    category: "Model",
    severity: "low",
    requires: MODEL,
    recommendation: "Describe what the table holds and its grain.",
    evaluate: (model) =>
      model.tables
        .filter((t) => !t.description?.trim() && !t.isHidden && !isAutoDateTable(t.name))
        .map((t) => ({ target: tableTarget(t), detail: "The table has no description." })),
  },
  {
    id: "MOD-AUTO-DATE-TABLES",
    title: "Automatic date/time tables",
    category: "Model",
    severity: "medium",
    requires: MODEL,
    recommendation:
      "Turn off Auto date/time and use one shared date dimension marked as the date table.",
    evaluate: (model) => {
      const auto = model.tables.filter((t) => isAutoDateTable(t.name));
      // One finding for the whole model: a per-table list would be noise.
      return auto.length
        ? [
            {
              target: tableTarget(auto[0]),
              detail: `${auto.length} hidden auto date/time table(s) exist, one per date column. They inflate model size and cannot be shared across tables.`,
            },
          ]
        : [];
    },
  },
  {
    id: "MOD-NAME-COLLISION",
    title: "Measure and column share a name",
    category: "Model",
    severity: "medium",
    requires: MODEL,
    recommendation: "Rename one of them so DAX and report field references stay unambiguous.",
    evaluate: (model) => {
      const columnNames = new Map(allColumns(model).map((c) => [c.name, c.table]));
      return allMeasures(model)
        .filter((m) => columnNames.has(m.name))
        .map((m) => ({
          target: measureTarget(m),
          detail: `A column named "${m.name}" also exists on ${columnNames.get(m.name)}.`,
        }));
    },
  },
];

// ------------------------------------------------------- Relationship quality

const relationshipRules: Rule[] = [
  {
    id: "REL-MANY-TO-MANY",
    title: "Many-to-many relationship",
    category: "Relationship",
    severity: "high",
    requires: MODEL,
    recommendation:
      "Introduce a bridge dimension with unique keys so the join direction and filter behaviour are explicit.",
    evaluate: (model) =>
      model.relationships
        .filter((r) => r.fromCardinality === "many" && r.toCardinality === "many")
        .map((r) => ({
          target: relationshipTarget(r),
          detail: `${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}] is many-to-many, which can produce ambiguous or inflated totals.`,
        })),
  },
  {
    id: "REL-BIDIRECTIONAL",
    title: "Bidirectional cross-filtering",
    category: "Relationship",
    severity: "medium",
    requires: MODEL,
    recommendation:
      "Use single-direction filtering and apply CROSSFILTER only in the measures that genuinely need it.",
    evaluate: (model) =>
      model.relationships
        .filter((r) => r.crossFilteringBehavior === "bothDirections")
        .map((r) => ({
          target: relationshipTarget(r),
          detail: `${r.fromTable} ↔ ${r.toTable} filters both ways, which can create ambiguous filter paths.`,
        })),
  },
  {
    id: "REL-INACTIVE",
    title: "Inactive relationship",
    category: "Relationship",
    severity: "low",
    requires: MODEL,
    recommendation:
      "Confirm a measure activates it with USERELATIONSHIP, otherwise remove it.",
    evaluate: (model) =>
      model.relationships
        .filter((r) => !r.isActive)
        .map((r) => ({
          target: relationshipTarget(r),
          detail: `${r.fromTable} → ${r.toTable} is inactive and only applies inside USERELATIONSHIP.`,
        })),
  },
  {
    id: "REL-ORPHAN-TABLE",
    title: "Disconnected table",
    category: "Relationship",
    severity: "high",
    requires: MODEL,
    recommendation:
      "Relate the table to the model, or confirm it is intentionally standalone (a parameter or disconnected slicer table).",
    evaluate: (model) => {
      if (model.tables.length < 2) return [];
      const connected = new Set(
        model.relationships.flatMap((r) => [r.fromTable, r.toTable])
      );
      return model.tables
        .filter(
          (t) =>
            !connected.has(t.name) &&
            !isAutoDateTable(t.name) &&
            // A measure-only table has no columns and is a normal pattern.
            t.columns.length > 0
        )
        .map((t) => ({
          target: tableTarget(t),
          detail: "The table has no relationships, so it cannot filter or be filtered by the rest of the model.",
        }));
    },
  },
];

// ------------------------------------------------------------- Report quality

const VISUALS_BUSY = 20;
const VISUALS_CROWDED = 30;
const SLICERS_BUSY = 6;

const reportRules: Rule[] = [
  {
    id: "REP-BROKEN-FIELD",
    title: "Visual references a missing field",
    category: "Report",
    severity: "critical",
    requires: MODEL_AND_REPORT,
    recommendation:
      "Repoint the visual at an existing field, or restore the object the report expects.",
    evaluate: (model) => {
      const measures = new Set(allMeasures(model).map((m) => `${m.table}[${m.name}]`));
      const measureNames = new Set(allMeasures(model).map((m) => m.name));
      const columns = new Set(allColumns(model).map((c) => `${c.table}[${c.name}]`));
      const columnNames = new Set(allColumns(model).map((c) => c.name));

      const hits: RuleHit[] = [];
      for (const page of model.pages) {
        for (const visual of page.visuals) {
          for (const ref of visual.refs) {
            if (ref.kind !== "measure" && ref.kind !== "column") continue;
            const qualified = `${ref.table}[${ref.field}]`;
            const known =
              ref.kind === "measure"
                ? measures.has(qualified) || measureNames.has(ref.field)
                : columns.has(qualified) || columnNames.has(ref.field);
            if (known) continue;
            hits.push({
              target: {
                type: "visual",
                key: objectKey("visual", page.name, visual.id),
                name: visual.title ?? visual.type,
                page: page.name,
              },
              detail: `On "${page.displayName}", this visual binds ${ref.kind} ${qualified}, which does not exist in the model.`,
            });
          }
        }
      }
      return hits;
    },
  },
  {
    id: "REP-PAGE-TOO-MANY-VISUALS",
    title: "Page has too many visuals",
    category: "Report",
    severity: "medium",
    requires: REPORT,
    recommendation:
      "Split the page, or replace repeated cards with a single visual that shows the same values.",
    evaluate: (model) =>
      model.pages
        .filter((p) => p.visuals.length > VISUALS_BUSY)
        .map((p) => ({
          target: pageTarget(p),
          severity: (p.visuals.length > VISUALS_CROWDED ? "high" : "medium") as Severity,
          detail: `${p.visuals.length} visuals on one page. Each one issues its own queries on load.`,
        })),
  },
  {
    id: "REP-PAGE-TOO-MANY-SLICERS",
    title: "Page has many slicers",
    category: "Report",
    severity: "low",
    requires: REPORT,
    recommendation: "Consolidate filters into the filter pane or a single hierarchy slicer.",
    evaluate: (model) =>
      model.pages
        .filter((p) => p.visuals.filter((v) => v.type === "slicer").length > SLICERS_BUSY)
        .map((p) => ({
          target: pageTarget(p),
          detail: `${p.visuals.filter((v) => v.type === "slicer").length} slicers, each re-querying when any filter changes.`,
        })),
  },
  {
    id: "REP-EMPTY-PAGE",
    title: "Page has no visuals",
    category: "Report",
    severity: "low",
    requires: REPORT,
    recommendation: "Remove the page or hide it until it has content.",
    evaluate: (model) =>
      model.pages
        .filter((p) => p.visuals.length === 0 && !p.isHidden)
        .map((p) => ({ target: pageTarget(p), detail: "The page is visible but contains no visuals." })),
  },
];

// --------------------------------------------------------------- Data quality

const dataRules: Rule[] = [
  {
    id: "DQ-RELATIONSHIP-TYPE-MISMATCH",
    title: "Relationship joins different data types",
    category: "Data",
    severity: "high",
    requires: MODEL,
    recommendation:
      "Make both key columns the same data type, converting in Power Query rather than in DAX.",
    evaluate: (model) => {
      const typeOf = new Map(allColumns(model).map((c) => [`${c.table}[${c.name}]`, c.dataType]));
      return model.relationships.flatMap((r) => {
        const from = typeOf.get(`${r.fromTable}[${r.fromColumn}]`);
        const to = typeOf.get(`${r.toTable}[${r.toColumn}]`);
        if (!from || !to || from === to) return [];
        return [
          {
            target: relationshipTarget(r),
            detail: `${r.fromTable}[${r.fromColumn}] is ${from} but ${r.toTable}[${r.toColumn}] is ${to}. Keys that differ in type match unreliably.`,
          },
        ];
      });
    },
  },
  {
    id: "DQ-NO-DATE-TABLE",
    title: "Time intelligence without a marked date table",
    category: "Data",
    severity: "high",
    requires: MODEL,
    recommendation:
      "Mark a contiguous date dimension as the date table so time-intelligence functions resolve correctly.",
    evaluate: (model) => {
      const marked = model.tables.some((t) => t.dataCategory === "Time");
      if (marked) return [];
      return allMeasures(model)
        .map((m) => ({ m, fns: timeIntelligenceUsed(m.expression) }))
        .filter(({ fns }) => fns.length > 0)
        .map(({ m, fns }) => ({
          target: measureTarget(m),
          detail: `Uses ${fns.join(", ")} but no table in the model is marked as a date table.`,
        }));
    },
  },
  {
    id: "DQ-DUPLICATE-MEASURE-NAME",
    title: "Duplicate measure name",
    category: "Data",
    severity: "medium",
    requires: MODEL,
    recommendation: "Give each measure a unique name so report bindings cannot resolve to the wrong one.",
    evaluate: (model) => {
      const byName = new Map<string, string[]>();
      for (const m of allMeasures(model)) {
        byName.set(m.name, [...(byName.get(m.name) ?? []), m.table]);
      }
      return allMeasures(model)
        .filter((m) => (byName.get(m.name)?.length ?? 0) > 1)
        .map((m) => ({
          target: measureTarget(m),
          detail: `The name "${m.name}" is defined on ${byName.get(m.name)!.join(" and ")}.`,
        }));
    },
  },
  {
    id: "DQ-MEASURE-MISSING-DEPENDENCY",
    title: "Measure references something that does not exist",
    category: "Data",
    severity: "critical",
    requires: MODEL,
    recommendation: "Fix the reference, or restore the measure or column the expression expects.",
    evaluate: (model) => {
      const measureNames = new Set(allMeasures(model).map((m) => m.name));
      const columnKeys = new Set(allColumns(model).map((c) => `${c.table}[${c.name}]`));
      const tableNames = new Set(model.tables.map((t) => t.name));

      return allMeasures(model).flatMap((m) => {
        const missingMeasures = referencedMeasures(m.expression).filter(
          (name) => !measureNames.has(name)
        );
        const missingColumns = referencedColumns(m.expression).filter(
          ({ table, column }) => tableNames.has(table) && !columnKeys.has(`${table}[${column}]`)
        );
        if (!missingMeasures.length && !missingColumns.length) return [];

        const parts = [
          ...missingMeasures.map((name) => `[${name}]`),
          ...missingColumns.map(({ table, column }) => `${table}[${column}]`),
        ];
        return [
          {
            target: measureTarget(m),
            detail: `References ${parts.join(", ")}, which could not be found in the model.`,
          },
        ];
      });
    },
  },
];

export const ALL_RULES: Rule[] = [
  ...daxRules,
  ...modelRules,
  ...relationshipRules,
  ...reportRules,
  ...dataRules,
];

/**
 * Checks that need a live query engine and are therefore never run here. Listed
 * so the UI can say what is not covered instead of implying full coverage.
 */
export const NOT_ASSESSED: Array<{ category: Category; check: string }> = [
  { category: "Data", check: "Row counts, blank rates and referential integrity in the data itself" },
  { category: "Data", check: "Duplicate key values in relationship columns" },
  { category: "Model", check: "Column cardinality and dictionary size" },
  { category: "Report", check: "Actual visual render and query timings" },
];
