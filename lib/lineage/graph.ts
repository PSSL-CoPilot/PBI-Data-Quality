/**
 * KPI lineage: what a number on a page is actually made of.
 *
 * The chain runs in the direction the data moves:
 *
 *     source object  ->  PBI table  ->  measure  ->  KPI
 *     dbo.Orders         Orders        Unique Sales   "Unique Sales" card
 *
 * plus two links that do not fit a straight chain and matter more than it:
 *
 *   - measure -> measure, because a measure that calls another inherits
 *     everything that one reads, and
 *   - KPI -> KPI, derived from the above: if the measure behind one KPI
 *     depends on the measure behind another, the two numbers move together,
 *     and changing one changes the other. That relationship is invisible on
 *     the report itself.
 *
 * What counts as a KPI is the one judgement here, and it is made
 * conservatively. A KPI is a visual that *displays a measure*. A slicer, a
 * filter, a button, a text box or an image is not a KPI no matter what it is
 * called, and a visual that only binds columns is a table or a list, not a
 * number being reported. Getting this wrong in the permissive direction would
 * fill the diagram with the report's furniture.
 */
import { bestKpiName, inferKpiNames } from "../powerbi/kpi.ts";
import type { Model, Visual } from "../powerbi/model.ts";
import { allMeasures } from "../powerbi/model.ts";
import { analyseMeasureSources, type MeasureSources } from "../powerbi/sources.ts";
import { readSqlFacts } from "../export/definitions.ts";

/*
 * `visual` is the thing on the page; `kpi` is the name that thing reports.
 * They were one node until it became clear that a single KPI is usually shown
 * several times over — a card, a monthly view, a daily view — and collapsing
 * those into one box per visual hid the fact that they are all the same
 * number.
 */
export type NodeKind = "source" | "table" | "measure" | "visual" | "kpi";

export interface LineageNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** The technical name, when the label is a business one. */
  sublabel?: string;
  /** Page a KPI lives on. */
  page?: string;
  /** Set when a KPI's name was inferred rather than read from a title. */
  inferred?: boolean;
  detail?: string;
}

export type EdgeKind = "loads" | "feeds" | "calls" | "displays" | "reports" | "related";

export interface LineageEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Why this edge exists, in one line. */
  reason: string;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

/* ------------------------------------------------------------------ KPI --- */

/**
 * Visual types that are never a KPI, whatever they bind.
 *
 * A slicer is the important one: it is the report's filter control, and the
 * user's requirement is explicit that filters and slicers stay out. The rest
 * are navigation and decoration.
 */
const NOT_A_KPI = new Set([
  "slicer",
  "advancedSlicerVisual",
  "textbox",
  "image",
  "shape",
  "basicShape",
  "actionButton",
  "bookmarkNavigator",
  "pageNavigator",
  "filterPane",
  "group",
]);

/** A visual reports a number when it binds at least one measure. */
export function isKpiVisual(visual: Visual): boolean {
  const type = (visual.type ?? "").trim();
  if (NOT_A_KPI.has(type)) return false;
  // Defensive: some custom visuals carry "slicer" inside a longer type name.
  if (/slicer|filter|navigator|button/i.test(type)) return false;
  return visual.refs.some((ref) => ref.kind === "measure");
}

const measureKey = (table: string, name: string) => `measure:${table}[${name}]`;
const tableKey = (name: string) => `table:${name}`;
const sourceKey = (object: string) => `source:${object}`;
const visualKey = (visual: Visual) => `visual:${visual.page}/${visual.id}`;
const kpiNameKey = (name: string) => `kpi:${name.toLowerCase()}`;

/**
 * Every bracketed reference in an expression that names a known measure.
 *
 * A bracketed token is a column as often as a measure, so only names the model
 * actually defines as measures are kept.
 */
function callsOf(expression: string, known: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [, name] of expression.matchAll(/\[([^\]]+)\]/g)) {
    const key = known.get(name);
    if (key) out.add(key);
  }
  return [...out];
}

/* ---------------------------------------------------------------- build --- */

export interface LineageOptions {
  /** Restrict to KPIs on this page; omit for every page. */
  page?: string;
  /** Restrict to one visual and whatever it depends on. */
  focusKpi?: string;
  /** Restrict to one KPI name, keeping every visual that reports it. */
  focusKpiName?: string;
}

