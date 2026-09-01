/**
 * Plain-English descriptions of tables and measures, derived by rule.
 *
 * Every sentence here is assembled from something the file actually states: a
 * schema name, a selected column, a WHERE clause, a DAX function and its
 * arguments. Nothing is inferred about *business* meaning, because nothing in
 * the file says what the business means — a column called `Revenue` might be
 * gross, net, or forecast, and a tool that guesses is worse than one that
 * stays quiet.
 *
 * So the rules describe mechanics, not intent: "Calculates the total Revenue
 * from the Orders table" is a restatement of `SUM(Orders[Revenue])` and is
 * always true. "Measures company profitability" would be an invention.
 *
 * When a pattern is not recognised, the fallback names the tables involved and
 * stops. That is deliberately unsatisfying, and correct.
 */
import type { Model, Table } from "../powerbi/model.ts";
import { maskSql } from "../optimize/sql.ts";

/** Text used wherever the file does not say, so a blank is never ambiguous. */
export const UNAVAILABLE = "Unavailable";
export const NOT_DETECTED = "Not detected";
export const MULTIPLE_SOURCES = "Multiple source tables";

/* ------------------------------------------------------------------ SQL --- */

export interface SqlFacts {
  /** `dbo.Orders`, as written. */
  object?: string;
  columns: string[];
  selectsEverything: boolean;
  where?: string;
  joins: string[];
  hasGroupBy: boolean;
  hasDistinct: boolean;
  topOrLimit?: string;
}

/**
 * What a statement says about itself.
 *
 * Parsing runs over a masked copy — `maskSql` blanks string literals and
 * comments while preserving offsets — so a table name mentioned inside a
 * comment or a quoted string is never mistaken for the real one.
 */
