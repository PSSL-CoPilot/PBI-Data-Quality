/**
 * Optimization runner and score.
 *
 * Same contract as the QA engine: every rule declares what it needs, a rule
 * that cannot run is reported as skipped with a reason, and its category scores
 * `null` rather than a default pass.
 *
 * Nothing is executed against the model, so there is no performance evidence
 * here. `Performance` is reported as a category that was not assessed rather
 * than being estimated from structure.
 */
import type { Change } from "../edit/apply.ts";
import type { Model } from "../powerbi/model.ts";
import { buildDependencyIndex } from "../powerbi/graph.ts";
import { replaceNativeQuery } from "../powerbi/nativequery.ts";
import {
  affectedShare,
  categoryScore,
  missingCapability,
  overallScore,
  populationFor,
} from "../scoring.ts";
import { allPageComplexity, type PageComplexity } from "./pages.ts";
import {
  ALL_OPT_RULES,
  OPT_CATEGORIES,
  PERFORMANCE_NOT_ASSESSED,
  type Impact,
  type OptCategory,
  type OptRule,
  type OptTarget,
} from "./rules.ts";
import type { Rewrite } from "./rewrite.ts";
import {
  analyseSql,
  dialectFromConnector,
  SQL_RULE_CATALOGUE,
  type SqlDialect,
  type SqlRewrite,
} from "./sql.ts";

export type { Impact, OptCategory, OptTarget } from "./rules.ts";
export type { Rewrite } from "./rewrite.ts";
export { DIALECT_LABEL, SQL_RULE_CATALOGUE } from "./sql.ts";
export type { SqlDialect } from "./sql.ts";
export type { PageComplexity } from "./pages.ts";

export const IMPACT_WEIGHT: Record<Impact, number> = { high: 8, medium: 3, low: 1 };
export const IMPACT_ORDER: Impact[] = ["high", "medium", "low"];

export interface Opportunity {
  id: string;
  ruleId: string;
  title: string;
  category: OptCategory;
  impact: Impact;
  target: OptTarget;
  detail: string;
  recommendation: string;
  /** Present only where a rewrite was generated and validated. */
  rewrite?: Rewrite;
  /**
   * Present on SQL findings: the statement reviewed, plus the evidence behind
   * the recommendation. Kept separate from `rewrite`, which is DAX.
   */
  sql?: {
    statement: string;
    dialect: SqlDialect;
    why: string;
    source: { title: string; url: string };
    rewrite?: SqlRewrite;
  };
}

export interface SkippedOptRule {
  ruleId: string;
  title: string;
  category: OptCategory;
  reason: string;
}

export interface OptCategoryScore {
  category: OptCategory;
  /** null when no rule in this category could run. */
  score: number | null;
  rulesRun: number;
  rulesSkipped: number;
  opportunities: number;
  /** Objects this category inspects; the score is a share of these. */
  population: number;
  /** Impact-weighted count of affected objects. */
  affected: number;
  reason?: string;
}

export interface OptimizationResult {
  opportunities: Opportunity[];
  categories: OptCategoryScore[];
  overall: number | null;
  counts: Record<Impact, number>;
  skipped: SkippedOptRule[];
  rulesRun: number;
  pages: PageComplexity[];
  /** Rewrites available, for the Current -> Suggested view. */
  rewrites: Opportunity[];
  performanceNotAssessed: string[];
}

export function runOptimization(
  model: Model,
  rules: OptRule[] = ALL_OPT_RULES
): OptimizationResult {
  const index = buildDependencyIndex(model);

  const opportunities: Opportunity[] = [];
  const skipped: SkippedOptRule[] = [];
  const ranByCategory = new Map<OptCategory, number>();
  const skippedByCategory = new Map<OptCategory, number>();
  const reasonByCategory = new Map<OptCategory, string>();

  for (const rule of rules) {
    const missing = missingCapability(model, rule.requires);
    if (missing) {
      skipped.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        reason: missing.reason,
      });
      skippedByCategory.set(rule.category, (skippedByCategory.get(rule.category) ?? 0) + 1);
      if (!reasonByCategory.has(rule.category)) {
        reasonByCategory.set(rule.category, missing.reason);
      }
      continue;
    }

    ranByCategory.set(rule.category, (ranByCategory.get(rule.category) ?? 0) + 1);

    for (const [i, hit] of rule.evaluate(model, index).entries()) {
      opportunities.push({
        id: `${rule.id}#${hit.target.key}#${i}`,
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        impact: hit.impact ?? rule.impact,
        target: hit.target,
        detail: hit.detail,
        recommendation: rule.recommendation,
        rewrite: hit.rewrite,
      });
    }
  }

  // SQL review is not a model rule: it reads the native statement behind each
  // partition, which the M parser dug out at extraction time.
  for (const opportunity of sqlOpportunities(model)) opportunities.push(opportunity);
  if (model.capabilities.model.available) {
    const partitions = model.tables.reduce((n, t) => n + t.partitions.length, 0);
    if (partitions > 0) ranByCategory.set("SQL", SQL_RULE_CATALOGUE.length);
    else {
      skippedByCategory.set("SQL", 1);
      reasonByCategory.set("SQL", "This model defines no partitions to read a query from.");
    }
  } else {
    skippedByCategory.set("SQL", SQL_RULE_CATALOGUE.length);
    reasonByCategory.set("SQL", model.capabilities.model.reason);
  }

  const categories: OptCategoryScore[] = OPT_CATEGORIES.map((category) => {
    const rulesRun = ranByCategory.get(category) ?? 0;
    const items = opportunities.filter((o) => o.category === category);
    const population = populationFor(model, category);
    // Impact maps onto the same severity scale the QA score uses, so the two
    // numbers on screen mean the same thing.
    const affected = affectedShare(
      items.map((o) => ({ key: o.target.key, severity: o.impact }))
    );

    return {
      category,
      score: categoryScore(rulesRun, affected, population),
      rulesRun,
      rulesSkipped: skippedByCategory.get(category) ?? 0,
      opportunities: items.length,
      population,
      affected: Math.round(affected * 100) / 100,
      reason: rulesRun === 0 ? reasonByCategory.get(category) : undefined,
    };
  });

  const counts: Record<Impact, number> = { high: 0, medium: 0, low: 0 };
  for (const item of opportunities) counts[item.impact]++;

  opportunities.sort(
    (a, b) =>
      IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) ||
      a.category.localeCompare(b.category) ||
      a.target.name.localeCompare(b.target.name)
  );

  return {
    opportunities,
    categories,
    overall: overallScore(categories.map((c) => c.score)),
    counts,
    skipped,
    rulesRun: [...ranByCategory.values()].reduce((a, b) => a + b, 0),
    pages: model.capabilities.report.available ? allPageComplexity(model) : [],
    // Anything that can be applied mechanically, DAX or SQL alike.
    rewrites: opportunities.filter((o) => o.rewrite ?? o.sql?.rewrite),
    performanceNotAssessed: PERFORMANCE_NOT_ASSESSED,
  };
}

