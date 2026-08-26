/**
 * Deterministic SQL review for the native queries behind Power BI tables.
 *
 * Every rule is a pattern match over tokenised SQL — no execution, no plan, no
 * statistics. That bounds what can honestly be said: a rule may report that a
 * predicate cannot use an index, never that removing it makes the query faster.
 * Nothing here is benchmarked and the wording says so.
 *
 * Comments and string literals are blanked before any scan, so `-- SELECT *` in
 * a comment and `'%wildcard%'` in a literal cannot raise findings.
 *
 * Rules are dialect-aware. A SQL Server hint means nothing to BigQuery, and
 * `SELECT *` costs far more on a columnar biller than on a row store, so both
 * applicability and impact vary by source.
 */

export type SqlDialect =
  | "sqlserver"
  | "postgres"
  | "snowflake"
  | "bigquery"
  | "oracle"
  | "mysql"
  | "redshift"
  | "generic";

export type SqlImpact = "high" | "medium" | "low";

/** Which connector produced the statement tells us how to read it. */
export function dialectFromConnector(connector: string): SqlDialect {
  const map: Record<string, SqlDialect> = {
    "Sql.Database": "sqlserver",
    "Sql.Databases": "sqlserver",
    "PostgreSQL.Database": "postgres",
    "Snowflake.Databases": "snowflake",
    "GoogleBigQuery.Database": "bigquery",
    "Oracle.Database": "oracle",
    "MySQL.Database": "mysql",
    "AmazonRedshift.Database": "redshift",
  };
  return map[connector] ?? "generic";
}

export const DIALECT_LABEL: Record<SqlDialect, string> = {
  sqlserver: "SQL Server",
  postgres: "PostgreSQL",
  snowflake: "Snowflake",
  bigquery: "BigQuery",
  oracle: "Oracle",
  mysql: "MySQL",
  redshift: "Amazon Redshift",
  generic: "SQL",
};

/** Sources that bill by bytes scanned, where reading extra columns costs money. */
const COLUMNAR_BILLED: SqlDialect[] = ["bigquery", "snowflake", "redshift"];

/**
 * Blank comments and string literals while preserving every offset, so a match
 * position in the masked text is the same position in the original.
 */
export function maskSql(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (two === "/*") {
      while (i < sql.length && sql.slice(i, i + 2) !== "*/") {
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }

    if (sql[i] === "'") {
      out += " ";
      i++;
      while (i < sql.length) {
        // '' is an escaped quote inside a SQL string.
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "  ";
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      continue;
    }

    out += sql[i];
    i++;
  }

  return out;
}

const count = (masked: string, pattern: RegExp) => (masked.match(pattern) ?? []).length;

export interface SqlContext {
  dialect: SqlDialect;
  /** Columns the model actually loaded, used to expand `SELECT *`. */
  columns?: string[];
  /** Import tables are read once; a DirectQuery source is hit per visual. */
  mode?: string;
}

export interface SqlRewrite {
  suggested: string;
  confidence: "high" | "medium";
  /** Stated whenever results could differ, not only when they will. */
  behaviourChange?: string;
}

export interface SqlFinding {
  ruleId: string;
  title: string;
  impact: SqlImpact;
  /** What was found, in this specific statement. */
  detail: string;
  /** Why it matters, in terms of work the source has to do. */
  why: string;
  recommendation: string;
  source: { title: string; url: string };
  rewrite?: SqlRewrite;
}

/** What a rule reports when it matches. */
interface SqlHit {
  detail: string;
  /** Overrides the rule default where the same issue costs more on this source. */
  impact?: SqlImpact;
  rewrite?: SqlRewrite;
}

interface SqlRule {
  id: string;
  title: string;
  impact: SqlImpact;
  /** Omitted means every dialect. */
  dialects?: SqlDialect[];
  why: string;
  recommendation: string;
  source: { title: string; url: string };
  detect(sql: string, masked: string, ctx: SqlContext): SqlHit | undefined;
}

const MS_INDEX_DESIGN = {
  title: "Microsoft Learn — SQL Server index design guide",
  url: "https://learn.microsoft.com/sql/relational-databases/sql-server-index-design-guide",
};
const MS_FOLDING = {
  title: "Microsoft Learn — Power Query query folding guidance",
  url: "https://learn.microsoft.com/power-query/power-query-folding",
};
const MS_IMPORT = {
  title: "Microsoft Learn — Reduce data loaded into semantic models",
  url: "https://learn.microsoft.com/power-bi/guidance/import-modeling-data-reduction",
};

/** Quote an identifier the way this dialect expects. */
function quoteIdentifier(name: string, dialect: SqlDialect): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  if (dialect === "sqlserver") return `[${name}]`;
  if (dialect === "mysql") return `\`${name}\``;
  return `"${name}"`;
}

