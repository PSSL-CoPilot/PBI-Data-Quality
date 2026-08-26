/**
 * Detecting Power BI tables that are really the same source table loaded twice.
 *
 * A common pattern: someone needs four measures, so they import the same view
 * four times under four names, each selecting a different column. The model
 * carries four copies of the same rows, four refreshes, and four sets of
 * relationships to maintain.
 *
 * Merging them is only safe when the merged table would return *exactly* the
 * rows every member already returns. That means the same source object, the
 * same filters, the same joins and the same grain. Anything else changes what a
 * measure sees, and a KPI that quietly shifts is far worse than a duplicate
 * table nobody noticed.
 *
 * So this module is deliberately reluctant. It reports what it is confident
 * about, and where it cannot establish equivalence it says so and offers no
 * Apply. Names are never evidence: two tables called Orders_A and Orders_B
 * prove nothing, and two tables with unrelated names may still be identical.
 */
import type { Model, Table } from "../powerbi/model.ts";
import { allMeasures } from "../powerbi/model.ts";
import type { Change } from "../edit/apply.ts";
import { renameTableInDax } from "../edit/references.ts";
import { replaceNativeQuery, tokenizeM } from "../powerbi/nativequery.ts";
import { maskSql } from "./sql.ts";

/** How a table's rows are shaped, which must match for a merge to be safe. */
export type Grain = "row" | "aggregated" | "distinct" | "unknown";

export interface TableSource {
  table: string;
  connector?: string;
  server?: string;
  database?: string;
  /** The schema-qualified object the rows come from, when identifiable. */
  object?: string;
  sql?: string;
  /** Columns the query selects; empty when it selects everything. */
  selected: string[];
  /** Normalised WHERE text, or undefined when there is no filter. */
  filter?: string;
  joins: number;
  grain: Grain;
  /** Power Query steps beyond connecting and navigating. */
  transforms: string[];
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The `Sql.Database("server", "db", ...)` arguments, when present. */
function connectionOf(m: string): { connector?: string; server?: string; database?: string } {
  const tokens = tokenizeM(m);
  for (let i = 0; i < tokens.length - 2; i++) {
    const token = tokens[i];
    if (token.kind !== "identifier" || !/\.(Database|Databases)$/.test(token.value)) continue;
    if (tokens[i + 1]?.value !== "(") continue;

    const args: string[] = [];
    for (let j = i + 2; j < tokens.length && args.length < 2; j++) {
      if (tokens[j].kind === "string") args.push(tokens[j].value);
      else if (tokens[j].kind === "punct" && tokens[j].value === ")") break;
    }
    return { connector: token.value, server: args[0], database: args[1] };
  }
  return {};
}

/** `Source{[Schema="dbo",Item="Orders"]}[Data]` names its object directly. */
function navigationObject(m: string): string | undefined {
  const schema = /Schema\s*=\s*"([^"]+)"/.exec(m)?.[1];
  const item = /Item\s*=\s*"([^"]+)"/.exec(m)?.[1];
  if (item) return schema ? `${schema}.${item}` : item;
  return undefined;
}

/** The single object a statement reads, or undefined when it reads several. */
function sqlObject(sql: string): string | undefined {
  const masked = maskSql(sql);
  if (/\bJOIN\b/i.test(masked)) return undefined;
  const from = /\bFROM\s+([A-Za-z_][\w.]*)/i.exec(masked);
  return from?.[1];
}

function sqlColumns(sql: string): string[] {
  const masked = maskSql(sql);
  const match = /\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s*\(?\s*\d+\s*\)?\s+)?([\s\S]*?)\bFROM\b/i.exec(
    masked
  );
  if (!match) return [];
  const body = match[1].trim();
  if (body === "*") return [];
  // A projection with a function or an alias is not a plain column list.
  return body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^\w+\./, "").replace(/[[\]"`]/g, ""));
}

function sqlGrain(sql: string): Grain {
  const masked = maskSql(sql);
  if (/\bGROUP\s+BY\b/i.test(masked)) return "aggregated";
  if (/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(masked)) return "aggregated";
  if (/\bSELECT\s+DISTINCT\b/i.test(masked)) return "distinct";
  return "row";
}

function sqlFilter(sql: string): string | undefined {
  const masked = maskSql(sql);
  const where = /\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|$)/i.exec(masked);
  return where ? normalise(where[1]) : undefined;
}

/**
 * Power Query steps that are not simply connecting and navigating.
 *
 * Any of these can change which rows or columns arrive, so two tables that
 * differ here are not interchangeable however similar their source looks.
 */
