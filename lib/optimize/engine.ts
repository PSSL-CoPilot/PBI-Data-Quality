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
import type { Model } from "../powerbi/model.ts";
import { buildDependencyIndex } from "../powerbi/graph.ts";
import { categoryScore, missingCapability, overallScore } from "../scoring.ts";
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

export type { Impact, OptCategory, OptTarget } from "./rules.ts";
export type { Rewrite } from "./rewrite.ts";
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
  deductions: number;
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

  const categories: OptCategoryScore[] = OPT_CATEGORIES.map((category) => {
    const rulesRun = ranByCategory.get(category) ?? 0;
    const items = opportunities.filter((o) => o.category === category);
    const deductions = items.reduce((sum, o) => sum + IMPACT_WEIGHT[o.impact], 0);

    return {
      category,
      score: categoryScore(rulesRun, deductions),
      rulesRun,
      rulesSkipped: skippedByCategory.get(category) ?? 0,
      opportunities: items.length,
      deductions,
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
    rewrites: opportunities.filter((o) => o.rewrite),
    performanceNotAssessed: PERFORMANCE_NOT_ASSESSED,
  };
}

export function optimizationLabel(score: number | null): string {
  if (score === null) return "Not assessed";
  if (score >= 90) return "Lean";
  if (score >= 75) return "Some cleanup";
  if (score >= 50) return "Worth optimizing";
  return "Heavy";
}
