/**
 * The lineage diagram.
 *
 * Reads left to right in the direction the data moves — source object, PBI
 * table, measure, KPI — with dashed arcs between KPIs that depend on each
 * other. Clicking a node isolates its thread; everything not connected to it
 * dims rather than disappearing, so you keep your bearings.
 *
 * Scoped to one page by default. A sixteen-page report holds hundreds of
 * visuals and drawing all of them at once produces a picture nobody can read,
 * which is a worse answer than drawing one page well.
 */
import { useMemo, useState } from "react";

import {
  buildLineage,
  excludedFromPage,
  LAYER_LABEL,
  listKpis,
  type EdgeKind,
  type NodeKind,
} from "../lib/lineage/graph.ts";
import { connectedTo, layoutLineage, NODE_H, NODE_W, type PlacedNode } from "../lib/lineage/layout.ts";
import type { Model } from "../lib/powerbi/model.ts";
import { Collapsible, Head } from "./ui.tsx";

const KIND_CLASS: Record<NodeKind, string> = {
  source: "lnSource",
  table: "lnTable",
  measure: "lnMeasure",
  kpi: "lnKpi",
};

const EDGE_LABEL: Record<EdgeKind, string> = {
  loads: "loads",
  feeds: "feeds",
  calls: "calls",
  displays: "displays",
  related: "moves with",
};

