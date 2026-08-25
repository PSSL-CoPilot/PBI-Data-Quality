/**
 * Which tables a measure actually reads.
 *
 * Grouping by home table is misleading: a model with a dedicated `Measures`
 * table puts every measure in one bucket that says nothing about the data. So
 * the DAX is analysed instead, following references into other measures, and
 * the tables are counted.
 *
 * A primary table is only named when one table clearly dominates. Where the
 * counts are close, or a measure genuinely spans tables, no primary is claimed.
 */
import { tableReferenceCounts } from "../qa/dax.ts";
import { allMeasures, type Measure, type Model } from "./model.ts";

export interface MeasureSources {
  measure: string;
  homeTable: string;
  /** Tables referenced by this measure's own DAX. */
  direct: string[];
  /** Tables referenced directly or through the measures it calls. */
  all: string[];
  /** Reference counts across the whole dependency closure. */
  counts: Array<{ table: string; references: number }>;
  /** Named only when one table clearly dominates. */
  primary?: string;
  confidence: "high" | "medium" | "low" | "none";
  /** Why the primary is what it is, for display. */
  reason: string;
}

/** How far ahead the leader must be before it is called the primary table. */
const DOMINANCE = 1.5;

function mergeCounts(into: Map<string, number>, from: Map<string, number>): void {
  for (const [table, count] of from) into.set(table, (into.get(table) ?? 0) + count);
}

/**
 * Reference counts for a measure, following measure-to-measure calls.
 * `seen` guards against a cycle, which valid DAX cannot contain but a
 * malformed model can.
 */
function closureCounts(
  measure: Measure,
  byName: Map<string, Measure>,
  tables: Set<string>,
  seen: Set<string>
): Map<string, number> {
  const key = `${measure.table}[${measure.name}]`;
  if (seen.has(key)) return new Map();
  seen.add(key);

  const counts = tableReferenceCounts(measure.expression, tables);

  // Measure references are found by the same scan the QA rules use.
  for (const name of referencedMeasureNames(measure.expression)) {
    const dependency = byName.get(name);
    if (dependency) mergeCounts(counts, closureCounts(dependency, byName, tables, seen));
  }

  return counts;
}

