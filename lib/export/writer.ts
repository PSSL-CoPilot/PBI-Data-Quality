/**
 * Replaying the change list onto the *original* documents.
 *
 * Slice 4 applies changes to the normalized model, which is what the UI reads.
 * Export cannot use that: the normalized model deliberately drops everything
 * this build does not understand — annotations, lineage tags, formatting hints,
 * visual layout. Writing it back out would silently delete all of it.
 *
 * So the same change list is replayed onto the parsed original JSON instead,
 * touching only the fields each change names. Everything else survives byte for
 * byte through the round trip.
 */
import type { Change } from "../edit/apply.ts";
import { renameColumnInDax, renameMeasureInDax, renameTableInDax } from "../edit/references.ts";

type Json = Record<string, unknown>;

const asArray = (value: unknown): Json[] =>
  Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Json[]) : [];

/**
 * TMSL writes DAX as a string or an array of lines. Rewrites preserve whichever
 * shape the file already used, so the exported document stays close to the
 * original and diffs stay readable.
 */
function writeExpression(previous: unknown, text: string): string | string[] {
  return Array.isArray(previous) ? text.split("\n") : text;
}

const readExpression = (value: unknown): string =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").join("\n")
    : typeof value === "string"
      ? value
      : "";

/** Every DAX-bearing slot in a TMSL document. */
function eachDaxSlot(model: Json, visit: (holder: Json, key: string) => void): void {
  for (const table of asArray(model.tables)) {
    for (const measure of asArray(table.measures)) visit(measure, "expression");
    for (const column of asArray(table.columns)) {
      if (column.type === "calculated") visit(column, "expression");
    }
    for (const partition of asArray(table.partitions)) {
      const source = partition.source as Json | undefined;
      if (source && source.type === "calculated") visit(source, "expression");
    }
  }
}

function rewriteAllDax(model: Json, rewrite: (expression: string) => string): void {
  eachDaxSlot(model, (holder, key) => {
    const current = readExpression(holder[key]);
    if (!current) return;
    const next = rewrite(current);
    if (next !== current) holder[key] = writeExpression(holder[key], next);
  });
}

const findTable = (model: Json, name: string): Json | undefined =>
  asArray(model.tables).find((t) => t.name === name);

/** Apply one change to a parsed `DataModelSchema` / `model.bim` document. */
export function applyChangeToTmsl(document: Json, change: Change): void {
  const model = (document.model ?? document) as Json;
  const { target, field, before, after } = change;

  if (target.type === "measure") {
    const table = findTable(model, target.table ?? "");
    const measure = asArray(table?.measures).find((m) => m.name === target.name);
    if (!measure) return;

    if (field === "name") {
      measure.name = after;
      rewriteAllDax(model, (expression) => renameMeasureInDax(expression, before, after).expression);
      return;
    }
    if (field === "expression") {
      measure.expression = writeExpression(measure.expression, after);
      return;
    }
    if (field === "description") {
      if (after) measure.description = after;
      else delete measure.description;
      return;
    }
    if (field === "formatString") {
      if (after) measure.formatString = after;
      else delete measure.formatString;
      return;
    }
    if (field === "homeTable") {
      const from = findTable(model, before);
      const to = findTable(model, after);
      if (!from || !to) return;
      from.measures = asArray(from.measures).filter((m) => m !== measure);
      to.measures = [...asArray(to.measures), measure];
      return;
    }
  }

  if (target.type === "column") {
    const table = findTable(model, target.table ?? "");
    const column = asArray(table?.columns).find((c) => c.name === target.name);
    if (!column) return;

    if (field === "name") {
      column.name = after;
      rewriteAllDax(model, (expression) =>
        renameColumnInDax(expression, target.table ?? "", before, after).expression
      );
      for (const rel of asArray(model.relationships)) {
        if (rel.fromTable === target.table && rel.fromColumn === before) rel.fromColumn = after;
        if (rel.toTable === target.table && rel.toColumn === before) rel.toColumn = after;
      }
      return;
    }
    if (field === "expression") {
      column.expression = writeExpression(column.expression, after);
      return;
    }
    if (field === "description") {
      if (after) column.description = after;
      else delete column.description;
      return;
    }
    if (field === "formatString") {
      if (after) column.formatString = after;
      else delete column.formatString;
      return;
    }
  }

  if (target.type === "table") {
    const table = findTable(model, target.name);
    if (!table) return;

    if (field === "name") {
      table.name = after;
      rewriteAllDax(model, (expression) => renameTableInDax(expression, before, after).expression);
      for (const rel of asArray(model.relationships)) {
        if (rel.fromTable === before) rel.fromTable = after;
        if (rel.toTable === before) rel.toTable = after;
      }
      return;
    }
    if (field === "description") {
      if (after) table.description = after;
      else delete table.description;
      return;
    }
    if (field === "expression") {
      for (const partition of asArray(table.partitions)) {
        const source = partition.source as Json | undefined;
        if (source && source.type === "calculated") {
          source.expression = writeExpression(source.expression, after);
        }
      }
      return;
    }
  }

  if (target.type === "partition" && field === "expression") {
    const table = findTable(model, target.table ?? "");
    const partition = asArray(table?.partitions).find((p) => p.name === target.name);
    const source = partition?.source as Json | undefined;
    if (!source) return;
    // Native queries hold the statement under `query`, not `expression`.
    if (typeof source.query === "string") source.query = after;
    else source.expression = writeExpression(source.expression, after);
  }
}

