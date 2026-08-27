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

const EMPTY_USAGE: UsageSummary = { hits: [], pages: [], visualCount: 0 };

/**
 * Every binding in the report, indexed by what it points at.
 *
 * `findUsage` walks every visual on every page for one object. Calling it once
 * per row of a measure list turns a screen render into pages × visuals × rows
 * of work — on a sixteen-page report with a few hundred measures that is
 * hundreds of thousands of comparisons for a single repaint, and it is felt.
 *
 * One pass builds the whole index instead. A binding is filed under both its
 * qualified and unqualified key, because a visual may or may not name the table
 * and a lookup should find it either way.
 */
export class UsageIndex {
  private readonly byKey = new Map<string, UsageHit[]>();

  constructor(model: Model) {
    for (const page of model.pages) {
      for (const visual of page.visuals) {
        for (const ref of visual.refs) {
          const hit: UsageHit = { page, visual, ref };
          this.add(`${ref.kind}|${ref.field}`, hit);
          if (ref.table) this.add(`${ref.kind}|${ref.table}|${ref.field}`, hit);
        }
      }
    }
  }

  private add(key: string, hit: UsageHit): void {
    const existing = this.byKey.get(key);
    if (existing) existing.push(hit);
    else this.byKey.set(key, [hit]);
  }

  find(kind: FieldRef["kind"], table: string | undefined, field: string): UsageSummary {
    // A binding that names no table still counts, so an unqualified lookup has
    // to see both. Deduplicated by identity, since a hit is filed under two keys.
    const qualified = table ? (this.byKey.get(`${kind}|${table}|${field}`) ?? []) : [];
    const bare = (this.byKey.get(`${kind}|${field}`) ?? []).filter((h) => !h.ref.table);
    const hits = table ? [...new Set([...qualified, ...bare])] : (this.byKey.get(`${kind}|${field}`) ?? []);

    if (hits.length === 0) return EMPTY_USAGE;
    return {
      hits,
      pages: [...new Set(hits.map((h) => h.page.displayName))],
      visualCount: hits.length,
    };
  }
}

/**
 * Which measures call which, built in one pass.
 *
 * `findMeasureReferences` scans every expression in the model for one name.
 * Asking it once per row makes a measure list quadratic in the number of
 * measures, which is the difference between a list that appears and a list
 * that stutters.
 */
export function buildMeasureReferenceIndex(model: Model): Map<string, string[]> {
  const measures = model.tables.flatMap((t) => t.measures);
  const known = new Set(measures.map((m) => m.name));
  const index = new Map<string, string[]>();

  /*
   * Read each expression once and invert, rather than searching every
   * expression for every name. Comparing each measure against each other
   * measure is quadratic in the measure count; this is linear in the total
   * length of the DAX, which is the amount of text that actually exists.
   */
  for (const measure of measures) {
    const caller = `${measure.table}[${measure.name}]`;
    for (const [, referenced] of measure.expression.matchAll(BRACKETED)) {
      // A bracketed token is a column just as often as a measure; only names
      // the model actually defines as measures count.
      if (referenced === measure.name || !known.has(referenced)) continue;
      const callers = index.get(referenced);
      if (callers) {
        if (!callers.includes(caller)) callers.push(caller);
      } else {
        index.set(referenced, [caller]);
      }
    }
  }

  return index;
}

/** `[Anything but a closing bracket]`, which is how DAX writes a reference. */
const BRACKETED = /\[([^\]]+)\]/g;

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
