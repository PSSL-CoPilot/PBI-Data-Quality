/**
 * Normalized Power BI model. Every extractor (PBIT/PBIP today, a Windows TOM
 * companion later) produces this shape, and QA, optimization, editing,
 * validation and export all consume only this. Adding a source format must
 * never require touching anything downstream of here.
 */

/** What the uploaded file actually let us read. Never assume, always record. */
export type CapabilityId = "model" | "report" | "powerQuery" | "runtime";
export type Capability = { available: true } | { available: false; reason: string };

export type ObjectType =
  | "table"
  | "column"
  | "measure"
  | "relationship"
  | "page"
  | "visual"
  | "partition";

export interface Measure {
  name: string;
  table: string;
  expression: string;
  formatString?: string;
  description?: string;
  displayFolder?: string;
  isHidden: boolean;
}

export interface Column {
  name: string;
  table: string;
  dataType: string;
  /** "calculated" carries a DAX `expression`; "data" comes from the source. */
  kind: "data" | "calculated";
  expression?: string;
  formatString?: string;
  description?: string;
  displayFolder?: string;
  isHidden: boolean;
  isKey: boolean;
  summarizeBy?: string;
  /** Only present when the source format reports it (PBIT rarely does). */
  cardinality?: number;
}

export interface Partition {
  name: string;
  table: string;
  mode?: string;
  /** `m` = Power Query, `query` = native SQL, `calculated` = calculated table. */
  sourceType: "m" | "query" | "calculated" | "entity" | "other";
  expression?: string;
}

export interface Table {
  name: string;
  kind: "table" | "calculated";
  description?: string;
  /** "Time" is what "Mark as date table" sets; needed for time-intelligence QA. */
  dataCategory?: string;
  isHidden: boolean;
  /** Calculated-table DAX, when `kind` is "calculated". */
  expression?: string;
  columns: Column[];
  measures: Measure[];
  partitions: Partition[];
}

export interface Relationship {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromCardinality: "one" | "many";
  toCardinality: "one" | "many";
  crossFilteringBehavior: "oneDirection" | "bothDirections" | "automatic";
  isActive: boolean;
}

/** A field binding found inside a visual, used for report-side dependencies. */
export interface FieldRef {
  table?: string;
  field: string;
  kind: "measure" | "column" | "hierarchy" | "unknown";
}

export interface Visual {
  id: string;
  page: string;
  type: string;
  title?: string;
  /**
   * Static text shown by a textbox or shape. Carries no data binding, but it is
   * what a report author writes above a card, so KPI-name inference reads it.
   */
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  refs: FieldRef[];
}

export interface Page {
  name: string;
  displayName: string;
  ordinal: number;
  isHidden: boolean;
  width: number;
  height: number;
  visuals: Visual[];
}

/** A model-level shared M expression: a parameter or a reusable query. */
export interface SharedExpression {
  name: string;
  kind: "m" | "other";
  expression?: string;
  description?: string;
}

export interface Model {
  source: {
    fileName: string;
    format: "pbit" | "pbix" | "pbip";
    sizeBytes: number;
    extractedAt: string;
  };
  capabilities: Record<CapabilityId, Capability>;
  tables: Table[];
  relationships: Relationship[];
  /** Model-level shared queries and parameters (Power Query "Other Queries"). */
  expressions: SharedExpression[];
  pages: Page[];
  /** Non-fatal extraction notes. Surfaced in the UI, never swallowed. */
  warnings: string[];
}

/**
 * Stable identity for every model object. QA findings, edits, dependency edges
 * and validation errors all key off these, so the format must stay stable.
 */
export function objectKey(
  type: ObjectType,
  table: string | undefined,
  name: string
): string {
  return table ? `${type}:${table}[${name}]` : `${type}:${name}`;
}

export const measureKey = (m: { table: string; name: string }) =>
  objectKey("measure", m.table, m.name);
export const columnKey = (c: { table: string; name: string }) =>
  objectKey("column", c.table, c.name);
export const tableKey = (t: { name: string }) => objectKey("table", undefined, t.name);

/** Flattened accessors — used constantly downstream, so define them once. */
export const allMeasures = (model: Model): Measure[] =>
  model.tables.flatMap((t) => t.measures);
export const allColumns = (model: Model): Column[] =>
  model.tables.flatMap((t) => t.columns);
export const allVisuals = (model: Model): Visual[] =>
  model.pages.flatMap((p) => p.visuals);
export const allPartitions = (model: Model): Partition[] =>
  model.tables.flatMap((t) => t.partitions);

export function findMeasure(model: Model, name: string): Measure | undefined {
  return allMeasures(model).find((m) => m.name === name);
}

export function findTable(model: Model, name: string): Table | undefined {
  return model.tables.find((t) => t.name === name);
}

export const unavailable = (reason: string): Capability => ({ available: false, reason });
export const available = (): Capability => ({ available: true });