function transformSteps(m: string): string[] {
  const steps: string[] = [];
  for (const match of m.matchAll(/\b(Table|Text|Value|List|Record)\.[A-Za-z]+/g)) {
    const step = match[0];
    // Navigation and type declarations do not change the row set.
    if (/^Table\.(TransformColumnTypes|AddKey)$/.test(step)) continue;
    steps.push(step);
  }
  return [...new Set(steps)];
}

/** Everything known about where a table's rows come from. */
export function describeSource(table: Table): TableSource {
  const partition = table.partitions[0];
  const m = partition?.expression ?? "";
  const native = partition?.nativeQuery;
  const sql = native?.kind === "native" ? native.sql : undefined;

  const connection = connectionOf(m);
  const object = sql ? sqlObject(sql) : navigationObject(m);

  return {
    table: table.name,
    ...connection,
    object,
    sql,
    // Without a statement the model's own column list is what the table exposes.
    selected: sql ? sqlColumns(sql) : table.columns.map((c) => c.name),
    filter: sql ? sqlFilter(sql) : undefined,
    joins: sql ? (maskSql(sql).match(/\bJOIN\b/gi) ?? []).length : 0,
    grain: sql ? sqlGrain(sql) : partition ? "row" : "unknown",
    transforms: transformSteps(m),
  };
}

export type DuplicateVerdict = "exact" | "compatible" | "unsafe";

export interface DuplicateGroup {
  /** The table the others would fold into. */
  canonical: string;
  members: string[];
  verdict: DuplicateVerdict;
  /** Why this is or is not safe, in the user's terms. */
  reasons: string[];
  /** Present when the verdict is unsafe: what would have to change first. */
  blockers: string[];
  /** The shared source, for display. */
  object: string;
  /** A single statement covering every member's columns, when safe. */
  consolidatedSql?: string;
  measuresAffected: string[];
  calculatedColumnsAffected: string[];
  pagesAffected: string[];
  relationshipsAffected: number;
  /** Tables that would no longer be referenced afterwards. */
  removable: string[];
}

/** A key that two tables must share before a merge is even considered. */
const sourceKey = (s: TableSource) =>
  [s.connector ?? "?", s.server ?? "?", s.database ?? "?", s.object ?? "?"]
    .map((p) => p.toLowerCase())
    .join("|");

function measuresReading(model: Model, table: string): string[] {
  return allMeasures(model)
    .filter((m) => renameTableInDax(m.expression, table, "__probe__").replaced > 0)
    .map((m) => `${m.table}[${m.name}]`);
}

function calculatedColumnsReading(model: Model, table: string): string[] {
  return model.tables
    .flatMap((t) => t.columns)
    .filter(
      (c) =>
        c.kind === "calculated" &&
        c.expression &&
        renameTableInDax(c.expression, table, "__probe__").replaced > 0
    )
    .map((c) => `${c.table}[${c.name}]`);
}

function pagesUsing(model: Model, tables: string[]): string[] {
  const set = new Set(tables);
  return model.pages
    .filter((page) =>
      page.visuals.some((visual) => visual.refs.some((ref) => ref.table && set.has(ref.table)))
    )
    .map((page) => page.displayName);
}

/**
 * Pick the table the others fold into.
 *
 * The source object's own name is the clearest choice when a table already
 * carries it; otherwise the member exposing the most columns, since it needs
 * the fewest additions.
 */
function chooseCanonical(members: TableSource[], object: string): string {
  const bare = object.includes(".") ? object.slice(object.lastIndexOf(".") + 1) : object;
  const named = members.find((m) => m.table.toLowerCase() === bare.toLowerCase());
  if (named) return named.table;
  return [...members].sort((a, b) => b.selected.length - a.selected.length)[0].table;
}

/** One statement selecting every column the members between them need. */
function consolidatedStatement(members: TableSource[], object: string): string | undefined {
  const columns: string[] = [];
  for (const member of members) {
    // A member selecting everything makes the union unknowable.
    if (member.selected.length === 0) return undefined;
    for (const column of member.selected) {
      if (!columns.some((c) => c.toLowerCase() === column.toLowerCase())) columns.push(column);
    }
  }
  if (columns.length === 0) return undefined;
  return `SELECT\n    ${columns.join(",\n    ")}\nFROM ${object}`;
}

/**
 * Groups of tables reading the same source, each with a verdict.
 *
 * Two passes. First by source: connector, server, database and object must all
 * match before anything is considered, so names never enter the judgement.
 * Then by *compatibility*: filter, grain, joins and Power Query steps, because
 * those decide which rows a table returns.
 *
 * The second pass matters more than it looks. Grouping on the source alone let
 * a single filtered table make four genuinely identical tables unsafe, and the
 * real recommendation was lost. Each compatible subset now stands on its own,
 * and tables that read the same object but cannot merge are still reported —
 * as "needs review", with no Apply.
 */
