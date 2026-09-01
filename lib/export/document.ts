/**
 * The documentation, as data.
 *
 * Everything the workbook shows is assembled here, so the spreadsheet layer
 * only has to lay out rows and the whole thing can be verified without
 * opening Excel.
 *
 * The organising decision is that a measure belongs to the table its **DAX
 * reads**, not to the table it is stored in. A model with one `Measures` table
 * holding three hundred measures is the normal case, and filing them all under
 * `Measures` would produce a document that tells the reader nothing. The
 * dependency analysis already computed for the app is reused unchanged.
 *
 * Where that analysis cannot name a primary table with confidence, the measure
 * is not forced under a guess — it goes to a Multi-Table section that says so.
 */
import { allMeasures, type Measure, type Model } from "../powerbi/model.ts";
import { bestKpiName, inferKpiNames } from "../powerbi/kpi.ts";
import { analyseMeasureSources, type MeasureSources } from "../powerbi/sources.ts";
import { UsageIndex } from "../powerbi/usage.ts";
import {
  describeMeasure,
  describeTable,
  tableDependencies,
  MULTIPLE_SOURCES,
  NOT_DETECTED,
} from "./definitions.ts";

export interface MeasureDoc {
  name: string;
  homeTable: string;
  /** The table its DAX mainly reads, when one dominates. */
  primaryTable?: string;
  otherTables: string[];
  allTables: string[];
  definition: string;
  dax: string;
  kpiName?: string;
  /** Where the report uses it. */
  pages: string[];
  visualCount: number;
  confidence: MeasureSources["confidence"];
  mappingReason: string;
}

export interface TableDoc {
  name: string;
  definition: string;
  sourceType: string;
  nativeSql?: string;
  sqlAvailable: boolean;
  sqlUnavailableReason?: string;
  columnCount: number;
  dependencies: string[];
  measures: MeasureDoc[];
}

export interface DocumentModel {
  fileName: string;
  exportedAt: string;
  tables: TableDoc[];
  /** Measures whose DAX reads no table that could be resolved to a section. */
  multiTableMeasures: MeasureDoc[];
  unmappedMeasures: MeasureDoc[];
  allMeasures: MeasureDoc[];
  overview: Array<[string, string | number]>;
  /** Accuracy checks run before the workbook is built. */
  validation: ValidationResult;
}

export interface ValidationResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

const NATIVE_SQL_UNAVAILABLE = "Native SQL unavailable";

/**
 * Build the whole document from the model already in memory.
 *
 * `at` is passed in rather than read from the clock so the result is
 * reproducible in a test.
 */
