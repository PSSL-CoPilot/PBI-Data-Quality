/**
 * Object dependency graph.
 *
 * Answers "what does this depend on" and "what depends on this" across DAX,
 * relationships and report bindings. Optimization uses it to find objects
 * nothing references; dependency-aware editing will use the same index to
 * decide whether a rename can be applied safely.
 */
import type { Measure, Model } from "./model.ts";
import { allColumns, allMeasures } from "./model.ts";
import { referencedColumns, referencedMeasures } from "../qa/dax.ts";

export interface DependencyIndex {
  /** Measure name -> names of measures its DAX references. */
  measureDependsOn: Map<string, Set<string>>;
  /** Measure name -> names of measures referencing it. */
  measureUsedBy: Map<string, Set<string>>;
  /** Measure names bound by at least one visual. */
  measuresInReport: Set<string>;
  /** `Table[Column]` keys bound by at least one visual. */
  columnsInReport: Set<string>;
  /** `Table[Column]` keys referenced by any DAX expression. */
  columnsInDax: Set<string>;
  /** `Table[Column]` keys used as a relationship key. */
  columnsInRelationships: Set<string>;
  /** Table names referenced by a relationship, a visual or any DAX. */
  tablesReferenced: Set<string>;
}

/** Every DAX expression in the model: measures, calculated columns and tables. */
function allExpressions(model: Model): string[] {
  return [
    ...allMeasures(model).map((m) => m.expression),
    ...allColumns(model)
      .filter((c) => c.kind === "calculated" && c.expression)
      .map((c) => c.expression as string),
    ...model.tables.filter((t) => t.expression).map((t) => t.expression as string),
  ];
}

export function buildDependencyIndex(model: Model): DependencyIndex {
  const measureNames = new Set(allMeasures(model).map((m) => m.name));

  const measureDependsOn = new Map<string, Set<string>>();
  const measureUsedBy = new Map<string, Set<string>>();

  for (const measure of allMeasures(model)) {
    // Only references that resolve to a real measure are dependencies; the rest
    // are missing references, which QA reports separately.
    const deps = new Set(
      referencedMeasures(measure.expression).filter(
        (name) => name !== measure.name && measureNames.has(name)
      )
    );
    measureDependsOn.set(measure.name, deps);
    for (const dep of deps) {
      const users = measureUsedBy.get(dep) ?? new Set<string>();
      users.add(measure.name);
      measureUsedBy.set(dep, users);
    }
  }

  const measuresInReport = new Set<string>();
  const columnsInReport = new Set<string>();
  for (const page of model.pages) {
    for (const visual of page.visuals) {
      for (const ref of visual.refs) {
        if (ref.kind === "measure") measuresInReport.add(ref.field);
        if (ref.kind === "column" && ref.table) {
          columnsInReport.add(`${ref.table}[${ref.field}]`);
        }
      }
    }
  }

  const columnsInDax = new Set<string>();
  for (const expression of allExpressions(model)) {
    for (const { table, column } of referencedColumns(expression)) {
      columnsInDax.add(`${table}[${column}]`);
    }
  }

  const columnsInRelationships = new Set<string>();
  for (const rel of model.relationships) {
    columnsInRelationships.add(`${rel.fromTable}[${rel.fromColumn}]`);
    columnsInRelationships.add(`${rel.toTable}[${rel.toColumn}]`);
  }

  const tablesReferenced = new Set<string>();
  for (const rel of model.relationships) {
    tablesReferenced.add(rel.fromTable);
    tablesReferenced.add(rel.toTable);
  }
  for (const key of [...columnsInReport, ...columnsInDax]) {
    tablesReferenced.add(key.slice(0, key.indexOf("[")));
  }
  for (const page of model.pages) {
    for (const visual of page.visuals) {
      for (const ref of visual.refs) {
        if (ref.table) tablesReferenced.add(ref.table);
      }
    }
  }

  return {
    measureDependsOn,
    measureUsedBy,
    measuresInReport,
    columnsInReport,
    columnsInDax,
    columnsInRelationships,
    tablesReferenced,
  };
}

/**
 * Longest chain of measure-to-measure references starting at `measure`.
 * A measure referencing nothing is depth 1. Cycles are impossible in valid DAX
 * but are guarded anyway so a malformed model cannot hang the analysis.
 */
export function dependencyDepth(
  index: DependencyIndex,
  measureName: string,
  seen: Set<string> = new Set()
): number {
  if (seen.has(measureName)) return 0;
  seen.add(measureName);

  const deps = index.measureDependsOn.get(measureName);
  if (!deps || deps.size === 0) return 1;

  let deepest = 0;
  for (const dep of deps) {
    deepest = Math.max(deepest, dependencyDepth(index, dep, new Set(seen)));
  }
  return deepest + 1;
}

/** A measure nothing binds and no other measure references. */
export function isMeasureUnused(index: DependencyIndex, measure: Measure): boolean {
  if (index.measuresInReport.has(measure.name)) return false;
  const users = index.measureUsedBy.get(measure.name);
  return !users || users.size === 0;
}

export function isColumnUnused(index: DependencyIndex, key: string): boolean {
  return (
    !index.columnsInReport.has(key) &&
    !index.columnsInDax.has(key) &&
    !index.columnsInRelationships.has(key)
  );
}