export function readSqlFacts(sql: string): SqlFacts {
  const masked = maskSql(sql);
  const facts: SqlFacts = {
    columns: [],
    selectsEverything: false,
    joins: [],
    hasGroupBy: /\bGROUP\s+BY\b/i.test(masked),
    hasDistinct: /\bSELECT\s+DISTINCT\b/i.test(masked),
  };

  const from = /\bFROM\s+([A-Za-z0-9_$#."'`[\]]+)/i.exec(masked);
  if (from) facts.object = sql.slice(from.index + from[0].length - from[1].length, from.index + from[0].length).trim();

  const select = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(masked);
  if (select) {
    const body = sql.slice(select.index + 6, select.index + 6 + select[1].length);
    if (/^\s*(DISTINCT\s+)?\*\s*$/i.test(body)) {
      facts.selectsEverything = true;
    } else {
      facts.columns = splitTopLevel(body)
        .map(cleanColumn)
        .filter((c) => c.length > 0 && c !== "*");
      if (splitTopLevel(body).some((c) => c.trim() === "*")) facts.selectsEverything = true;
    }
  }

  // Everything between WHERE and the next clause keyword.
  const where = /\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bUNION\b|$)/i.exec(masked);
  if (where) {
    const text = sql.slice(where.index + 5, where.index + 5 + where[1].length).trim();
    if (text) facts.where = collapse(text);
  }

  for (const match of masked.matchAll(/\b(INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\s+([A-Za-z0-9_$#."'`[\]]+)/gi)) {
    const start = match.index + match[0].length - match[2].length;
    facts.joins.push(sql.slice(start, start + match[2].length).trim());
  }

  const top = /\bTOP\s+\(?\s*(\d+)/i.exec(masked) ?? /\bLIMIT\s+(\d+)/i.exec(masked);
  if (top) facts.topOrLimit = top[1];

  return facts;
}

/** Split a select list on commas that are not inside brackets. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** `o.[Order Id] AS OrderId` becomes `OrderId`. */
function cleanColumn(raw: string): string {
  let text = collapse(raw);
  const alias = /\s+AS\s+([A-Za-z0-9_$#."'`[\]]+)\s*$/i.exec(text);
  if (alias) text = alias[1];
  const last = text.split(".").pop() ?? text;
  return last.replace(/^[["'`]+|[\]"'`]+$/g, "").trim();
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * `a, b and c`, capped so a definition stays a sentence.
 *
 * When the list is truncated the final "and" moves to the remainder, because
 * "a, b and c and 19 more" reads as a mistake.
 */
function listOf(items: string[], limit = 6): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;

  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/* --------------------------------------------------------- table text --- */

/**
 * A table's definition, from whatever the file actually provides.
 *
 * A description written by the model's author always wins: it is the only
 * statement of intent in the file that is not a guess.
 */
export function describeTable(table: Table): string {
  if (table.description?.trim()) return collapse(table.description);

  if (table.calculationGroup) {
    const items = table.calculationGroup.items.map((i) => i.name);
    return `Calculation group. Applies ${items.length} calculation item${
      items.length === 1 ? "" : "s"
    } (${listOf(items)}) to the measures evaluated with it, changing what they return.`;
  }

  if (table.kind === "calculated") {
    return `Calculated table computed in the model from DAX rather than loaded from a source, with ${countOf(
      table.columns.length,
      "column"
    )}.`;
  }

  const partition = table.partitions[0];
  const sql = partition?.nativeQuery?.kind === "native" ? partition.nativeQuery.sql : undefined;

  if (sql) {
    const facts = readSqlFacts(sql);
    const parts: string[] = [];

    const source = facts.object ? `\`${facts.object}\`` : "its source";
    const rows = facts.hasDistinct ? "distinct records" : "records";
    parts.push(
      facts.where
        ? `Contains ${rows} from ${source} where ${facts.where}`
        : `Contains ${rows} from ${source}`
    );

    if (facts.selectsEverything) {
      parts.push("selecting every column the source exposes");
    } else if (facts.columns.length > 0) {
      parts.push(`including ${listOf(facts.columns)}`);
    }

    if (facts.joins.length > 0) {
      parts.push(`joined to ${listOf(facts.joins.map((j) => `\`${j}\``))}`);
    }
    if (facts.hasGroupBy) parts.push("aggregated in the source query");
    if (facts.topOrLimit) parts.push(`limited to ${facts.topOrLimit} rows`);

    let text = `${parts.join(", ")}.`;
    if (partition?.mode) text += ` Loaded in ${partition.mode} mode.`;
    if (table.refreshPolicy) {
      text += ` Under an incremental refresh policy, so it may not hold every row the query returns (${table.refreshPolicy.detail}).`;
    }
    return text;
  }

  // No statement in the file. Say what is known and no more.
  const shape = `${countOf(table.columns.length, "column")}`;
  if (partition?.nativeQuery?.kind === "folded") {
    return `Loaded through Power Query, which assembles the database query at refresh time, so the file contains no SQL statement for it. Has ${shape}.`;
  }
  return `Source query ${NOT_DETECTED.toLowerCase()} in this file. Has ${shape}.`;
}

const countOf = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ---------------------------------------------------------- measure text --- */

/** `Orders[Revenue]` and `'Order Lines'[Qty]` alike. */
const COLUMN_REF = /(?:'([^']+)'|([A-Za-z_][\w ]*))\s*\[([^\]]+)\]/;

interface ColumnRef {
  table: string;
  column: string;
}

function firstColumn(dax: string): ColumnRef | undefined {
  const m = COLUMN_REF.exec(dax);
  if (!m) return undefined;
  const table = (m[1] ?? m[2] ?? "").trim();
  // `[Measure]` with no table qualifier is a measure call, not a column.
  if (!table) return undefined;
  return { table, column: m[3].trim() };
}

/** The outermost function call in an expression, if it is a single call. */
function outerCall(dax: string): { name: string; args: string } | undefined {
  const text = stripAssignment(dax).trim();
  const m = /^([A-Z][A-Z0-9._]*)\s*\(/i.exec(text);
  if (!m) return undefined;

  let depth = 0;
  for (let i = m[0].length - 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        // Anything after the closing bracket means this is not the whole
        // expression — an arithmetic combination, say — so no single verb fits.
        if (text.slice(i + 1).trim().length > 0) return undefined;
        return { name: m[1].toUpperCase(), args: text.slice(m[0].length, i) };
      }
    }
  }
  return undefined;
}

/** DAX often arrives as `Name = expression`; the name is not part of it. */
function stripAssignment(dax: string): string {
  const eq = dax.indexOf("=");
  if (eq === -1) return dax;
  const before = dax.slice(0, eq);
  // Only strip a leading `Name =`, never an `=` inside the expression.
  return /^[\s'"[\]\w .-]+$/.test(before) && !/[()]/.test(before) ? dax.slice(eq + 1) : dax;
}

/** Simple aggregates that read one column and can be stated exactly. */
const AGGREGATES: Record<string, (c: ColumnRef) => string> = {
  SUM: (c) => `Calculates the total ${c.column} from the ${c.table} table.`,
  AVERAGE: (c) => `Calculates the average ${c.column} value from the ${c.table} table.`,
  MIN: (c) => `Returns the lowest ${c.column} value in the ${c.table} table.`,
  MAX: (c) => `Returns the highest ${c.column} value in the ${c.table} table.`,
  DISTINCTCOUNT: (c) =>
    `Calculates the distinct number of ${c.column} values from the ${c.table} table.`,
  COUNT: (c) => `Counts the ${c.table} rows with a ${c.column} value.`,
  COUNTA: (c) => `Counts the ${c.table} rows where ${c.column} is not blank.`,
  MEDIAN: (c) => `Returns the median ${c.column} value from the ${c.table} table.`,
  VALUES: (c) => `Returns the distinct ${c.column} values from the ${c.table} table.`,
};

/** Iterator functions: `SUMX(Table, expression)`. */
const ITERATORS: Record<string, string> = {
  SUMX: "total",
  AVERAGEX: "average",
  MINX: "lowest",
  MAXX: "highest",
  COUNTX: "count",
  RANKX: "rank",
};

const TIME_INTELLIGENCE: Record<string, string> = {
  TOTALYTD: "year to date",
  TOTALQTD: "quarter to date",
  TOTALMTD: "month to date",
  DATESYTD: "year to date",
  DATESQTD: "quarter to date",
  DATESMTD: "month to date",
  SAMEPERIODLASTYEAR: "the same period last year",
  PREVIOUSYEAR: "the previous year",
  PREVIOUSMONTH: "the previous month",
  PREVIOUSQUARTER: "the previous quarter",
  DATEADD: "a shifted date range",
  PARALLELPERIOD: "a parallel period",
};

/**
 * A measure's definition, derived from the shape of its DAX.
 *
 * `tables` is the dependency closure already computed for the measure, used
 * only by the fallback so that an unrecognised expression still says which
 * data it reads.
 */
export function describeMeasure(dax: string, tables: string[], description?: string): string {
  if (description?.trim()) return collapse(description);

  const expression = stripAssignment(dax).trim();
  if (!expression) return UNAVAILABLE;

  const call = outerCall(expression);

  if (call) {
    const named = describeCall(call.name, call.args, expression);
    if (named) return named;
  }

  return fallback(expression, tables);
}

function describeCall(name: string, args: string, whole: string): string | undefined {
  const column = firstColumn(args);

  if (AGGREGATES[name] && column) return AGGREGATES[name](column);

  if (name === "COUNTROWS") {
    const inner = outerCall(args.trim());
    const table = tableArgument(args);
    if (inner?.name === "FILTER") {
      const filtered = tableArgument(inner.args);
      const condition = conditionText(inner.args);
      if (filtered && condition) return `Counts ${filtered} records where ${condition}.`;
      if (filtered) return `Counts ${filtered} records matching a filter condition.`;
    }
    if (table) return `Counts the number of rows in the ${table} table.`;
    return "Counts rows in a filtered table expression.";
  }

  if (ITERATORS[name]) {
    const table = tableArgument(args);
    const verb = ITERATORS[name];
    const column = firstColumn(args.slice(args.indexOf(",") + 1));
    if (table && column) {
      return `Calculates the ${verb} of ${column.column} evaluated row by row over the ${table} table.`;
    }
    if (table) return `Calculates the ${verb} of an expression evaluated row by row over the ${table} table.`;
  }

  if (name === "DIVIDE") {
    const parts = splitTopLevel(args).map((p) => collapse(p));
    if (parts.length >= 2) {
      return `Divides ${readable(parts[0])} by ${readable(parts[1])}${
        parts.length > 2 ? ", returning an alternate result when the denominator is zero or blank" : ""
      }.`;
    }
  }

  if (name === "CALCULATE") {
    const parts = splitTopLevel(args);
    const base = collapse(parts[0] ?? "");
    const filters = parts.slice(1).map((p) => collapse(p)).filter(Boolean);

    // Time intelligence in the filter arguments is the common, readable case.
    for (const filter of filters) {
      const call = outerCall(filter);
      const period = call && TIME_INTELLIGENCE[call.name];
      if (period) return `Calculates ${readable(base)} over ${period}.`;
    }

    const inner = outerCall(base);
    const innerText = inner ? describeCall(inner.name, inner.args, base) : undefined;
    const lead = innerText ? innerText.replace(/\.$/, "") : `Calculates ${readable(base)}`;

    if (filters.length === 0) return `${lead}.`;
    const conditions = filters.map(filterArgument).filter(Boolean);
    return conditions.length > 0
      ? `${lead}, filtered to ${listOf(conditions, 3)}.`
      : `${lead}, with ${countOf(filters.length, "filter")} applied.`;
  }

  if (TIME_INTELLIGENCE[name]) {
    const parts = splitTopLevel(args).map((p) => collapse(p));
    return `Calculates ${readable(parts[0] ?? "the expression")} over ${TIME_INTELLIGENCE[name]}.`;
  }

  if (name === "IF" || name === "SWITCH") {
    const branches = splitTopLevel(args).length;
    return name === "IF"
      ? "Returns one of two results depending on a condition."
      : `Returns one of ${Math.max(1, Math.floor((branches - 1) / 2))} results depending on which case matches.`;
  }

  if (name === "RELATED" && column) {
    return `Returns the ${column.column} value from the related ${column.table} table.`;
  }

  if (name === "LOOKUPVALUE" && column) {
    return `Looks up a ${column.column} value from the ${column.table} table by matching key columns.`;
  }

  if (name === "BLANK") return "Returns a blank value.";

  // A recognised container with nothing certain inside it.
  if (name === "SUMMARIZE" || name === "ADDCOLUMNS" || name === "SELECTCOLUMNS") {
    const table = tableArgument(args);
    return table ? `Builds a table expression over the ${table} table.` : undefined;
  }

  void whole;
  return undefined;
}

/** The first argument when it is a bare table reference. */
function tableArgument(args: string): string | undefined {
  const first = splitTopLevel(args)[0];
  if (!first) return undefined;
  const text = collapse(first);
  const quoted = /^'([^']+)'$/.exec(text);
  if (quoted) return quoted[1];
  return /^[A-Za-z_][\w ]*$/.test(text) ? text : undefined;
}

/** `Orders[Status] = "Completed"` → `Status is Completed`. */
function conditionText(args: string): string | undefined {
  const parts = splitTopLevel(args);
  const condition = parts.slice(1).join(",").trim();
  if (!condition) return undefined;
  return filterText(condition);
}

/**
 * One argument of CALCULATE, read as a condition.
 *
 * A filter argument is often `FILTER ( Table, condition )` rather than a bare
 * comparison. Regexing the whole call captured the closing bracket as part of
 * the value and produced "Status is Completed )", so the call is unwrapped
 * first and only its condition is read.
 */
function filterArgument(argument: string): string {
  const call = outerCall(argument.trim());
  if (call && (call.name === "FILTER" || call.name === "KEEPFILTERS" || call.name === "ALL")) {
    if (call.name === "ALL") {
      const table = tableArgument(call.args);
      return table ? `all rows of ${table}` : "";
    }
    return conditionText(call.args) ?? filterText(call.args);
  }
  return filterText(argument);
}

function filterText(condition: string): string {
  const text = collapse(condition);
  const m = /(?:'([^']+)'|([A-Za-z_][\w ]*))\s*\[([^\]]+)\]\s*(=|<>|>=|<=|>|<)\s*(.+)$/.exec(text);
  if (!m) return text;

  const column = m[3].trim();
  const operator = m[4];
  const value = m[5].trim().replace(/^"(.*)"$/, "$1");
  const word =
    operator === "="
      ? "is"
      : operator === "<>"
        ? "is not"
        : operator === ">"
          ? "is greater than"
          : operator === "<"
            ? "is less than"
            : operator === ">="
              ? "is at least"
              : "is at most";
  return `${column} ${word} ${value}`;
}

/** A short readable form of a sub-expression, for embedding in a sentence. */
function readable(expression: string): string {
  const text = collapse(expression);
  const measure = /^\[([^\]]+)\]$/.exec(text);
  if (measure) return measure[1];

  const call = outerCall(text);
  if (call) {
    const column = firstColumn(call.args);
    if (column && AGGREGATES[call.name]) {
      const verb =
        call.name === "SUM"
          ? "total"
          : call.name === "DISTINCTCOUNT"
            ? "distinct count of"
            : call.name.toLowerCase();
      return `${verb} ${column.column}`;
    }
  }
  return text.length > 60 ? "the expression" : text;
}

/**
 * When no pattern fits.
 *
 * The tables are named because that much is known from the dependency
 * analysis; the arithmetic is not described because describing it wrongly is
 * worse than not describing it.
 */
function fallback(expression: string, tables: string[]): string {
  const named = tables.filter(Boolean);
  if (named.length === 0) {
    return "Custom calculation. The expression does not match a recognised pattern and references no table this build could resolve.";
  }
  return `Custom calculation using ${listOf(named, 4)} data. The expression does not match a recognised pattern, so it is not summarised here — see the DAX.${
    expression.length > 400 ? " The expression is long; read it in full before relying on it." : ""
  }`;
}

/** Tables whose DAX or SQL reads another table, for the table catalogue. */
export function tableDependencies(model: Model, table: Table): string[] {
  const related = new Set<string>();

  for (const relationship of model.relationships) {
    if (relationship.fromTable === table.name) related.add(relationship.toTable);
    if (relationship.toTable === table.name) related.add(relationship.fromTable);
  }

  return [...related].sort();
}