/**
 * Build the lineage graph.
 *
 * Nodes are only emitted when something reaches them, so a model with three
 * hundred measures does not produce three hundred boxes for a page that shows
 * four numbers.
 */
export function buildLineage(model: Model, options: LineageOptions = {}): LineageGraph {
  const sources = analyseMeasureSources(model);
  const kpiNames = inferKpiNames(model);

  // measure name -> node id, for resolving DAX references.
  const byName = new Map<string, string>();
  for (const measure of allMeasures(model)) {
    byName.set(measure.name, measureKey(measure.table, measure.name));
  }

  // node id -> the measure it represents.
  const measures = new Map<string, { table: string; name: string; expression: string }>();
  for (const measure of allMeasures(model)) {
    measures.set(measureKey(measure.table, measure.name), {
      table: measure.table,
      name: measure.name,
      expression: measure.expression,
    });
  }

  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const addNode = (node: LineageNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: LineageEdge) => {
    if (!edges.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
      edges.push(edge);
    }
  };

  /* --- the KPIs in scope ------------------------------------------------ */

  const pages = options.page ? model.pages.filter((p) => p.name === options.page) : model.pages;

  interface KpiEntry {
    id: string;
    visual: Visual;
    pageDisplay: string;
    /** Node ids of the measures this visual displays directly. */
    measureIds: string[];
  }

  const kpis: KpiEntry[] = [];

  for (const page of pages) {
    for (const visual of page.visuals) {
      if (!isKpiVisual(visual)) continue;

      const id = visualKey(visual);
      if (options.focusKpi && id !== options.focusKpi) continue;

      const measureIds: string[] = [];
      for (const ref of visual.refs) {
        if (ref.kind !== "measure") continue;
        // Prefer the qualified match; fall back to the unqualified name.
        const qualified = ref.table ? measureKey(ref.table, ref.field) : undefined;
        const resolved =
          qualified && measures.has(qualified) ? qualified : byName.get(ref.field);
        if (resolved) measureIds.push(resolved);
      }

      // A visual whose measures cannot be resolved is still reported, because
      // silently dropping it would understate the page.
      kpis.push({ id, visual, pageDisplay: page.displayName, measureIds: [...new Set(measureIds)] });
    }
  }

  /*
   * The KPI a visual reports is taken from the measure it displays, not from
   * its own title. Titles are where the variants live — "Churn %", "Churn %
   * monthly", "Churn % by region" — so grouping on them would either split
   * one KPI into several or need fuzzy matching, which is a guess. The
   * measure is the same object in every one of those visuals, so it groups
   * them exactly.
   */
  const kpiNameOf = (entry: KpiEntry): string | undefined => {
    const first = entry.measureIds.map((id) => measures.get(id)).find(Boolean);
    if (!first) return undefined;
    return bestKpiName(kpiNames, first.table, first.name)?.label ?? first.name;
  };

  if (options.focusKpiName) {
    const wanted = options.focusKpiName.toLowerCase();
    const keep = kpis.filter((k) => kpiNameOf(k)?.toLowerCase() === wanted);
    kpis.length = 0;
    kpis.push(...keep);
  }

  for (const kpi of kpis) {
    const inferredName = kpi.measureIds
      .map((id) => measures.get(id))
      .filter(Boolean)
      .map((m) => bestKpiName(kpiNames, m!.table, m!.name)?.label)
      .find(Boolean);

    const label = kpi.visual.title ?? inferredName ?? `Untitled ${kpi.visual.type}`;

    addNode({
      id: kpi.id,
      kind: "visual",
      label,
      sublabel: kpi.visual.type,
      page: kpi.pageDisplay,
      inferred: !kpi.visual.title && Boolean(inferredName),
      detail: kpi.visual.title
        ? `Titled "${kpi.visual.title}" on ${kpi.pageDisplay}.`
        : inferredName
          ? `No title on the visual. "${inferredName}" was read from a nearby caption on ${kpi.pageDisplay}, so it is a guess.`
          : `This ${kpi.visual.type} on ${kpi.pageDisplay} has no title and no caption near it.`,
    });

    // The KPI this visual reports, shared with every other visual on it.
    const name = kpiNameOf(kpi);
    if (!name) continue;

    const id = kpiNameKey(name);
    const shown = kpis.filter((k) => kpiNameOf(k) === name);
    addNode({
      id,
      kind: "kpi",
      label: name,
      sublabel:
        shown.length === 1 ? "1 visual" : `${shown.length} visuals`,
      detail:
        shown.length === 1
          ? `Reported by one visual on ${kpi.pageDisplay}.`
          : `Reported by ${shown.length} visuals: ${shown
              .map((k) => k.visual.title ?? k.visual.type)
              .join(", ")}. They all show the same number.`,
    });
    addEdge({
      from: kpi.id,
      to: id,
      kind: "reports",
      reason: `This visual reports ${name}.`,
    });
  }

  /* --- measures, transitively ------------------------------------------- */

  const reached = new Set<string>();
  const queue = kpis.flatMap((k) => k.measureIds);

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);

    const measure = measures.get(id);
    if (!measure) continue;

    for (const called of callsOf(measure.expression, byName)) {
      if (called === id) continue;
      if (!reached.has(called)) queue.push(called);
      // The callee feeds the caller, so that is the direction of the arrow.
      const callee = measures.get(called);
      addEdge({
        from: called,
        to: id,
        kind: "calls",
        reason: `${measure.name} calls [${callee?.name ?? "?"}] in its DAX.`,
      });
    }
  }

  for (const id of reached) {
    const measure = measures.get(id);
    if (!measure) continue;
    const analysis: MeasureSources | undefined = sources.get(`${measure.table}[${measure.name}]`);

    addNode({
      id,
      kind: "measure",
      label: measure.name,
      sublabel: `stored in ${measure.table}`,
      detail: analysis?.reason,
    });

    /* --- tables the measure reads --------------------------------------- */

    for (const table of analysis?.direct ?? []) {
      const tid = tableKey(table);
      const modelTable = model.tables.find((t) => t.name === table);
      addNode({
        id: tid,
        kind: "table",
        label: table,
        sublabel: modelTable?.kind === "calculated" ? "calculated table" : "table",
        detail: modelTable
          ? `${modelTable.columns.length} columns.`
          : "Referenced by DAX but not present in the model.",
      });
      addEdge({
        from: tid,
        to: id,
        kind: "feeds",
        reason: `${measure.name} reads ${table} in its DAX.`,
      });
    }
  }

  /* --- measure -> KPI ---------------------------------------------------- */

  for (const kpi of kpis) {
    for (const id of kpi.measureIds) {
      const measure = measures.get(id);
      addEdge({
        from: id,
        to: kpi.id,
        kind: "displays",
        reason: `This visual binds [${measure?.name ?? "?"}].`,
      });
    }
  }

  /* --- source objects behind each table ---------------------------------- */

  for (const node of [...nodes.values()].filter((n) => n.kind === "table")) {
    const table = model.tables.find((t) => t.name === node.label);
    if (!table) continue;

    const native = table.partitions.find((p) => p.nativeQuery?.kind === "native");
    const sql = native?.nativeQuery?.sql;
    if (!sql) continue;

    const object = readSqlFacts(sql).object;
    if (!object) continue;

    const sid = sourceKey(object);
    addNode({
      id: sid,
      kind: "source",
      label: object,
      sublabel: native?.nativeQuery?.connector ?? "database",
      detail: `Read from the statement stored in ${table.name}'s partition.`,
    });
    addEdge({
      from: sid,
      to: node.id,
      kind: "loads",
      reason: `${table.name} loads from ${object}.`,
    });
  }

  /* --- KPI -> KPI -------------------------------------------------------- */

  /*
   * Between KPI *names*, not between visuals.
   *
   * Once a KPI is one node covering every visual that reports it, pairing
   * visuals produces nonsense: three views of churn would be linked to each
   * other for sharing a measure, which is just the KPI node restated, and a
   * genuine link to another KPI would be drawn once per visual pair rather
   * than once.
   *
   * Only a direct dependency counts. Following the chain transitively relates
   * every KPI to every other one through a single shared base measure, which
   * is true and useless.
   */
  const kpiMeasures = new Map<string, Set<string>>();
  for (const kpi of kpis) {
    const name = kpiNameOf(kpi);
    if (!name) continue;
    const id = kpiNameKey(name);
    const set = kpiMeasures.get(id) ?? new Set<string>();
    for (const m of kpi.measureIds) set.add(m);
    kpiMeasures.set(id, set);
  }

  const kpiIds = [...kpiMeasures.keys()].sort();

  for (let i = 0; i < kpiIds.length; i++) {
    for (let j = i + 1; j < kpiIds.length; j++) {
      const a = kpiIds[i];
      const b = kpiIds[j];
      const aMeasures = kpiMeasures.get(a)!;
      const bMeasures = kpiMeasures.get(b)!;

      const shared = [...aMeasures].find((m) => bMeasures.has(m));
      if (shared) {
        addEdge({
          from: a,
          to: b,
          kind: "related",
          reason: `Both are built on [${measures.get(shared)?.name ?? "a measure"}], so they move together.`,
        });
        continue;
      }

      const calls = (from: Set<string>, to: Set<string>) => {
        for (const id of from) {
          const expression = measures.get(id)?.expression ?? "";
          for (const called of callsOf(expression, byName)) {
            if (to.has(called)) {
              return `${measures.get(id)?.name} calls [${measures.get(called)?.name}]`;
            }
          }
        }
        return undefined;
      };

      const link = calls(aMeasures, bMeasures) ?? calls(bMeasures, aMeasures);

      if (link) {
        addEdge({
          from: a,
          to: b,
          kind: "related",
          reason: `${link}, so changing one changes the other.`,
        });
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/* --------------------------------------------------------------- queries --- */

/** Every KPI in the model, for the picker. */
export function listKpis(model: Model): Array<{
  id: string;
  label: string;
  page: string;
  pageName: string;
  visualType: string;
  measureCount: number;
  /** The KPI this visual reports, shared by every visual showing it. */
  kpiName?: string;
}> {
  const kpiNames = inferKpiNames(model);
  const out: ReturnType<typeof listKpis> = [];

  for (const page of model.pages) {
    for (const visual of page.visuals) {
      if (!isKpiVisual(visual)) continue;
      const inferred = visual.refs
        .filter((r) => r.kind === "measure")
        .map((r) => bestKpiName(kpiNames, r.table ?? "", r.field)?.label)
        .find(Boolean);

      out.push({
        id: visualKey(visual),
        label: visual.title ?? inferred ?? `Untitled ${visual.type}`,
        page: page.displayName,
        pageName: page.name,
        visualType: visual.type,
        measureCount: visual.refs.filter((r) => r.kind === "measure").length,
        // Same rule the graph uses: the measure names the KPI, not the title.
        kpiName: (() => {
          const first = visual.refs.find((r) => r.kind === "measure");
          if (!first) return undefined;
          return bestKpiName(kpiNames, first.table ?? "", first.field)?.label ?? first.field;
        })(),
      });
    }
  }
  return out;
}

/** What the diagram leaves out of a page, and why. */
export function excludedFromPage(
  model: Model,
  pageName?: string
): Array<{ type: string; count: number; reason: string }> {
  const pages = pageName ? model.pages.filter((p) => p.name === pageName) : model.pages;
  const counts = new Map<string, { count: number; reason: string }>();

  for (const page of pages) {
    for (const visual of page.visuals) {
      if (isKpiVisual(visual)) continue;
      const type = visual.type || "unknown";
      const reason =
        NOT_A_KPI.has(type) || /slicer|filter|navigator|button/i.test(type)
          ? "A filter or navigation control, not a reported number."
          : visual.refs.some((r) => r.kind === "measure")
            ? "Excluded by type."
            : "Binds no measure, so it reports no number.";
      const seen = counts.get(type);
      if (seen) seen.count++;
      else counts.set(type, { count: 1, reason });
    }
  }

  return [...counts.entries()]
    .map(([type, v]) => ({ type, count: v.count, reason: v.reason }))
    .sort((a, b) => b.count - a.count);
}

/** Group nodes into the four lineage columns, left to right. */
export const LAYERS: NodeKind[] = ["source", "table", "measure", "visual", "kpi"];

export const LAYER_LABEL: Record<NodeKind, string> = {
  source: "Source object",
  table: "PBI table",
  measure: "Measure",
  visual: "Visual",
  kpi: "KPI",
};