// ------------------------------------------------------------ report layout

/**
 * Report bindings name a field in several coordinated places: the `Property` on
 * the reference, a `Table.Field` composite used as the query name, and the
 * `queryRef` that visual roles point at. All of them have to move together or
 * the visual loses its binding, so the rewrite walks the whole document rather
 * than targeting known paths.
 */
interface LayoutRename {
  kind: "measure" | "column" | "entity";
  table: string;
  from: string;
  to: string;
  /** The table name after the change, which differs only for table renames. */
  toTable: string;
}

/**
 * Keys whose string value is a structural identifier rather than something a
 * reader sees. Only these are rewritten: a textbox caption or a visual title
 * can easily equal a table or measure name, and rewriting those would silently
 * edit the report's wording.
 *
 * `NativeReferenceName` is deliberately excluded. It is the column caption, so
 * leaving it stale is cosmetic, whereas rewriting it would overwrite a heading
 * the author may have customised.
 */
const IDENTIFIER_KEYS = new Set(["Name", "queryRef", "queryName"]);

/**
 * Fields whose value is a whole JSON document encoded as a string. The visual
 * definition lives inside `config`, so a walker that does not open these never
 * reaches a single binding.
 */
const NESTED_JSON_FIELDS = new Set(["config", "filters", "query", "dataTransforms"]);

/** Rewrite inside a string-encoded document, re-encoding it the same way. */
function renameInNestedJson(value: string, rename: LayoutRename): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return JSON.stringify(renameInLayoutNode(parsed, rename));
  } catch {
    // Not JSON after all; leave it exactly as it was.
    return value;
  }
}

function renameInLayoutNode(node: unknown, rename: LayoutRename): unknown {
  if (Array.isArray(node)) return node.map((item) => renameInLayoutNode(item, rename));
  if (!node || typeof node !== "object") return node;

  const current = node as Json;
  const out: Json = {};

  for (const [key, value] of Object.entries(current)) {
    if (NESTED_JSON_FIELDS.has(key) && typeof value === "string") {
      out[key] = renameInNestedJson(value, rename);
      continue;
    }

    // A reference node: {Measure|Column: {Expression: …, Property: "Name"}}
    if ((key === "Measure" || key === "Column") && value && typeof value === "object") {
      const ref = { ...(value as Json) };
      const wanted = rename.kind === "measure" ? "Measure" : "Column";
      if (rename.kind !== "entity" && key === wanted && ref.Property === rename.from) {
        ref.Property = rename.to;
      }
      out[key] = renameInLayoutNode(ref, rename);
      continue;
    }

    if (key === "Entity" && typeof value === "string" && value === rename.table) {
      out[key] = rename.toTable;
      continue;
    }

    if (typeof value === "string") {
      out[key] = IDENTIFIER_KEYS.has(key) ? renameComposite(value, rename) : value;
      continue;
    }

    out[key] = renameInLayoutNode(value, rename);
  }

  return out;
}

/** Rewrite the `Table.Field` composites used as query identifiers. */
function renameComposite(value: string, rename: LayoutRename): string {
  if (rename.kind === "entity") {
    // Only the leading segment of the composite is the entity name.
    if (value === rename.table) return rename.toTable;
    return value.startsWith(`${rename.table}.`)
      ? `${rename.toTable}${value.slice(rename.table.length)}`
      : value;
  }

  return value === `${rename.table}.${rename.from}` ? `${rename.toTable}.${rename.to}` : value;
}

/**
 * Apply one change to a parsed `Report/Layout` document.
 *
 * Only renames affect the report; DAX, description and format edits live purely
 * in the model. Returns the document unchanged for those.
 */
export function applyChangeToLayout(document: unknown, change: Change): unknown {
  const { target, field, before, after } = change;

  if (field === "name") {
    if (target.type === "measure") {
      return renameInLayoutNode(document, {
        kind: "measure",
        table: target.table ?? "",
        from: before,
        to: after,
        toTable: target.table ?? "",
      });
    }
    if (target.type === "column") {
      return renameInLayoutNode(document, {
        kind: "column",
        table: target.table ?? "",
        from: before,
        to: after,
        toTable: target.table ?? "",
      });
    }
    if (target.type === "table") {
      return renameInLayoutNode(document, {
        kind: "entity",
        table: before,
        from: before,
        to: after,
        toTable: after,
      });
    }
  }

  if (field === "homeTable" && target.type === "measure") {
    // The measure keeps its name but now belongs to a different entity.
    return renameInLayoutNode(document, {
      kind: "measure",
      table: before,
      from: target.name,
      to: target.name,
      toTable: after,
    });
  }

  return document;
}