/** True when the statement pages or limits rows, so ordering is meaningful. */
const ordersForLimit = (masked: string) =>
  /\b(TOP\s*\(?\s*\d|LIMIT\b|FETCH\s+(FIRST|NEXT)|OFFSET\b|ROW_NUMBER\s*\()/i.test(masked);

const RULES: SqlRule[] = [
  {
    id: "SQL-SELECT-STAR",
    title: "Query selects every column",
    impact: "high",
    why: "The source reads, and the gateway transfers, every column in the table — including ones the report never uses. A column added upstream later silently joins the load.",
    recommendation: "List only the columns the model needs.",
    source: MS_IMPORT,
    detect(sql, masked, ctx) {
      if (!/\bSELECT\s+(DISTINCT\s+|TOP\s*\(?\s*\d+\s*\)?\s+)*\*/i.test(masked)) return undefined;

      const columnar = COLUMNAR_BILLED.includes(ctx.dialect);
      const detail = columnar
        ? `Selects every column. On ${DIALECT_LABEL[ctx.dialect]} the bill is based on the data scanned, so unused columns are charged for on every refresh.`
        : "Selects every column, including any the report does not use.";

      // The model knows exactly which columns were loaded, which makes the
      // expansion an accurate rewrite rather than a guess. Only attempted when
      // there is a single `*` to replace.
      const stars = count(masked, /(?<![\w.])\*(?![\w])/g);
      const columns = ctx.columns ?? [];
      const rewrite =
        stars === 1 && columns.length > 0
          ? {
              suggested: sql.replace(
                /(\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s*\(?\s*\d+\s*\)?\s+)?)\*/i,
                (_m, prefix: string) =>
                  `${prefix}${columns.map((c) => quoteIdentifier(c, ctx.dialect)).join(", ")}`
              ),
              confidence: "high" as const,
              behaviourChange:
                "Lists the columns this table currently loads. If the report is later changed to need another column, it must be added here too.",
            }
          : undefined;

      return { detail, impact: columnar ? "high" : "medium", rewrite };
    },
  },
  {
    id: "SQL-ORDER-BY",
    title: "Source query sorts rows",
    impact: "medium",
    why: "Power BI does not preserve source order — the model stores rows in its own compressed layout — so the sort is work the database performs and the result throws away.",
    recommendation: "Remove ORDER BY unless it pairs with a row limit.",
    source: MS_IMPORT,
    detect(sql, masked) {
      if (!/\bORDER\s+BY\b/i.test(masked)) return undefined;
      // With TOP/LIMIT the ordering decides which rows arrive; removing it
      // would change the result, so it is left alone.
      if (ordersForLimit(masked)) return undefined;

      const index = masked.search(/\bORDER\s+BY\b/i);
      const trailing = masked.slice(index);
      // Only a trailing ORDER BY can be removed without touching structure.
      if (/[)]/.test(trailing)) return undefined;

      return {
        detail: "Ends with ORDER BY, and the ordering is discarded when the rows load.",
        rewrite: {
          suggested: sql.slice(0, index).replace(/\s+$/, ""),
          confidence: "high" as const,
        },
      };
    },
  },
  {
    id: "SQL-NON-SARGABLE-YEAR",
    title: "Function wraps a filtered date column",
    impact: "high",
    why: "Wrapping a column in a function stops the database using an index on it, so the filter is evaluated row by row across the whole table.",
    recommendation: "Compare the bare column to a date range instead.",
    source: MS_INDEX_DESIGN,
    detect(sql, masked) {
      const match = /\bYEAR\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s*=\s*(\d{4})\b/i.exec(masked);
      if (!match) return undefined;
      const [whole, column, year] = match;
      const next = Number(year) + 1;

      return {
        detail: `\`YEAR(${column}) = ${year}\` prevents an index on ${column} from being used.`,
        rewrite: {
          suggested:
            sql.slice(0, match.index) +
            `${column} >= '${year}-01-01' AND ${column} < '${next}-01-01'` +
            sql.slice(match.index + whole.length),
          confidence: "medium" as const,
          behaviourChange:
            "Equivalent for date and datetime columns. If the column stores text, the comparison becomes a string comparison and must be checked.",
        },
      };
    },
  },
  {
    id: "SQL-NON-SARGABLE-FUNCTION",
    title: "Function applied to a filtered column",
    impact: "medium",
    why: "An index is built over stored values, not over the result of a function, so the database has to compute the expression for every row before it can filter.",
    recommendation: "Rewrite the predicate so the column stands alone on one side.",
    source: MS_INDEX_DESIGN,
    detect(_sql, masked) {
      // YEAR is handled by its own rule, which can offer a rewrite.
      // No `\b` after the operator: a word boundary cannot exist between `=`
      // and the space that follows it, so it silently defeated the whole rule.
      const match =
        /\b(UPPER|LOWER|LTRIM|RTRIM|TRIM|CONVERT|CAST|SUBSTRING|LEFT|RIGHT|ISNULL|COALESCE|DATEPART|MONTH|DAY)\s*\([^)]*\)\s*(?:<>|!=|[=<>]=?|\bLIKE\b|\bIN\b)/i.exec(
          masked
        );
      if (!match) return undefined;
      return {
        detail: `\`${match[1].toUpperCase()}(...)\` is applied to a column inside a filter, so the comparison cannot use an index.`,
      };
    },
  },
  {
    id: "SQL-LEADING-WILDCARD",
    title: "Filter starts with a wildcard",
    impact: "medium",
    why: "An index is ordered by the start of the value, so a pattern that begins with a wildcard gives the database nothing to seek on and forces a full scan.",
    recommendation:
      "Anchor the pattern where the data allows, or move the match into the model if the column is small.",
    source: MS_INDEX_DESIGN,
    detect(sql, masked) {
      // Masked text hides the literal, so look at the original around a LIKE.
      const like = /\bLIKE\s*'%/i.exec(sql);
      if (!like) return undefined;
      // Confirm the LIKE is real code and not inside a comment.
      if (!/\bLIKE\b/i.test(masked)) return undefined;
      return { detail: "A LIKE pattern begins with `%`, which cannot be satisfied from an index." };
    },
  },
  {
    id: "SQL-REDUNDANT-DISTINCT",
    title: "DISTINCT alongside GROUP BY",
    impact: "medium",
    why: "GROUP BY already produces one row per group, so the DISTINCT has nothing left to remove and only adds a deduplication step.",
    recommendation: "Drop the DISTINCT.",
    source: MS_INDEX_DESIGN,
    detect(sql, masked) {
      if (!/\bSELECT\s+DISTINCT\b/i.test(masked) || !/\bGROUP\s+BY\b/i.test(masked)) return undefined;
      return {
        detail: "The statement groups rows and then applies DISTINCT to the result.",
        rewrite: {
          suggested: sql.replace(/(\bSELECT\s+)DISTINCT\s+/i, "$1"),
          confidence: "high" as const,
        },
      };
    },
  },
  {
    id: "SQL-NO-FILTER",
    title: "Query loads the whole table",
    impact: "medium",
    why: "Every row is read at each refresh. Where a report only covers recent periods, most of that work is discarded after loading.",
    recommendation:
      "Filter at the source if the report does not need full history. This is intentional for small dimension tables.",
    source: MS_IMPORT,
    detect(_sql, masked) {
      if (!/\bFROM\b/i.test(masked)) return undefined;
      if (/\bWHERE\b/i.test(masked)) return undefined;
      if (ordersForLimit(masked)) return undefined;
      return { detail: "No WHERE clause, so every row in the source is loaded." };
    },
  },
  {
    id: "SQL-IMPLICIT-CONVERSION",
    title: "Number compared to a quoted value",
    impact: "medium",
    why: "Comparing a numeric column to a string makes the database convert one side of every row before it can compare, which also prevents an index seek.",
    recommendation: "Quote text and leave numbers unquoted, matching the column type.",
    source: MS_INDEX_DESIGN,
    detect(sql) {
      const match = /\b([A-Za-z_][\w.]*)\s*=\s*'(\d+)'/.exec(sql);
      if (!match) return undefined;
      return {
        detail: `\`${match[1]} = '${match[2]}'\` compares against a quoted number. If the column is numeric, every row is converted.`,
      };
    },
  },
  {
    id: "SQL-CORRELATED-SUBQUERY",
    title: "Correlated subquery in the filter",
    impact: "medium",
    why: "A subquery that references the outer row may be evaluated once per row rather than once for the statement.",
    recommendation: "Consider a join or a single grouped subquery, and check the execution plan.",
    source: MS_INDEX_DESIGN,
    detect(_sql, masked) {
      if (!/\b(EXISTS|IN)\s*\(\s*SELECT\b/i.test(masked)) return undefined;
      return {
        detail: "A subquery inside EXISTS or IN references the outer query.",
      };
    },
  },
  {
    id: "SQL-MANY-JOINS",
    title: "Many joins in one statement",
    impact: "low",
    why: "Each join multiplies the number of plans the optimiser must consider, and a mistake early in the plan is amplified through the rest.",
    recommendation:
      "Consider loading the tables separately and relating them in the model, which is what the model is for.",
    source: MS_FOLDING,
    detect(_sql, masked) {
      const joins = count(masked, /\bJOIN\b/gi);
      if (joins < 5) return undefined;
      return { detail: `${joins} joins in a single statement.` };
    },
  },
  {
    id: "SQL-NOLOCK",
    title: "NOLOCK hint",
    impact: "medium",
    dialects: ["sqlserver"],
    why: "Reading uncommitted rows can return data that was never committed, and can miss or duplicate rows during page splits, so a refresh can load figures that never existed.",
    recommendation:
      "Remove the hint, or use READ COMMITTED SNAPSHOT if the goal is to avoid blocking.",
    source: MS_INDEX_DESIGN,
    detect(_sql, masked) {
      if (!/\bNOLOCK\b/i.test(masked)) return undefined;
      return { detail: "The query reads uncommitted data through a NOLOCK hint." };
    },
  },
  {
    id: "SQL-NESTED-SELECT-STAR",
    title: "Subquery selects every column",
    impact: "medium",
    why: "An inner `SELECT *` carries every column through the plan even when the outer query keeps only a few.",
    recommendation: "Select just the columns the outer query uses.",
    source: MS_IMPORT,
    detect(_sql, masked) {
      if (!/\(\s*SELECT\s+\*/i.test(masked)) return undefined;
      return { detail: "A subquery selects every column from its source." };
    },
  },
];

/** Review one statement. Returns findings in impact order, worst first. */
export function analyseSql(sql: string, ctx: SqlContext): SqlFinding[] {
  if (!sql.trim()) return [];
  const masked = maskSql(sql);
  const order: SqlImpact[] = ["high", "medium", "low"];

  const findings: SqlFinding[] = [];
  for (const rule of RULES) {
    if (rule.dialects && !rule.dialects.includes(ctx.dialect)) continue;
    const hit = rule.detect(sql, masked, ctx);
    if (!hit) continue;
    findings.push({
      ruleId: rule.id,
      title: rule.title,
      impact: hit.impact ?? rule.impact,
      detail: hit.detail,
      why: rule.why,
      recommendation: rule.recommendation,
      source: rule.source,
      rewrite: hit.rewrite,
    });
  }

  return findings.sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact));
}

/** Every rule, for the settings screen and for counting what is available. */
export const SQL_RULE_CATALOGUE = RULES.map((r) => ({
  id: r.id,
  title: r.title,
  impact: r.impact,
  dialects: r.dialects ?? "all",
  why: r.why,
  recommendation: r.recommendation,
  source: r.source,
}));
