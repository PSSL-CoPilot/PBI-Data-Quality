/**
 * Reading the PBIR report format.
 *
 * Power BI's enhanced report format replaces the single `Report/Layout`
 * document with a directory of small files:
 *
 *   Report/definition/pages/pages.json              page order, active page
 *   Report/definition/pages/<page>/page.json        one page
 *   Report/definition/pages/<page>/visuals/<id>/visual.json   one visual
 *
 * The information is the same; only its packaging changed. So this produces
 * exactly the `Page[]` the legacy parser produces, and everything downstream —
 * KPI inference, lineage, usage, the exporter — works without knowing which
 * format the file arrived in.
 *
 * Two shape differences matter:
 *
 *   - geometry moved into a `position` object, and the page's own JSON no
 *     longer nests its visuals; they are found by path instead;
 *   - a field binding lives under `visual.query.queryState.<role>.projections`
 *     and names its table through `SourceRef.Entity` directly rather than an
 *     alias into a `From` clause. `collectRefs` already resolves both, so it
 *     is reused rather than reimplemented — the two formats must never
 *     disagree about what a visual binds.
 */
import { collectRefs } from "./layout.ts";
import type { Page, Visual } from "./model.ts";

const PAGES_ROOT = /(^|\/)definition\/pages\//i;

/** Is this archive laid out as PBIR? */
export function isPbirArchive(names: string[]): boolean {
  return names.some((n) => PAGES_ROOT.test(n));
}

/**
 * The parts worth reading out of a PBIR archive.
 *
 * Everything else under `definition/` — bookmarks, themes, mobile layouts —
 * is left alone, so a large report does not pay to inflate files nothing
 * reads.
 */
export function pbirParts(names: string[]): string[] {
  return names.filter(
    (n) =>
      /(^|\/)definition\/pages\/pages\.json$/i.test(n) ||
      /(^|\/)definition\/pages\/[^/]+\/page\.json$/i.test(n) ||
      /(^|\/)definition\/pages\/[^/]+\/visuals\/[^/]+\/visual\.json$/i.test(n)
  );
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** `'Net Sales'` — PBIR quotes literal strings exactly as the old format did. */
function literal(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/^'|'$/g, "").trim();
  return text.length > 0 ? text : undefined;
}

type Json = Record<string, unknown>;

/**
 * A visual's title.
 *
 * PBIR keeps container-level formatting under `visualContainerObjects`, and
 * some writers put it under `objects` instead, so both are checked. A title
 * can also be a plain string rather than an expression.
 */
function visualTitle(visual: Json): string | undefined {
  for (const key of ["visualContainerObjects", "objects"]) {
    const group = visual[key] as { title?: unknown[] } | undefined;
    const first = group?.title?.[0] as Json | undefined;
    const text = (first?.properties as Json | undefined)?.text;

    if (typeof text === "string") {
      const plain = literal(text);
      if (plain) return plain;
    }
    const expr = (text as Json | undefined)?.expr as Json | undefined;
    const value = (expr?.Literal as Json | undefined)?.Value;
    const parsed = literal(value);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * The words a text box shows.
 *
 * Carries no data binding, so reference analysis never sees it, but it is
 * usually the caption a reader knows a number by — KPI-name inference depends
 * on it.
 */
function visualText(visual: Json): string | undefined {
  const objects = visual.objects as { general?: unknown[] } | undefined;
  const runs: string[] = [];

  for (const entry of objects?.general ?? []) {
    const paragraphs = ((entry as Json)?.properties as Json | undefined)?.paragraphs;
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraph of paragraphs) {
      const textRuns = (paragraph as { textRuns?: Array<{ value?: unknown }> }).textRuns;
      for (const run of textRuns ?? []) {
        if (typeof run.value === "string") runs.push(run.value);
      }
    }
  }

  const text = runs.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}

/** The page directory a part belongs to, e.g. `ReportSection1`. */
function pageIdOf(path: string): string | undefined {
  return /(?:^|\/)definition\/pages\/([^/]+)\//i.exec(path)?.[1];
}

export interface PbirInput {
  /** Part name to its parsed JSON, for the parts `pbirParts` selected. */
  documents: Map<string, unknown>;
}

/**
 * Build pages from the PBIR documents.
 *
 * Order comes from `pages.json` when it is present and usable; otherwise the
 * directory order is kept, which is stable but arbitrary, and said so.
 */
export function parsePbir({ documents }: PbirInput): { pages: Page[]; warnings: string[] } {
  const warnings: string[] = [];

  // page id -> its page.json, and its visual documents.
  const pageDocs = new Map<string, Json>();
  const visualDocs = new Map<string, Json[]>();

  let order: string[] | undefined;

  for (const [path, document] of documents) {
    if (!document || typeof document !== "object") continue;
    const json = document as Json;

    if (/pages\.json$/i.test(path)) {
      const declared = json.pageOrder;
      if (Array.isArray(declared) && declared.every((p) => typeof p === "string")) {
        order = declared as string[];
      }
      continue;
    }

    const id = pageIdOf(path);
    if (!id) continue;

    if (/page\.json$/i.test(path)) {
      pageDocs.set(id, json);
    } else if (/visual\.json$/i.test(path)) {
      const list = visualDocs.get(id);
      if (list) list.push(json);
      else visualDocs.set(id, [json]);
    }
  }

  if (pageDocs.size === 0) {
    return {
      pages: [],
      warnings: ["The PBIR definition contained no readable page.json documents."],
    };
  }

  if (!order) {
    warnings.push(
      "This PBIR report declares no usable page order, so pages are listed in the order they appear in the file."
    );
  }

  const ids = [...pageDocs.keys()];
  const ordered = order
    ? [...order.filter((id) => pageDocs.has(id)), ...ids.filter((id) => !order!.includes(id))]
    : ids;

  const pages = ordered.map((id, index): Page => {
    const page = pageDocs.get(id)!;
    const name = String(page.name ?? id);

    const visuals = (visualDocs.get(id) ?? []).flatMap((document): Visual[] => {
      const position = (document.position ?? {}) as Json;
      const visual = (document.visual ?? {}) as Json;

      // A group is a layout container, not a data-bound visual — the legacy
      // parser skips its equivalent, and the two must agree.
      if (document.visualGroup || visual.visualGroup) return [];

      return [
        {
          id: String(document.name ?? ""),
          page: name,
          type: String(visual.visualType ?? "unknown"),
          title: visualTitle(visual),
          text: visualText(visual),
          x: num(position.x),
          y: num(position.y),
          width: num(position.width),
          height: num(position.height),
          // Walk the whole document: bindings live under query.queryState but
          // also appear in sort, filter and drill definitions, and the legacy
          // parser collects from the whole container too.
          refs: collectRefs(document),
        },
      ];
    });

    // Geometry sometimes sits on the page, sometimes under displayOption.
    const size = (page.size ?? page) as Json;

    return {
      name,
      displayName: String(page.displayName ?? page.name ?? id),
      ordinal: num(page.ordinal, index),
      // PBIR writes visibility as a word rather than the old numeric enum.
      isHidden:
        page.visibility === "HiddenInViewMode" ||
        page.visibility === 1 ||
        page.hidden === true,
      width: num(size.width, 1280),
      height: num(size.height, 720),
      visuals: visuals.sort((a, b) => a.y - b.y || a.x - b.x),
    };
  });

  return { pages, warnings };
}