export function Lineage({ model }: { model: Model }) {
  const kpis = useMemo(() => listKpis(model), [model]);

  const pagesWithKpis = useMemo(() => {
    const seen = new Map<string, { name: string; display: string; count: number }>();
    for (const k of kpis) {
      const row = seen.get(k.pageName);
      if (row) row.count++;
      else seen.set(k.pageName, { name: k.pageName, display: k.page, count: 1 });
    }
    return [...seen.values()];
  }, [kpis]);

  const [page, setPage] = useState<string>(() => pagesWithKpis[0]?.name ?? "");
  const [focus, setFocus] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const graph = useMemo(
    () => buildLineage(model, { page: page || undefined, focusKpi: focus || undefined }),
    [model, page, focus]
  );
  const layout = useMemo(() => layoutLineage(graph), [graph]);
  const lit = useMemo(
    () => (selected ? connectedTo(graph, selected) : null),
    [graph, selected]
  );
  const excluded = useMemo(() => excludedFromPage(model, page || undefined), [model, page]);

  const node = (id: string) => layout.nodes.find((n) => n.id === id);
  const selectedNode = selected ? node(selected) : null;

  /*
   * These are two different failures and they used to share one message that
   * asserted the first. "No report layout" is wrong, and misleading, when the
   * layout was in fact found and read but produced no pages — which is what a
   * report saved in a layout this build does not recognise looks like.
   */
  if (!model.capabilities.report.available) {
    return (
      <article className="card placeholder">
        <span>⤳</span>
        <h2>No report layout in this file</h2>
        <p>{model.capabilities.report.reason}</p>
        <p>
          KPIs are read from the visuals on each page, so without the layout there is nothing to
          trace back.
        </p>
      </article>
    );
  }

  if (model.pages.length === 0) {
    return (
      <article className="card placeholder">
        <span>⤳</span>
        <h2>The report layout was read, but it contained no pages</h2>
        <p>
          A report part was found in this file and parsed successfully, yet it described zero
          pages. Both report layouts this build reads — the single{" "}
          <code>Report/Layout</code> document and the PBIR folder under{" "}
          <code>Report/definition/pages/</code> — were checked.
        </p>
        <p>
          Settings lists every part in the archive, which will show what this file actually
          contains.
        </p>
        {model.warnings.length > 0 && (
          <ul className="notAssessed">
            {model.warnings.slice(0, 4).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </article>
    );
  }

  if (kpis.length === 0) {
    return (
      <article className="card placeholder">
        <span>⤳</span>
        <h2>No KPIs found</h2>
        <p>
          No visual in this report displays a measure. Slicers, filters, buttons, text boxes and
          visuals that bind only columns are deliberately not counted as KPIs, so a report built
          entirely from tables of raw columns will land here.
        </p>
      </article>
    );
  }

  const counts = {
    source: layout.nodes.filter((n) => n.kind === "source").length,
    table: layout.nodes.filter((n) => n.kind === "table").length,
    measure: layout.nodes.filter((n) => n.kind === "measure").length,
    kpi: layout.nodes.filter((n) => n.kind === "kpi").length,
  };
  const related = graph.edges.filter((e) => e.kind === "related").length;

  return (
    <>
      <article className="card checksWide">
        <Head over="KPI LINEAGE" title="What each number on the page is made of" />

        <div className="toolbar">
          <div className="filter">
            <select
              value={page}
              onChange={(e) => {
                setPage(e.target.value);
                setFocus("");
                setSelected(null);
              }}
            >
              {pagesWithKpis.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.display} — {p.count} KPI{p.count === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
          <div className="filter">
            <select
              value={focus}
              onChange={(e) => {
                setFocus(e.target.value);
                setSelected(null);
              }}
            >
              <option value="">Every KPI on this page</option>
              {kpis
                .filter((k) => k.pageName === page)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    Only: {k.label}
                  </option>
                ))}
            </select>
          </div>
          <button onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}>+</button>
          <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}>−</button>
          <button onClick={() => setZoom(1)}>Reset</button>
          {selected && <button onClick={() => setSelected(null)}>Clear selection</button>}
        </div>

        <div className="lnLegend">
          {(["source", "table", "measure", "kpi"] as NodeKind[]).map((k) => (
            <span key={k} className={`lnChip ${KIND_CLASS[k]}`}>
              {LAYER_LABEL[k]} <em>{counts[k]}</em>
            </span>
          ))}
          <span className="lnChip lnRelated">
            KPI moves with KPI <em>{related}</em>
          </span>
        </div>

        <p className="scoreNote">
          Arrows run in the direction the data moves. A KPI is a visual that displays a measure —
          slicers, filters, buttons and text boxes are never counted, and neither is a visual that
          binds only columns. Dashed arcs join KPIs whose measures depend on each other, so you can
          see which numbers move together. Click any box to isolate its thread.
        </p>

        {counts.kpi > 18 && !focus && (
          <p className="advisory">
            This page has {counts.kpi} KPIs, so the diagram is tall. Pick a single KPI above to
            see just its lineage.
          </p>
        )}

        <div className="lnCanvas">
          <svg
            width={layout.width * zoom}
            height={layout.height * zoom}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label="KPI lineage diagram"
          >
            <defs>
              <marker
                id="ln-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="lnArrowHead" />
              </marker>
              <marker
                id="ln-arrow-rel"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="lnArrowHeadRel" />
              </marker>
            </defs>

            {/* Edges first so the boxes sit on top of them. */}
            {layout.edges.map((e, i) => {
              const on = !lit || (lit.has(e.from) && lit.has(e.to));
              return (
                <path
                  key={`${e.from}-${e.to}-${e.kind}-${i}`}
                  d={e.d}
                  className={`lnEdge ${e.kind === "related" ? "lnEdgeRel" : ""} ${on ? "" : "lnDim"}`}
                  markerEnd={`url(#${e.kind === "related" ? "ln-arrow-rel" : "ln-arrow"})`}
                >
                  <title>{e.reason}</title>
                </path>
              );
            })}

            {layout.nodes.map((n) => {
              const on = !lit || lit.has(n.id);
              return (
                <g
                  key={n.id}
                  className={`lnNode ${KIND_CLASS[n.kind]} ${on ? "" : "lnDim"} ${selected === n.id ? "lnSelected" : ""}`}
                  transform={`translate(${n.x}, ${n.y})`}
                  onClick={() => setSelected(selected === n.id ? null : n.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setSelected(selected === n.id ? null : n.id);
                    }
                  }}
                >
                  <rect width={NODE_W} height={NODE_H} rx="7" />
                  <text className="lnLabel" x="12" y="21">
                    {clip(n.label, 26)}
                  </text>
                  {n.sublabel && (
                    <text className="lnSub" x="12" y="37">
                      {clip(n.sublabel, 30)}
                    </text>
                  )}
                  {n.inferred && (
                    <text className="lnGuess" x={NODE_W - 12} y="21" textAnchor="end">
                      guess
                    </text>
                  )}
                  <title>{n.detail ?? n.label}</title>
                </g>
              );
            })}
          </svg>
        </div>

        {selectedNode && <Details node={selectedNode} graph={graph} onJump={setSelected} />}
      </article>

      <article className="card checksWide">
        <Collapsible
          summary={<span>What this page has that is not a KPI</span>}
          count={excluded.reduce((n, e) => n + e.count, 0)}
        >
          {() =>
            excluded.length === 0 ? (
              <p className="emptyNote">Every visual on this page displays a measure.</p>
            ) : (
              <ul className="notAssessed">
                {excluded.map((e) => (
                  <li key={e.type}>
                    <b>{e.type}</b> × {e.count} — {e.reason}
                  </li>
                ))}
              </ul>
            )
          }
        </Collapsible>
      </article>
    </>
  );
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What the selected box is, and what sits either side of it. */
function Details({
  node,
  graph,
  onJump,
}: {
  node: PlacedNode;
  graph: ReturnType<typeof buildLineage>;
  onJump: (id: string) => void;
}) {
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const upstream = graph.edges.filter((e) => e.to === node.id && e.kind !== "related");
  const downstream = graph.edges.filter((e) => e.from === node.id && e.kind !== "related");
  const sideways = graph.edges.filter(
    (e) => e.kind === "related" && (e.from === node.id || e.to === node.id)
  );

  const list = (
    title: string,
    rows: typeof upstream,
    pick: (e: (typeof upstream)[number]) => string
  ) =>
    rows.length > 0 && (
      <>
        <h3 className="drawerSection">{title}</h3>
        {rows.map((e, i) => (
          <div className="measureRow" key={`${e.from}-${e.to}-${i}`}>
            <div className="measureTop">
              <button className="linkish" onClick={() => onJump(pick(e))}>
                {label(pick(e))}
              </button>
              <span className="srcTag">{EDGE_LABEL[e.kind]}</span>
            </div>
            <div className="measureMeta">{e.reason}</div>
          </div>
        ))}
      </>
    );

  return (
    <div className="lnDetails">
      <div className="measureTop">
        <b>{node.label}</b>
        <span className="kpiTag">{LAYER_LABEL[node.kind]}</span>
        {node.page && <span className="srcTag">{node.page}</span>}
      </div>
      {node.detail && <p className="drawerNote">{node.detail}</p>}

      {list("Feeds into this", upstream, (e) => e.from)}
      {list("This feeds", downstream, (e) => e.to)}
      {sideways.length > 0 && (
        <>
          <h3 className="drawerSection">Moves with</h3>
          {sideways.map((e, i) => {
            const other = e.from === node.id ? e.to : e.from;
            return (
              <div className="measureRow" key={`rel-${i}`}>
                <div className="measureTop">
                  <button className="linkish" onClick={() => onJump(other)}>
                    {label(other)}
                  </button>
                </div>
                <div className="measureMeta">{e.reason}</div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
