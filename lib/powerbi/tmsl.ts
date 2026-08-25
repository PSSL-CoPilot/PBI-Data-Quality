/**
 * Parser for the TMSL/`DataModelSchema` document found in PBIT files and in
 * PBIP `model.bim`. This is the semantic model: tables, columns, measures with
 * their DAX, relationships and Power Query partitions.
 *
 * A PBIX's `DataModel` part is a compressed Analysis Services backup and is not
 * readable here — see `extract.ts` for how that degrades.
 */
import { findNativeQuery } from "./nativequery.ts";
import type {
  Column,
  Measure,
  Model,
  NativeQueryInfo,
  Partition,
  Relationship,
  SharedExpression,
  Table,
} from "./model.ts";

type Json = Record<string, unknown>;

const asArray = (value: unknown): Json[] =>
  Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Json[]) : [];

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

/** TMSL writes DAX and M as either a string or an array of lines. */
export function joinExpression(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const lines = value.filter((v): v is string => typeof v === "string");
    return lines.length ? lines.join("\n") : undefined;
  }
  return undefined;
}

function parseMeasure(raw: Json, table: string): Measure {
  return {
    name: String(raw.name ?? ""),
    table,
    expression: joinExpression(raw.expression) ?? "",
    formatString: str(raw.formatString),
    description: joinExpression(raw.description),
    displayFolder: str(raw.displayFolder),
    isHidden: bool(raw.isHidden),
  };
}

function parseColumn(raw: Json, table: string): Column {
  const type = str(raw.type);
  return {
    name: String(raw.name ?? ""),
    table,
    dataType: str(raw.dataType) ?? "unknown",
    kind: type === "calculated" ? "calculated" : "data",
    expression: joinExpression(raw.expression),
    formatString: str(raw.formatString),
    description: joinExpression(raw.description),
    displayFolder: str(raw.displayFolder),
    isHidden: bool(raw.isHidden),
    isKey: bool(raw.isKey),
    summarizeBy: str(raw.summarizeBy),
  };
}

function parsePartition(raw: Json, table: string): Partition {
  const source = (raw.source ?? {}) as Json;
  const declared = str(source.type) ?? "other";
  const sourceType: Partition["sourceType"] =
    declared === "m" || declared === "query" || declared === "calculated" || declared === "entity"
      ? declared
      : "other";

  // Native SQL partitions carry the statement in `query`, not `expression`.
  const expression =
    joinExpression(source.expression) ??
    joinExpression(source.query) ??
    (sourceType === "entity" ? str(source.entityName) : undefined);

  return {
    name: String(raw.name ?? ""),
    table,
    mode: str(raw.mode),
    sourceType,
    expression,
    nativeQuery: describeQuery(sourceType, expression),
  };
}

/**
 * What database query, if any, sits behind this partition.
 *
 * A native-query partition already holds the statement. An M partition usually
 * hides one inside a connector call, so the M is searched rather than shown raw
 * — a report author asking to "see the SQL" does not mean the whole M script.
 * When nothing is found the reason is carried through instead of a guess.
 */
function describeQuery(
  sourceType: Partition["sourceType"],
  expression: string | undefined
): NativeQueryInfo | undefined {
  if (sourceType === "query" && expression) {
    return { kind: "native", sql: expression, connector: "native query partition" };
  }
  if (sourceType !== "m" || !expression) return undefined;

  const found = findNativeQuery(expression);
  if (found.kind === "native") {
    return { kind: "native", sql: found.query.sql, connector: found.query.connector };
  }
  if (found.kind === "folded") {
    return { kind: "folded", connector: found.connector, reason: found.reason };
  }
  return { kind: "none", reason: found.reason };
}

function parseTable(raw: Json): Table {
  const name = String(raw.name ?? "");
  const partitions = asArray(raw.partitions).map((p) => parsePartition(p, name));
  const calculated = partitions.find((p) => p.sourceType === "calculated");

  return {
    name,
    kind: calculated ? "calculated" : "table",
    description: joinExpression(raw.description),
    dataCategory: str(raw.dataCategory),
    isHidden: bool(raw.isHidden),
    expression: calculated?.expression,
    columns: asArray(raw.columns).map((c) => parseColumn(c, name)),
    measures: asArray(raw.measures).map((m) => parseMeasure(m, name)),
    partitions,
  };
}

function parseRelationship(raw: Json, index: number): Relationship {
  const cardinality = (value: unknown, fallback: "one" | "many"): "one" | "many" =>
    value === "one" || value === "many" ? value : fallback;

  const crossFilter = str(raw.crossFilteringBehavior);
  return {
    name: String(raw.name ?? `relationship${index}`),
    fromTable: String(raw.fromTable ?? ""),
    fromColumn: String(raw.fromColumn ?? ""),
    toTable: String(raw.toTable ?? ""),
    toColumn: String(raw.toColumn ?? ""),
    // TMSL omits the defaults: many-to-one, single direction, active.
    fromCardinality: cardinality(raw.fromCardinality, "many"),
    toCardinality: cardinality(raw.toCardinality, "one"),
    crossFilteringBehavior:
      crossFilter === "bothDirections" || crossFilter === "automatic"
        ? crossFilter
        : "oneDirection",
    isActive: bool(raw.isActive, true),
  };
}

function parseExpression(raw: Json): SharedExpression {
  return {
    name: String(raw.name ?? ""),
    kind: str(raw.kind) === "m" ? "m" : "other",
    expression: joinExpression(raw.expression),
    description: joinExpression(raw.description),
  };
}

export interface TmslParts {
  tables: Table[];
  relationships: Relationship[];
  expressions: SharedExpression[];
  warnings: string[];
}

/** Parse a `DataModelSchema` / `model.bim` document. */
export function parseTmsl(document: unknown): TmslParts {
  const warnings: string[] = [];
  const root = (document ?? {}) as Json;
  const model = (root.model ?? root) as Json;

  if (!Array.isArray(model.tables)) {
    return {
      tables: [],
      relationships: [],
      expressions: [],
      warnings: ["The model schema contained no tables collection."],
    };
  }

  const tables = asArray(model.tables).map(parseTable);
  const relationships = asArray(model.relationships).map(parseRelationship);
  const expressions = asArray(model.expressions).map(parseExpression);

  // Translations rename objects per-culture; a rename must update them too, and
  // that is not implemented yet, so say so rather than quietly diverging.
  const cultures = asArray(model.cultures);
  const translated = cultures.filter((c) => {
    const translations = (c.translations ?? {}) as Json;
    return asArray(translations.model as unknown).length > 0 || "model" in translations;
  });
  if (translated.length > 0) {
    warnings.push(
      `Model defines ${translated.length} culture translation set(s). Renames will not update translated captions.`
    );
  }

  const roles = asArray(model.roles);
  if (roles.length > 0) {
    warnings.push(
      `Model defines ${roles.length} security role(s). Row-level-security DAX is preserved but not analyzed.`
    );
  }

  return { tables, relationships, expressions, warnings };
}

/** Convenience for tests and for the extractor: TMSL parts plus report pages. */
export function buildModel(
  base: Omit<Model, "tables" | "relationships" | "expressions" | "pages" | "warnings">,
  tmsl: TmslParts,
  pages: Model["pages"],
  extraWarnings: string[] = []
): Model {
  return {
    ...base,
    tables: tmsl.tables,
    relationships: tmsl.relationships,
    expressions: tmsl.expressions,
    pages,
    warnings: [...tmsl.warnings, ...extraWarnings],
  };
}
