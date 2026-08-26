/**
 * Scoring primitives shared by the QA and optimization engines.
 *
 * Two invariants live here, both learned from scores that were arithmetically
 * right and practically useless:
 *
 * 1. A category whose rules could not run scores `null`, never 100. Returning
 *    100 would report an unread model as a clean one.
 *
 * 2. A score is a *share of the objects examined*, not a running total of
 *    penalties. Absolute deductions do not survive contact with a large report:
 *    a 16-page report where every page is over-dense scored 0, while a 1-page
 *    report with exactly the same defect rate scored 97. Normalising by
 *    population makes two files comparable, which is the only thing a score is
 *    actually for.
 */
import { allMeasures, type Capability, type CapabilityId, type Model } from "./powerbi/model.ts";

export interface MissingCapability {
  id: CapabilityId;
  reason: string;
}

/** The first required capability this file did not expose, if any. */
export function missingCapability(
  model: Model,
  requires: readonly CapabilityId[]
): MissingCapability | undefined {
  for (const id of requires) {
    const capability: Capability = model.capabilities[id];
    if (!capability.available) return { id, reason: capability.reason };
  }
  return undefined;
}

export const clampScore = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value)));

/**
 * How much of one object a finding consumes.
 *
 * A critical finding writes the object off entirely; a low one barely marks it.
 * Expressed as a share rather than a point value so the arithmetic stays in the
 * same units as the population it is divided by.
 */
export const SEVERITY_SHARE = { critical: 1, high: 0.6, medium: 0.3, low: 0.1 } as const;
export type ScoredSeverity = keyof typeof SEVERITY_SHARE;

/**
 * The share of a category's objects that carry a problem.
 *
 * An object is counted once, at its worst severity: three low findings on one
 * measure is one somewhat-damaged measure, not three.
 */
export function affectedShare(
  items: Array<{ key: string; severity: ScoredSeverity }>
): number {
  const worst = new Map<string, number>();
  for (const item of items) {
    const share = SEVERITY_SHARE[item.severity];
    worst.set(item.key, Math.max(worst.get(item.key) ?? 0, share));
  }
  return [...worst.values()].reduce((a, b) => a + b, 0);
}

/**
 * A category score, or `null` when nothing in that category could be evaluated.
 *
 * `population` is how many objects the category's rules examine. With nothing
 * to examine there is no opinion to give, so that is `null` too rather than a
 * free 100.
 */
export function categoryScore(
  rulesRun: number,
  affected: number,
  population: number
): number | null {
  if (rulesRun === 0 || population <= 0) return null;
  return clampScore(100 * (1 - affected / population));
}

/** Mean of the categories that were actually assessed. */
export function overallScore(scores: Array<number | null>): number | null {
  const assessed = scores.filter((s): s is number => s !== null);
  if (assessed.length === 0) return null;
  return clampScore(assessed.reduce((a, b) => a + b, 0) / assessed.length);
}

/**
 * How many objects each category inspects.
 *
 * Kept next to the scoring maths because the score is meaningless without it:
 * the divisor has to be the set of things that could have been flagged.
 */
export function populationFor(model: Model, category: string): number {
  const measures = allMeasures(model).length;
  switch (category) {
    case "DAX":
      return measures;
    case "Model":
      return measures + model.tables.length;
    case "Relationship":
      return model.relationships.length;
    case "Report":
    case "Visuals":
      return model.pages.length;
    case "Data":
      return measures + model.relationships.length;
    case "SQL":
      return model.tables.reduce((n, t) => n + t.partitions.length, 0);
    default:
      return measures + model.tables.length + model.pages.length;
  }
}
