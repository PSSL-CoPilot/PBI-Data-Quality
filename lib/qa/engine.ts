/**
 * QA runner and scoring.
 *
 * Scoring is deliberately simple and fully explainable: each finding deducts a
 * fixed weight from its category, and the overall score is the mean of the
 * categories that were actually assessed. A category whose rules could not run
 * scores `null`, not 100 — an unread model must never look like a clean one.
 */
import type { Capability, CapabilityId, Model } from "../powerbi/model.ts";
import {
  ALL_RULES,
  CATEGORIES,
  NOT_ASSESSED,
  type Category,
  type FindingTarget,
  type Rule,
  type Severity,
} from "./rules.ts";

export type { Category, Severity, FindingTarget } from "./rules.ts";

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 15,
  high: 8,
  medium: 3,
  low: 1,
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

export interface Finding {
  id: string;
  ruleId: string;
  title: string;
  category: Category;
  severity: Severity;
  target: FindingTarget;
  detail: string;
  recommendation: string;
}

export interface SkippedRule {
  ruleId: string;
  title: string;
  category: Category;
  reason: string;
}

export interface CategoryScore {
  category: Category;
  /** null when no rule in this category could run. */
  score: number | null;
  rulesRun: number;
  rulesSkipped: number;
  findings: number;
  deductions: number;
  reason?: string;
}

export interface QaResult {
  findings: Finding[];
  categories: CategoryScore[];
  overall: number | null;
  counts: Record<Severity, number>;
  skipped: SkippedRule[];
  rulesRun: number;
  notAssessed: typeof NOT_ASSESSED;
}

function missingCapability(
  model: Model,
  requires: CapabilityId[]
): { id: CapabilityId; capability: Capability } | undefined {
  for (const id of requires) {
    const capability = model.capabilities[id];
    if (!capability.available) return { id, capability };
  }
  return undefined;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function runQa(model: Model, rules: Rule[] = ALL_RULES): QaResult {
  const findings: Finding[] = [];
  const skipped: SkippedRule[] = [];
  const ranByCategory = new Map<Category, number>();
  const skippedByCategory = new Map<Category, number>();
  const reasonByCategory = new Map<Category, string>();

  for (const rule of rules) {
    const missing = missingCapability(model, rule.requires);
    if (missing) {
      const reason = (missing.capability as { available: false; reason: string }).reason;
      skipped.push({ ruleId: rule.id, title: rule.title, category: rule.category, reason });
      skippedByCategory.set(rule.category, (skippedByCategory.get(rule.category) ?? 0) + 1);
      if (!reasonByCategory.has(rule.category)) reasonByCategory.set(rule.category, reason);
      continue;
    }

    ranByCategory.set(rule.category, (ranByCategory.get(rule.category) ?? 0) + 1);

    for (const [index, hit] of rule.evaluate(model).entries()) {
      findings.push({
        id: `${rule.id}#${hit.target.key}#${index}`,
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity: hit.severity ?? rule.severity,
        target: hit.target,
        detail: hit.detail,
        recommendation: rule.recommendation,
      });
    }
  }

  const categories: CategoryScore[] = CATEGORIES.map((category) => {
    const rulesRun = ranByCategory.get(category) ?? 0;
    const categoryFindings = findings.filter((f) => f.category === category);
    const deductions = categoryFindings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

    return {
      category,
      score: rulesRun === 0 ? null : clamp(100 - deductions),
      rulesRun,
      rulesSkipped: skippedByCategory.get(category) ?? 0,
      findings: categoryFindings.length,
      deductions,
      reason: rulesRun === 0 ? reasonByCategory.get(category) : undefined,
    };
  });

  const assessed = categories.filter((c) => c.score !== null);
  const overall = assessed.length
    ? clamp(assessed.reduce((sum, c) => sum + (c.score ?? 0), 0) / assessed.length)
    : null;

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.category.localeCompare(b.category) ||
      a.target.name.localeCompare(b.target.name)
  );

  return {
    findings,
    categories,
    overall,
    counts,
    skipped,
    rulesRun: [...ranByCategory.values()].reduce((a, b) => a + b, 0),
    notAssessed: NOT_ASSESSED,
  };
}

/** The highest-impact findings, for the "needs attention" queue. */
export function topProblems(result: QaResult, limit = 5): Finding[] {
  return result.findings.slice(0, limit);
}

export function scoreLabel(score: number | null): string {
  if (score === null) return "Not assessed";
  if (score >= 90) return "Healthy";
  if (score >= 75) return "Minor issues";
  if (score >= 50) return "Needs attention";
  return "At risk";
}
