/**
 * Report-side usage lookup: which pages and visuals bind a given model object.
 *
 * This is the read half of dependency-aware editing. A rename is only safe when
 * every one of these bindings can be rewritten, so the same index that answers
 * "where is this used?" is what the editor will walk when applying a change.
 */
import type { FieldRef, Model, Page, Visual } from "./model.ts";

export interface UsageHit {
  page: Page;
  visual: Visual;
  ref: FieldRef;
}

export interface UsageSummary {
  hits: UsageHit[];
  pages: string[];
  visualCount: number;
}

function matches(ref: FieldRef, kind: FieldRef["kind"], table: string | undefined, field: string) {
  if (ref.kind !== kind || ref.field !== field) return false;
  // A binding with no resolvable table still counts: dropping it would be the
  // silent broken reference the spec forbids.
  if (!table || !ref.table) return true;
  return ref.table === table;
}

export function findUsage(
  model: Model,
  kind: FieldRef["kind"],
  table: string | undefined,
  field: string
): UsageSummary {
  const hits: UsageHit[] = [];

  for (const page of model.pages) {
    for (const visual of page.visuals) {
      const ref = visual.refs.find((r) => matches(r, kind, table, field));
      if (ref) hits.push({ page, visual, ref });
    }
  }

  return {
    hits,
    pages: [...new Set(hits.map((h) => h.page.displayName))],
    visualCount: hits.length,
  };
}

/** Measures referenced by other measures, found by name in their DAX. */
export function findMeasureReferences(model: Model, measureName: string): string[] {
  // Bracket references are unambiguous enough for a usage list; the editor will
  // need a real DAX tokenizer before it rewrites expressions.
  const needle = `[${measureName}]`;
  return model.tables
    .flatMap((t) => t.measures)
    .filter((m) => m.name !== measureName && m.expression.includes(needle))
    .map((m) => `${m.table}[${m.name}]`);
}

export function usageLabel(summary: UsageSummary, daxRefs: string[]): string {
  const parts: string[] = [];
  if (summary.pages.length) {
    parts.push(`${summary.pages.length} page${summary.pages.length === 1 ? "" : "s"}`);
  }
  if (summary.visualCount) {
    parts.push(`${summary.visualCount} visual${summary.visualCount === 1 ? "" : "s"}`);
  }
  if (daxRefs.length) {
    parts.push(`${daxRefs.length} measure${daxRefs.length === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" · ") : "No references found";
}