export function buildDocument(model: Model, at: Date = new Date()): DocumentModel {
  const sources = analyseMeasureSources(model);
  const kpis = inferKpiNames(model);
  const usage = new UsageIndex(model);

  const measures = allMeasures(model).map((measure) =>
    toMeasureDoc(measure, sources, kpis, usage)
  );

  // Index by the table each measure's DAX actually reads.
  const byTable = new Map<string, MeasureDoc[]>();
  const multiTable: MeasureDoc[] = [];
  const unmapped: MeasureDoc[] = [];
  const tableNames = new Set(model.tables.map((t) => t.name));

  for (const doc of measures) {
    if (doc.primaryTable && tableNames.has(doc.primaryTable)) {
      const list = byTable.get(doc.primaryTable);
      if (list) list.push(doc);
      else byTable.set(doc.primaryTable, [doc]);
    } else if (doc.allTables.length > 0) {
      // It reads tables, but no single one dominates. Naming a primary here
      // would be the guess the brief forbids.
      multiTable.push(doc);
    } else {
      unmapped.push(doc);
    }
  }

  const tables: TableDoc[] = model.tables
    .map((table) => {
      const partition = table.partitions[0];
      const native = table.partitions.find((p) => p.nativeQuery?.kind === "native");
      const sql = native?.nativeQuery?.sql;

      return {
        name: table.name,
        definition: describeTable(table),
        sourceType: sourceTypeLabel(table.partitions[0]?.sourceType, table.kind),
        nativeSql: sql,
        sqlAvailable: Boolean(sql),
        sqlUnavailableReason: sql
          ? undefined
          : (partition?.nativeQuery?.reason ?? NATIVE_SQL_UNAVAILABLE),
        columnCount: table.columns.length,
        dependencies: tableDependencies(model, table),
        measures: (byTable.get(table.name) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const withSql = tables.filter((t) => t.sqlAvailable).length;
  const mapped = measures.length - multiTable.length - unmapped.length;

  const overview: Array<[string, string | number]> = [
    ["File Name", model.source.fileName],
    ["File Format", model.source.format.toUpperCase()],
    ["Report Pages", model.pages.length],
    ["PBI Tables", model.tables.length],
    ["Measures", measures.length],
    ["Columns", model.tables.reduce((n, t) => n + t.columns.length, 0)],
    ["Relationships", model.relationships.length],
    ["Tables with Native SQL", `${withSql} / ${model.tables.length}`],
    ["Measures mapped to a primary table", `${mapped} / ${measures.length}`],
    ["Measures with multiple source tables", multiTable.length],
    ["Measures with no resolvable table", unmapped.length],
    ["Export Date", at.toISOString().slice(0, 10)],
  ];

  return {
    fileName: model.source.fileName,
    exportedAt: at.toISOString(),
    tables,
    multiTableMeasures: multiTable.sort((a, b) => a.name.localeCompare(b.name)),
    unmappedMeasures: unmapped.sort((a, b) => a.name.localeCompare(b.name)),
    allMeasures: measures.slice().sort((a, b) => a.name.localeCompare(b.name)),
    overview,
    validation: validate(model, measures, tables, multiTable, unmapped),
  };
}

function toMeasureDoc(
  measure: Measure,
  sources: Map<string, MeasureSources>,
  kpis: ReturnType<typeof inferKpiNames>,
  usage: UsageIndex
): MeasureDoc {
  const key = `${measure.table}[${measure.name}]`;
  const analysis = sources.get(key);
  const all = analysis?.all ?? [];
  const primary = analysis?.primary;
  const found = usage.find("measure", measure.table, measure.name);

  return {
    name: measure.name,
    homeTable: measure.table,
    primaryTable: primary,
    otherTables: all.filter((t) => t !== primary),
    allTables: all,
    definition: describeMeasure(measure.expression, all, measure.description),
    dax: measure.expression,
    kpiName: bestKpiName(kpis, measure.table, measure.name)?.label,
    pages: found.pages,
    visualCount: found.visualCount,
    confidence: analysis?.confidence ?? "none",
    mappingReason: analysis?.reason ?? "No DAX table reference could be resolved.",
  };
}

function sourceTypeLabel(sourceType: string | undefined, kind: string): string {
  if (kind === "calculated") return "Calculated table (DAX)";
  switch (sourceType) {
    case "query":
      return "Native SQL query";
    case "m":
      return "Power Query (M)";
    case "calculated":
      return "Calculated table (DAX)";
    case "entity":
      return "Dataflow entity";
    case undefined:
      return NOT_DETECTED;
    default:
      return sourceType;
  }
}

/**
 * Accuracy checks, run before a workbook is offered.
 *
 * These exist because a documentation export is trusted differently from a
 * screen: it gets emailed, printed and filed, and a measure quietly missing
 * from it is not noticed for months.
 */
function validate(
  model: Model,
  measures: MeasureDoc[],
  tables: TableDoc[],
  multiTable: MeasureDoc[],
  unmapped: MeasureDoc[]
): ValidationResult {
  const modelMeasures = allMeasures(model);
  const placed =
    tables.reduce((n, t) => n + t.measures.length, 0) + multiTable.length + unmapped.length;

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const table of tables) {
    for (const doc of table.measures) {
      const id = `${doc.homeTable}[${doc.name}]`;
      if (seen.has(id)) duplicates.push(id);
      else seen.add(id);
    }
  }

  const danglingRefs = measures.filter((doc) =>
    doc.allTables.some((t) => !model.tables.some((table) => table.name === t))
  );

  const sqlMismatch = tables.filter(
    (t) => t.sqlAvailable && (!t.nativeSql || t.nativeSql.trim().length === 0)
  );

  const checks = [
    {
      name: "Table count",
      ok: tables.length === model.tables.length,
      detail: `${tables.length} documented, ${model.tables.length} in the model.`,
    },
    {
      name: "Measure count",
      ok: measures.length === modelMeasures.length,
      detail: `${measures.length} documented, ${modelMeasures.length} in the model.`,
    },
    {
      name: "Every measure appears somewhere",
      ok: placed === measures.length,
      detail:
        placed === measures.length
          ? `All ${measures.length} appear under a table, in Multi-Table Measures, or in Unmapped.`
          : `${placed} placed but ${measures.length} exist — ${measures.length - placed} would be missing from the workbook.`,
    },
    {
      name: "No duplicate measure rows",
      ok: duplicates.length === 0,
      detail:
        duplicates.length === 0
          ? "No measure is documented under more than one table."
          : `Duplicated: ${duplicates.slice(0, 5).join(", ")}.`,
    },
    {
      name: "DAX references resolve",
      ok: danglingRefs.length === 0,
      detail:
        danglingRefs.length === 0
          ? "Every table named by a measure's DAX exists in the model."
          : `${danglingRefs.length} measure(s) reference a table that is not in the model: ${danglingRefs
              .slice(0, 3)
              .map((d) => d.name)
              .join(", ")}.`,
    },
    {
      name: "Extracted SQL is non-empty",
      ok: sqlMismatch.length === 0,
      detail:
        sqlMismatch.length === 0
          ? `${tables.filter((t) => t.sqlAvailable).length} table(s) carry a statement; none is blank.`
          : `${sqlMismatch.length} table(s) report SQL but carry none.`,
    },
  ];

  return { ok: checks.every((c) => c.ok), checks };
}

/** The value a cell should show when the file does not say. */
export const cellOr = (value: string | undefined, fallback: string) =>
  value && value.trim().length > 0 ? value : fallback;

export { MULTIPLE_SOURCES, NATIVE_SQL_UNAVAILABLE, NOT_DETECTED };