/**
 * SQL findings, expressed as optimization opportunities.
 *
 * Each one targets the partition that holds the statement, so applying a
 * rewrite edits the same source expression the SQL editor writes to and lands
 * in Pending Changes by the same route.
 */
function sqlOpportunities(model: Model): Opportunity[] {
  if (!model.capabilities.model.available) return [];

  const out: Opportunity[] = [];
  for (const table of model.tables) {
    for (const partition of table.partitions) {
      const native = partition.nativeQuery;
      if (native?.kind !== "native" || !native.sql) continue;

      const findings = analyseSql(native.sql, {
        dialect: dialectFromConnector(native.connector ?? ""),
        columns: table.columns.map((c) => c.name),
        mode: partition.mode,
      });

      for (const [i, finding] of findings.entries()) {
        out.push({
          id: `${finding.ruleId}#${table.name}.${partition.name}#${i}`,
          ruleId: finding.ruleId,
          title: finding.title,
          category: "SQL",
          impact: finding.impact,
          target: {
            type: "partition",
            key: `partition:${table.name}[${partition.name}]`,
            name: partition.name,
            table: table.name,
          },
          detail: finding.detail,
          recommendation: finding.recommendation,
          sql: {
            statement: native.sql,
            dialect: dialectFromConnector(native.connector ?? ""),
            why: finding.why,
            source: finding.source,
            rewrite: finding.rewrite,
          },
        });
      }
    }
  }
  return out;
}

/**
 * Turn an opportunity into an editable change, when and only when it carries a
 * validated rewrite.
 *
 * Advisory findings return nothing, which is what keeps "Optimize" off the
 * recommendations that cannot be applied mechanically. The caller supplies the
 * id so the change can be traced back to the click that made it.
 */
export function rewriteAsChange(
  opportunity: Opportunity,
  id: string,
  at: number,
  model?: Model
): Change | undefined {
  const rewrite = opportunity.rewrite;
  if (rewrite && opportunity.target.type === "measure" && opportunity.target.table) {
    return {
      id,
      target: {
        type: "measure",
        table: opportunity.target.table,
        name: opportunity.target.name,
      },
      field: "expression",
      before: rewrite.original,
      after: rewrite.suggested,
      at,
    };
  }

  // A SQL rewrite edits the statement inside the partition's M expression, so
  // the change carries the whole expression — the same thing the SQL editor
  // writes and the same thing the exporter knows how to put back.
  const sql = opportunity.sql;
  if (sql?.rewrite && opportunity.target.type === "partition" && opportunity.target.table && model) {
    const table = model.tables.find((t) => t.name === opportunity.target.table);
    const partition = table?.partitions.find((p) => p.name === opportunity.target.name);
    if (!partition?.expression) return undefined;

    const after =
      partition.sourceType === "query"
        ? sql.rewrite.suggested
        : replaceNativeQuery(partition.expression, sql.rewrite.suggested);
    if (!after || after === partition.expression) return undefined;

    return {
      id,
      target: { type: "partition", table: opportunity.target.table, name: opportunity.target.name },
      field: "expression",
      before: partition.expression,
      after,
      at,
    };
  }

  return undefined;
}

/** Opportunities that can be applied automatically, safest first. */
export function safeRewrites(result: OptimizationResult): Opportunity[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  // A DAX rewrite lives on `rewrite`, a SQL one on `sql.rewrite`. Filtering on
  // the former alone silently hid every SQL suggestion from the bulk actions.
  const confidence = (o: Opportunity) => o.rewrite?.confidence ?? o.sql?.rewrite?.confidence;
  return result.rewrites
    .filter((o) => confidence(o) !== undefined)
    .sort((a, b) => rank[confidence(a)!] - rank[confidence(b)!]);
}

export function optimizationLabel(score: number | null): string {
  if (score === null) return "Not assessed";
  if (score >= 90) return "Lean";
  if (score >= 75) return "Some cleanup";
  if (score >= 50) return "Worth optimizing";
  return "Heavy";
}