export function findDuplicateTables(model: Model): DuplicateGroup[] {
  if (!model.capabilities.model.available) return [];

  const sources = model.tables
    .filter((t) => t.kind !== "calculated" && t.partitions.length > 0)
    .map(describeSource)
    .filter((s) => s.object !== undefined);

  const byKey = new Map<string, TableSource[]>();
  for (const source of sources) {
    const key = sourceKey(source);
    byKey.set(key, [...(byKey.get(key) ?? []), source]);
  }

  const groups: DuplicateGroup[] = [];

  for (const sharing of byKey.values()) {
    if (sharing.length < 2) continue;
    const object = sharing[0].object!;

    const bySignature = new Map<string, TableSource[]>();
    for (const source of sharing) {
      const signature = [
        source.filter ?? "",
        source.grain,
        String(source.joins),
        source.transforms.slice().sort().join(","),
      ].join("|");
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), source]);
    }

    // Any compatible subset of two or more can be merged on its own terms.
    for (const members of bySignature.values()) {
      if (members.length < 2) continue;

      // A join changes the row set, so it is never merged even within a subset.
      if (members.some((m) => m.joins > 0)) continue;

      const canonical = chooseCanonical(members, object);
      const others = members.filter((m) => m.table !== canonical).map((m) => m.table);
      const allTables = members.map((m) => m.table);

      const sameColumns =
        new Set(members.map((m) => m.selected.slice().sort().join(",").toLowerCase())).size === 1;

      const verdict: DuplicateVerdict = sameColumns ? "exact" : "compatible";
      const reasons = [
        sameColumns
          ? `All ${members.length} tables read ${object} and select the same columns.`
          : `All ${members.length} tables read ${object} with the same filters, grain and Power Query steps, differing only in which columns they select.`,
        "The merged table returns the same rows, so measure results do not change.",
      ];

      groups.push({
        canonical,
        members: allTables,
        verdict,
        reasons,
        blockers: [],
        object,
        consolidatedSql: consolidatedStatement(members, object),
        measuresAffected: [...new Set(others.flatMap((t) => measuresReading(model, t)))],
        calculatedColumnsAffected: [
          ...new Set(others.flatMap((t) => calculatedColumnsReading(model, t))),
        ],
        pagesAffected: pagesUsing(model, allTables),
        relationshipsAffected: model.relationships.filter(
          (r) => others.includes(r.fromTable) || others.includes(r.toTable)
        ).length,
        removable: others,
      });
    }

    // Tables that read the same object but land in different buckets are
    // "similar but unsafe": worth knowing about, never worth merging blindly.
    if (bySignature.size > 1) {
      const blockers: string[] = [];
      const values = [...bySignature.values()];

      if (new Set(sharing.map((m) => m.filter ?? "")).size > 1) {
        blockers.push(
          "They apply different filters, so one table would show rows another deliberately excludes."
        );
      }
      if (new Set(sharing.map((m) => m.grain)).size > 1) {
        blockers.push(
          `They do not share a grain (${[...new Set(sharing.map((m) => m.grain))].join(", ")}), so merging would change what each measure counts.`
        );
      }
      if (new Set(sharing.map((m) => m.transforms.slice().sort().join(","))).size > 1) {
        blockers.push(
          "They apply different Power Query steps, so their contents are not interchangeable."
        );
      }
      if (sharing.some((m) => m.joins > 0)) {
        blockers.push("At least one joins other tables, which changes the rows it returns.");
      }

      groups.push({
        canonical: chooseCanonical(sharing, object),
        members: sharing.map((m) => m.table),
        verdict: "unsafe",
        reasons: [
          `${sharing.length} tables read ${object}, in ${values.length} incompatible variations.`,
        ],
        blockers: blockers.length
          ? blockers
          : ["They differ in a way that could change which rows a measure sees."],
        object,
        consolidatedSql: undefined,
        measuresAffected: [
          ...new Set(sharing.flatMap((m) => measuresReading(model, m.table))),
        ],
        calculatedColumnsAffected: [
          ...new Set(sharing.flatMap((m) => calculatedColumnsReading(model, m.table))),
        ],
        pagesAffected: pagesUsing(model, sharing.map((m) => m.table)),
        relationshipsAffected: 0,
        removable: [],
      });
    }
  }

  // Most tables removed first: that is the order a reviewer cares about, and
  // "needs review" entries sort last because they carry no action.
  return groups.sort((a, b) => b.removable.length - a.removable.length);
}

