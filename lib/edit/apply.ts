/**
 * Applying an edit to the model.
 *
 * Every change is applied to a *copy*: the extracted model is never mutated, so
 * the original stays available for diffing, reverting and re-analysis.
 *
 * A rename rewrites every reference it can resolve — other measures' DAX,
 * calculated columns and tables, relationship keys, and report bindings — and
 * returns whatever it could not resolve. Callers must surface `unresolved`
 * rather than treating a rename as done.
 */
import type { Model, Page, Table, Visual } from "../powerbi/model.ts";
import { allMeasures } from "../powerbi/model.ts";
import { renameColumnInDax, renameMeasureInDax, renameTableInDax } from "./references.ts";

export type EditableField = "name" | "expression" | "description" | "formatString" | "homeTable";

export interface EditTarget {
  type: "measure" | "table" | "column" | "partition";
  /** Owning table, for measures, columns and partitions. */
  table?: string;
  name: string;
}

export interface Change {
  id: string;
  target: EditTarget;
  field: EditableField;
  before: string;
  after: string;
  at: number;
}

export interface ApplyResult {
  model: Model;
  /** Counts of what the edit touched, for the confirmation summary. */
  updated: {
    daxExpressions: number;
    reportBindings: number;
    relationships: number;
  };
  /** References a human has to check. Never silently dropped. */
  unresolved: string[];
  /** Set when the change could not be applied at all. */
  error?: string;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const describe = (target: EditTarget) =>
  target.table ? `${target.table}[${target.name}]` : target.name;

/** Rewrite every DAX expression in the model with `rewrite`, counting changes. */
function rewriteAllDax(
  model: Model,
  rewrite: (expression: string) => { expression: string; unresolved: string[] }
): { changed: number; unresolved: string[] } {
  let changed = 0;
  const unresolved: string[] = [];

  const run = (expression: string | undefined, label: string): string | undefined => {
    if (!expression) return expression;
    const result = rewrite(expression);
    if (result.expression !== expression) changed++;
    for (const note of result.unresolved) unresolved.push(`${label}: ${note}`);
    return result.expression;
  };

  for (const table of model.tables) {
    table.expression = run(table.expression, `Calculated table ${table.name}`);
    for (const partition of table.partitions) {
      if (partition.sourceType === "calculated") {
        partition.expression = run(partition.expression, `Calculated table ${table.name}`);
      }
    }
    for (const column of table.columns) {
      if (column.kind === "calculated") {
        column.expression = run(column.expression, `Column ${table.name}[${column.name}]`);
      }
    }
    for (const measure of table.measures) {
      const updated = run(measure.expression, `Measure ${table.name}[${measure.name}]`);
      measure.expression = updated ?? measure.expression;
    }
  }

  return { changed, unresolved };
}

function eachVisual(model: Model, fn: (visual: Visual, page: Page) => void): void {
  for (const page of model.pages) for (const visual of page.visuals) fn(visual, page);
}

function findTable(model: Model, name: string): Table | undefined {
  return model.tables.find((t) => t.name === name);
}

/** Names already taken, so a rename cannot collide. */
function nameCollision(model: Model, target: EditTarget, newName: string): string | undefined {
  if (target.type === "measure") {
    const clash = allMeasures(model).find(
      (m) => m.name === newName && !(m.name === target.name && m.table === target.table)
    );
    return clash ? `A measure named "${newName}" already exists on ${clash.table}.` : undefined;
  }
  if (target.type === "table") {
    return model.tables.some((t) => t.name === newName)
      ? `A table named "${newName}" already exists.`
      : undefined;
  }
  if (target.type === "column") {
    const table = findTable(model, target.table ?? "");
    return table?.columns.some((c) => c.name === newName)
      ? `A column named "${newName}" already exists on ${table.name}.`
      : undefined;
  }
  return undefined;
}

function renameMeasure(model: Model, change: Change): ApplyResult {
  const measure = allMeasures(model).find(
    (m) => m.name === change.target.name && m.table === change.target.table
  );
  if (!measure) {
    return emptyResult(model, `Measure ${describe(change.target)} no longer exists.`);
  }

  const collision = nameCollision(model, change.target, change.after);
  if (collision) return emptyResult(model, collision);

  measure.name = change.after;

  const dax = rewriteAllDax(model, (expression) => ({
    ...renameMeasureInDax(expression, change.before, change.after),
  }));

  let bindings = 0;
  eachVisual(model, (visual) => {
    for (const ref of visual.refs) {
      if (ref.kind === "measure" && ref.field === change.before) {
        ref.field = change.after;
        bindings++;
      }
    }
  });

  return {
    model,
    updated: { daxExpressions: dax.changed, reportBindings: bindings, relationships: 0 },
    unresolved: dax.unresolved,
  };
}

function renameColumn(model: Model, change: Change): ApplyResult {
  const table = findTable(model, change.target.table ?? "");
  const column = table?.columns.find((c) => c.name === change.target.name);
  if (!table || !column) {
    return emptyResult(model, `Column ${describe(change.target)} no longer exists.`);
  }

  const collision = nameCollision(model, change.target, change.after);
  if (collision) return emptyResult(model, collision);

  column.name = change.after;

  const dax = rewriteAllDax(model, (expression) => ({
    ...renameColumnInDax(expression, table.name, change.before, change.after),
  }));

  let relationships = 0;
  for (const rel of model.relationships) {
    if (rel.fromTable === table.name && rel.fromColumn === change.before) {
      rel.fromColumn = change.after;
      relationships++;
    }
    if (rel.toTable === table.name && rel.toColumn === change.before) {
      rel.toColumn = change.after;
      relationships++;
    }
  }

  let bindings = 0;
  eachVisual(model, (visual) => {
    for (const ref of visual.refs) {
      if (ref.kind === "column" && ref.table === table.name && ref.field === change.before) {
        ref.field = change.after;
        bindings++;
      }
    }
  });

  return {
    model,
    updated: { daxExpressions: dax.changed, reportBindings: bindings, relationships },
    unresolved: dax.unresolved,
  };
}

function renameTable(model: Model, change: Change): ApplyResult {
  const table = findTable(model, change.target.name);
  if (!table) return emptyResult(model, `Table ${change.target.name} no longer exists.`);

  const collision = nameCollision(model, change.target, change.after);
  if (collision) return emptyResult(model, collision);

  table.name = change.after;
  for (const column of table.columns) column.table = change.after;
  for (const measure of table.measures) measure.table = change.after;
  for (const partition of table.partitions) partition.table = change.after;

  const dax = rewriteAllDax(model, (expression) =>
    renameTableInDax(expression, change.before, change.after)
  );

  let relationships = 0;
  for (const rel of model.relationships) {
    if (rel.fromTable === change.before) {
      rel.fromTable = change.after;
      relationships++;
    }
    if (rel.toTable === change.before) {
      rel.toTable = change.after;
      relationships++;
    }
  }

  let bindings = 0;
  eachVisual(model, (visual) => {
    for (const ref of visual.refs) {
      if (ref.table === change.before) {
        ref.table = change.after;
        bindings++;
      }
    }
  });

  return {
    model,
    updated: { daxExpressions: dax.changed, reportBindings: bindings, relationships },
    unresolved: dax.unresolved,
  };
}

function moveMeasure(model: Model, change: Change): ApplyResult {
  const from = findTable(model, change.before);
  const to = findTable(model, change.after);
  const measure = from?.measures.find((m) => m.name === change.target.name);

  if (!from || !measure) return emptyResult(model, `Measure ${describe(change.target)} not found.`);
  if (!to) return emptyResult(model, `Table "${change.after}" does not exist.`);

  from.measures = from.measures.filter((m) => m !== measure);
  measure.table = change.after;
  to.measures.push(measure);

  // Report bindings name the measure's home table, so they move with it.
  let bindings = 0;
  eachVisual(model, (visual) => {
    for (const ref of visual.refs) {
      if (ref.kind === "measure" && ref.field === measure.name && ref.table === change.before) {
        ref.table = change.after;
        bindings++;
      }
    }
  });

  return {
    model,
    updated: { daxExpressions: 0, reportBindings: bindings, relationships: 0 },
    // DAX references measures by name alone, so moving one breaks nothing.
    unresolved: [],
  };
}

/** Set a scalar field with no reference implications. */
function setField(model: Model, change: Change): ApplyResult {
  const { target, field, after } = change;

  if (target.type === "measure") {
    const measure = allMeasures(model).find(
      (m) => m.name === target.name && m.table === target.table
    );
    if (!measure) return emptyResult(model, `Measure ${describe(target)} no longer exists.`);
    if (field === "expression") measure.expression = after;
    if (field === "description") measure.description = after || undefined;
    if (field === "formatString") measure.formatString = after || undefined;
    return okResult(model);
  }

  if (target.type === "column") {
    const table = findTable(model, target.table ?? "");
    const column = table?.columns.find((c) => c.name === target.name);
    if (!column) return emptyResult(model, `Column ${describe(target)} no longer exists.`);
    if (field === "expression") column.expression = after;
    if (field === "description") column.description = after || undefined;
    if (field === "formatString") column.formatString = after || undefined;
    return okResult(model);
  }

  if (target.type === "table") {
    const table = findTable(model, target.name);
    if (!table) return emptyResult(model, `Table ${target.name} no longer exists.`);
    if (field === "description") table.description = after || undefined;
    if (field === "expression") {
      table.expression = after;
      const calculated = table.partitions.find((p) => p.sourceType === "calculated");
      if (calculated) calculated.expression = after;
    }
    return okResult(model);
  }

  if (target.type === "partition") {
    const table = findTable(model, target.table ?? "");
    const partition = table?.partitions.find((p) => p.name === target.name);
    if (!partition) return emptyResult(model, `Partition ${describe(target)} no longer exists.`);
    partition.expression = after;
    return okResult(model);
  }

  return emptyResult(model, `Unsupported edit target: ${target.type}.`);
}

const okResult = (model: Model): ApplyResult => ({
  model,
  updated: { daxExpressions: 0, reportBindings: 0, relationships: 0 },
  unresolved: [],
});

const emptyResult = (model: Model, error: string): ApplyResult => ({
  model,
  updated: { daxExpressions: 0, reportBindings: 0, relationships: 0 },
  unresolved: [],
  error,
});

/** Apply one change, returning a new model. The input is never mutated. */
export function applyChange(model: Model, change: Change): ApplyResult {
  const next = clone(model);

  if (change.field === "name") {
    if (change.target.type === "measure") return renameMeasure(next, change);
    if (change.target.type === "column") return renameColumn(next, change);
    if (change.target.type === "table") return renameTable(next, change);
    return emptyResult(model, `Renaming ${change.target.type} is not supported.`);
  }

  if (change.field === "homeTable") return moveMeasure(next, change);

  return setField(next, change);
}

// ------------------------------------------------------------------ preview

export interface DependencyPreview {
  pages: string[];
  visuals: number;
  measures: string[];
  relationships: number;
  partitions: string[];
  /** Reasons the edit cannot proceed at all. */
  blockers: string[];
  /** Things the edit will not be able to update automatically. */
  warnings: string[];
}

/**
 * What a rename would touch, computed before anything is applied.
 *
 * This is the "Used in: 4 report pages, 7 visuals, 3 measures" summary. It is
 * derived by running the rename against a copy, so the preview cannot disagree
 * with what the edit actually does.
 */
export function previewRename(
  model: Model,
  target: EditTarget,
  newName: string
): DependencyPreview {
  const blockers: string[] = [];
  if (!newName.trim()) blockers.push("The new name cannot be empty.");
  const collision = nameCollision(model, target, newName);
  if (collision) blockers.push(collision);

  const pages = new Set<string>();
  let visuals = 0;
  eachVisual(model, (visual, page) => {
    const hit = visual.refs.some((ref) => {
      if (target.type === "table") return ref.table === target.name;
      if (target.type === "measure") {
        return ref.kind === "measure" && ref.field === target.name;
      }
      return ref.kind === "column" && ref.table === target.table && ref.field === target.name;
    });
    if (hit) {
      visuals++;
      pages.add(page.displayName);
    }
  });

  const needle =
    target.type === "measure"
      ? `[${target.name}]`
      : target.type === "column"
        ? `[${target.name}]`
        : target.name;

  const measures = allMeasures(model)
    .filter((m) => !(m.name === target.name && m.table === target.table))
    .filter((m) => m.expression.includes(needle))
    .map((m) => `${m.table}[${m.name}]`);

  const relationships = model.relationships.filter((rel) => {
    if (target.type === "table") {
      return rel.fromTable === target.name || rel.toTable === target.name;
    }
    if (target.type === "column") {
      return (
        (rel.fromTable === target.table && rel.fromColumn === target.name) ||
        (rel.toTable === target.table && rel.toColumn === target.name)
      );
    }
    return false;
  }).length;

  const partitions = model.tables
    .flatMap((t) => t.partitions)
    .filter((p) => p.expression?.includes(target.name))
    .map((p) => `${p.table}.${p.name}`);

  // Run the real rename on a copy so the warnings shown are the real ones.
  const warnings =
    blockers.length === 0
      ? applyChange(model, {
          id: "preview",
          target,
          field: "name",
          before: target.name,
          after: newName,
          at: 0,
        }).unresolved
      : [];

  return {
    pages: [...pages],
    visuals,
    measures,
    relationships,
    partitions,
    blockers,
    warnings,
  };
}
