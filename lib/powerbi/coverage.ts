/**
 * What the scanner reads out of a file, and what it walks past.
 *
 * The parser turns TMSL into a normalised model. That normalisation is lossy
 * by design — TMSL carries dozens of properties this app has no opinion about
 * — but "lossy by design" is only acceptable if the loss is *known*. An
 * unnoticed gap is how a tool ends up telling someone their model has no
 * calculation groups when it has four.
 *
 * So this walks the raw document and reports three things:
 *
 *   counts    every object in the file against every object in the model, so a
 *             table silently dropped by a parser bug shows up as a mismatch
 *   read      properties the model actually carries
 *   ignored   properties present in the file that the model does not carry
 *
 * `ignored` is not a bug list. An ignored property is still exported intact,
 * because an export repacks the original archive and replaces only the
 * documents that changed — nothing is rebuilt from the normalised model. The
 * list exists so that a claim like "this model has no row-level security" is
 * never made about something that was simply never looked at.
 */
import type { Model } from "./model.ts";

/** Properties the parser reads into the normalised model, by object kind. */
export const READ_PROPERTIES = {
  model: ["culture", "tables", "relationships", "expressions", "cultures", "roles"],
  table: [
    "name",
    "description",
    "isHidden",
    "dataCategory",
    "columns",
    "measures",
    "partitions",
    "hierarchies",
    "calculationGroup",
    "refreshPolicy",
  ],
  column: [
    "name",
    "dataType",
    "type",
    "expression",
    "formatString",
    "description",
    "displayFolder",
    "isHidden",
    "isKey",
    "summarizeBy",
    "sortByColumn",
  ],
  measure: [
    "name",
    "expression",
    "formatString",
    "description",
    "displayFolder",
    "isHidden",
    "kpi",
  ],
  partition: ["name", "mode", "source"],
  relationship: [
    "name",
    "fromTable",
    "fromColumn",
    "toTable",
    "toColumn",
    "fromCardinality",
    "toCardinality",
    "crossFilteringBehavior",
    "isActive",
    "securityFilteringBehavior",
    "relyOnReferentialIntegrity",
  ],
} as const;

export interface CoverageCount {
  kind: string;
  /** Objects of this kind in the raw document. */
  inFile: number;
  /** Objects of this kind in the normalised model. */
  inModel: number;
  ok: boolean;
}

export interface CoverageReport {
  counts: CoverageCount[];
  /** Every object counted was carried into the model. */
  complete: boolean;
  /** Property names present in the file that the model does not carry. */
  ignored: Array<{ kind: string; property: string; occurrences: number }>;
  /** Top-level model keys the scanner does not descend into at all. */
  unvisitedModelKeys: string[];
}

type Json = Record<string, unknown>;

const asArray = (value: unknown): Json[] =>
  Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Json[]) : [];

/**
 * Walk the raw TMSL and compare it against the model built from it.
 *
 * `raw` is the parsed `DataModelSchema` / `model.bim` document exactly as it
 * came out of the archive.
 */
export function auditModelCoverage(raw: unknown, model: Model): CoverageReport {
  const root = (raw ?? {}) as Json;
  const modelNode = (root.model ?? {}) as Json;

  const rawTables = asArray(modelNode.tables);
  const rawRelationships = asArray(modelNode.relationships);
  const rawColumns = rawTables.flatMap((t) => asArray(t.columns));
  const rawMeasures = rawTables.flatMap((t) => asArray(t.measures));
  const rawPartitions = rawTables.flatMap((t) => asArray(t.partitions));

  const counts: CoverageCount[] = [
    count("tables", rawTables.length, model.tables.length),
    count("columns", rawColumns.length, model.tables.reduce((n, t) => n + t.columns.length, 0)),
    count("measures", rawMeasures.length, model.tables.reduce((n, t) => n + t.measures.length, 0)),
    count(
      "partitions",
      rawPartitions.length,
      model.tables.reduce((n, t) => n + t.partitions.length, 0)
    ),
    count("relationships", rawRelationships.length, model.relationships.length),
  ];

  /*
   * The kind and the property are kept as fields rather than packed into the
   * key and split apart again. Encoding two values into one string needs a
   * separator that cannot occur in either, and the obvious choices are all
   * either wrong or invisible: this held a literal NUL for a while, which
   * worked perfectly and quietly turned the file binary.
   */
  const ignored = new Map<string, { kind: string; property: string; occurrences: number }>();
  const note = (kind: string, node: Json, read: readonly string[]) => {
    for (const key of Object.keys(node)) {
      if (read.includes(key)) continue;
      const id = `${kind}.${key}`;
      const seen = ignored.get(id);
      if (seen) seen.occurrences++;
      else ignored.set(id, { kind, property: key, occurrences: 1 });
    }
  };

  for (const table of rawTables) note("table", table, READ_PROPERTIES.table);
  for (const column of rawColumns) note("column", column, READ_PROPERTIES.column);
  for (const measure of rawMeasures) note("measure", measure, READ_PROPERTIES.measure);
  for (const partition of rawPartitions) note("partition", partition, READ_PROPERTIES.partition);
  for (const rel of rawRelationships) note("relationship", rel, READ_PROPERTIES.relationship);

  return {
    counts,
    complete: counts.every((c) => c.ok),
    ignored: [...ignored.values()].sort(
      (a, b) => b.occurrences - a.occurrences || a.property.localeCompare(b.property)
    ),
    unvisitedModelKeys: Object.keys(modelNode)
      .filter((key) => !READ_PROPERTIES.model.includes(key as never))
      .sort(),
  };
}

function count(kind: string, inFile: number, inModel: number): CoverageCount {
  return { kind, inFile, inModel, ok: inFile === inModel };
}

/**
 * The report as sentences, for the Settings screen.
 *
 * Written so a reviewer can tell the difference between "the scanner missed
 * something" and "the file contains something this app has no opinion about".
 */
export function describeCoverage(report: CoverageReport): string[] {
  const lines: string[] = [];

  for (const c of report.counts) {
    lines.push(
      c.ok
        ? `All ${c.inFile} ${c.kind} in the file were read into the model.`
        : `${c.inFile} ${c.kind} in the file but ${c.inModel} in the model — ${
            c.inFile - c.inModel
          } were not read.`
    );
  }

  if (report.unvisitedModelKeys.length > 0) {
    lines.push(
      `The model also declares ${report.unvisitedModelKeys.join(", ")}. These are not read, ` +
        "not analysed, and not reported on — and they are copied into an export untouched."
    );
  }

  return lines;
}