/**
 * The edits that carry out a consolidation.
 *
 * Every one is an ordinary change: the same kind the editor produces, applied
 * the same way, listed in Pending Changes and undoable individually. Nothing
 * here is a special path, which is what makes it reversible.
 *
 * Tables are never deleted. References are rewritten so that nothing points at
 * the duplicates any more, and the now-unreferenced tables are *reported* as
 * removable. Dropping a table also drops its relationships and its place in the
 * report, so that decision stays with the person doing the review.
 */
export interface ConsolidationPlan {
  group: DuplicateGroup;
  changes: Change[];
  /** What the reviewer is agreeing to, in plain counts. */
  summary: {
    tablesRemovable: number;
    canonical: string;
    measuresRewritten: number;
    calculatedColumnsRewritten: number;
    visualsAffected: number;
    relationshipsAffected: number;
  };
  /** Anything the rewrite could not resolve and a human must check. */
  warnings: string[];
}

let planCounter = 0;
const planId = () => `dup-${++planCounter}-${Math.random().toString(36).slice(2, 8)}`;

export function planConsolidation(
  model: Model,
  group: DuplicateGroup,
  at = Date.now()
): ConsolidationPlan | undefined {
  if (group.verdict === "unsafe") return undefined;

  const changes: Change[] = [];
  const warnings: string[] = [];
  const duplicates = group.members.filter((m) => m !== group.canonical);

  // Point every DAX reference at the canonical table.
  let measuresRewritten = 0;
  for (const measure of allMeasures(model)) {
    let expression = measure.expression;
    let touched = false;

    for (const duplicate of duplicates) {
      const outcome = renameTableInDax(expression, duplicate, group.canonical);
      if (outcome.replaced > 0) {
        expression = outcome.expression;
        touched = true;
      }
      // An unqualified table reference cannot be rewritten safely, and leaving
      // it silently would point a measure at a table that no longer feeds it.
      for (const unresolved of outcome.unresolved) {
        warnings.push(`${measure.table}[${measure.name}]: ${unresolved}`);
      }
    }

    if (touched && expression !== measure.expression) {
      measuresRewritten++;
      changes.push({
        id: planId(),
        target: { type: "measure", table: measure.table, name: measure.name },
        field: "expression",
        before: measure.expression,
        after: expression,
        at,
      });
    }
  }

  // The same for calculated columns, which read tables just as measures do.
  let columnsRewritten = 0;
  for (const table of model.tables) {
    for (const column of table.columns) {
      if (column.kind !== "calculated" || !column.expression) continue;
      let expression = column.expression;
      let touched = false;

      for (const duplicate of duplicates) {
        const outcome = renameTableInDax(expression, duplicate, group.canonical);
        if (outcome.replaced > 0) {
          expression = outcome.expression;
          touched = true;
        }
      }

      if (touched && expression !== column.expression) {
        columnsRewritten++;
        changes.push({
          id: planId(),
          target: { type: "column", table: column.table, name: column.name },
          field: "expression",
          before: column.expression,
          after: expression,
          at,
        });
      }
    }
  }

  // Widen the canonical table's query to cover every column the others fed.
  const canonicalTable = model.tables.find((t) => t.name === group.canonical);
  const partition = canonicalTable?.partitions[0];
  if (group.consolidatedSql && partition?.expression) {
    const rewritten = replaceNativeQuery(partition.expression, group.consolidatedSql);
    if (rewritten && rewritten !== partition.expression) {
      changes.push({
        id: planId(),
        target: { type: "partition", table: group.canonical, name: partition.name },
        field: "expression",
        before: partition.expression,
        after: rewritten,
        at,
      });
    } else if (!rewritten) {
      warnings.push(
        `The canonical table's source could not be widened automatically, so ${group.canonical} may not yet select every column the other tables provided.`
      );
    }
  } else if (!group.consolidatedSql) {
    warnings.push(
      "No single statement could be written for the merged table, so its source still has to be widened by hand."
    );
  }

  const visualsAffected = model.pages
    .flatMap((p) => p.visuals)
    .filter((v) => v.refs.some((r) => r.table && group.members.includes(r.table))).length;

  return {
    group,
    changes,
    summary: {
      tablesRemovable: duplicates.length,
      canonical: group.canonical,
      measuresRewritten,
      calculatedColumnsRewritten: columnsRewritten,
      visualsAffected,
      relationshipsAffected: group.relationshipsAffected,
    },
    warnings,
  };
}