function referencedMeasureNames(expression: string): string[] {
  const found = new Set<string>();
  for (const match of expression.matchAll(/(^|[^\w'\]])\[([^\]\r\n]+)\]/g)) {
    found.add(match[2]);
  }
  return [...found];
}

export function analyseMeasureSources(model: Model): Map<string, MeasureSources> {
  const tables = new Set(model.tables.map((t) => t.name));
  const measures = allMeasures(model);
  const byName = new Map(measures.map((m) => [m.name, m]));

  const result = new Map<string, MeasureSources>();

  for (const measure of measures) {
    const direct = [...tableReferenceCounts(measure.expression, tables).keys()];
    const closure = closureCounts(measure, byName, tables, new Set());

    const counts = [...closure.entries()]
      .map(([table, references]) => ({ table, references }))
      .sort((a, b) => b.references - a.references || a.table.localeCompare(b.table));

    let primary: string | undefined;
    let confidence: MeasureSources["confidence"] = "none";
    let reason: string;

    if (counts.length === 0) {
      reason = "The expression references no table, so it cannot be attributed to one.";
    } else if (counts.length === 1) {
      primary = counts[0].table;
      confidence = direct.includes(primary) ? "high" : "medium";
      reason =
        confidence === "high"
          ? `Every reference is to ${primary}.`
          : `Only ${primary} is referenced, through the measures this one calls.`;
    } else if (counts[0].references >= counts[1].references * DOMINANCE) {
      primary = counts[0].table;
      confidence = direct.includes(primary) ? "high" : "medium";
      reason = `${primary} is referenced ${counts[0].references} times against ${counts[1].references} for ${counts[1].table}.`;
    } else {
      confidence = "low";
      reason = `References are split between ${counts
        .slice(0, 3)
        .map((c) => `${c.table} (${c.references})`)
        .join(", ")}, so no single table dominates.`;
    }

    result.set(`${measure.table}[${measure.name}]`, {
      measure: measure.name,
      homeTable: measure.table,
      direct,
      all: counts.map((c) => c.table),
      counts,
      primary,
      confidence,
      reason,
    });
  }

  return result;
}

export interface TableGroup {
  table: string;
  measures: Measure[];
  /** Measures placed here despite living on a different home table. */
  movedIn: number;
}

/**
 * Measures grouped under the table their DAX actually uses.
 *
 * A measure with no determinable primary table falls back to its home table, so
 * every measure appears exactly once and none is lost.
 */
export function groupMeasuresBySourceTable(
  model: Model,
  sources: Map<string, MeasureSources>
): TableGroup[] {
  const groups = new Map<string, Measure[]>();

  for (const measure of allMeasures(model)) {
    const analysis = sources.get(`${measure.table}[${measure.name}]`);
    const table = analysis?.primary ?? measure.table;
    groups.set(table, [...(groups.get(table) ?? []), measure]);
  }

  return [...groups.entries()]
    .map(([table, list]) => ({
      table,
      measures: list.sort((a, b) => a.name.localeCompare(b.name)),
      movedIn: list.filter((m) => m.table !== table).length,
    }))
    .sort((a, b) => b.measures.length - a.measures.length || a.table.localeCompare(b.table));
}

/** One measure as a visual binds it, whether or not the model could be read. */
export interface BoundMeasure {
  name: string;
  /** The table the report metadata says the binding came from. */
  boundTable?: string;
  /** The model definition, present only when the model was readable. */
  measure?: Measure;
}

/** A visual with the fields it actually binds, straight from report metadata. */
export interface VisualBinding {
  visualId: string;
  visualType: string;
  /** The visual's own title, when it has one. */
  title?: string;
  measures: BoundMeasure[];
  columns: Array<{ name: string; boundTable?: string }>;
}

export interface PageGroup {
  page: string;
  displayName: string;
  isHidden: boolean;
  /** Every visual on the page that binds at least one field. */
  visuals: VisualBinding[];
  /** Distinct measures across the page, in name order. */
  measures: BoundMeasure[];
  /** Bound names with no match in the model. Only meaningful with a model. */
  unresolved: string[];
}

/** Measures grouped by the report page whose visuals bind them. */
/**
 * Report page to visual to measure, taken from the report's own bindings.
 *
 * The binding is the authority here, not the model: a visual states exactly
 * which measure it draws. The model is looked up to attach the DAX where it can
 * be, but a missing model no longer empties the page. That is what made this
 * look broken on a .pbix — every binding was found correctly, then discarded
 * because it could not be matched to a table that had not been read.
 *
 * Nothing is matched by guessing at names; only the metadata is used.
 */
export function groupMeasuresByPage(model: Model): PageGroup[] {
  const byName = new Map(allMeasures(model).map((m) => [m.name, m]));
  const modelReadable = model.capabilities.model.available;

  return model.pages.map((page) => {
    const visuals: VisualBinding[] = [];
    const distinct = new Map<string, BoundMeasure>();
    const unresolved = new Set<string>();

    for (const visual of page.visuals) {
      const measures: BoundMeasure[] = [];
      const columns: Array<{ name: string; boundTable?: string }> = [];

      for (const ref of visual.refs) {
        if (ref.kind === "measure") {
          const bound: BoundMeasure = {
            name: ref.field,
            boundTable: ref.table,
            measure: byName.get(ref.field),
          };
          measures.push(bound);
          if (!distinct.has(ref.field)) distinct.set(ref.field, bound);
          if (modelReadable && !bound.measure) unresolved.add(ref.field);
        } else if (ref.kind === "column") {
          columns.push({ name: ref.field, boundTable: ref.table });
        }
      }

      if (measures.length > 0 || columns.length > 0) {
        visuals.push({
          visualId: visual.id,
          visualType: visual.type,
          title: visual.title,
          measures,
          columns,
        });
      }
    }

    return {
      page: page.name,
      displayName: page.displayName,
      isHidden: page.isHidden,
      visuals,
      measures: [...distinct.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unresolved: [...unresolved].sort(),
    };
  });
}

/** Measures that no page binds, so they appear under "Not on any page". */
export function measuresNotOnAnyPage(model: Model): Measure[] {
  const used = new Set(
    model.pages
      .flatMap((p) => p.visuals)
      .flatMap((v) => v.refs)
      .filter((r) => r.kind === "measure")
      .map((r) => r.field)
  );
  return allMeasures(model)
    .filter((m) => !used.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
