/**
 * Scoring primitives shared by the QA and optimization engines.
 *
 * The invariant that matters lives here: a category whose rules could not run
 * scores `null`, never 100. Both engines depend on it, so it is defined once
 * rather than reimplemented twice and allowed to drift.
 */
import type { Capability, CapabilityId, Model } from "./powerbi/model.ts";

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
 * A category score, or `null` when nothing in that category could be evaluated.
 * Returning 100 there would report an unread model as a clean one.
 */
export function categoryScore(rulesRun: number, deductions: number): number | null {
  return rulesRun === 0 ? null : clampScore(100 - deductions);
}

/** Mean of the categories that were actually assessed. */
export function overallScore(scores: Array<number | null>): number | null {
  const assessed = scores.filter((s): s is number => s !== null);
  if (assessed.length === 0) return null;
  return clampScore(assessed.reduce((a, b) => a + b, 0) / assessed.length);
}
