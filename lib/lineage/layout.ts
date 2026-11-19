/**
 * Laying the lineage out as a left-to-right diagram.
 *
 * Four columns, one per layer, in the direction the data moves. Within a
 * column the order is chosen to reduce crossings: each node is placed near the
 * average height of the nodes it connects to in the column before it, swept
 * forwards then backwards a few times. That is the barycentre heuristic — it
 * does not minimise crossings (nothing cheap does) but it reliably turns a
 * tangle into something readable, which is the whole point of drawing it.
 *
 * Geometry only. Nothing here knows what a KPI is, so the layout can be tested
 * without a model and the diagram can be re-skinned without touching it.
 */
import type { LineageEdge, LineageGraph, LineageNode, NodeKind } from "./graph.ts";
import { LAYERS } from "./graph.ts";

export const NODE_W = 196;
export const NODE_H = 52;
export const COL_GAP = 132;
export const ROW_GAP = 18;
export const PAD = 28;

export interface PlacedNode extends LineageNode {
  x: number;
  y: number;
  column: number;
}

export interface PlacedEdge extends LineageEdge {
  /** SVG path data. */
  d: string;
  /** Where to put the arrowhead. */
  tip: { x: number; y: number };
  /** True when both ends sit in the same column (a KPI-to-KPI link). */
  sameColumn: boolean;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

/** Columns that actually contain something, so an empty layer takes no space. */
function usedLayers(nodes: LineageNode[]): NodeKind[] {
  return LAYERS.filter((layer) => nodes.some((n) => n.kind === layer));
}

export function layoutLineage(graph: LineageGraph): Layout {
  const layers = usedLayers(graph.nodes);
  // Column contents, initially in the order the graph produced them.
  const columns: LineageNode[][] = layers.map((layer) =>
    graph.nodes.filter((n) => n.kind === layer)
  );

  const indexIn = (col: LineageNode[], id: string) => col.findIndex((n) => n.id === id);

  /* --- order each column to reduce crossings ---------------------------- */

  const neighbourRows = (node: LineageNode, other: LineageNode[], incoming: boolean) => {
    const rows: number[] = [];
    for (const edge of graph.edges) {
      if (edge.kind === "related") continue; // same-column, no bearing on order
      const id = incoming ? edge.to : edge.from;
      const partner = incoming ? edge.from : edge.to;
      if (id !== node.id) continue;
      const row = indexIn(other, partner);
      if (row >= 0) rows.push(row);
    }
    return rows;
  };

  const sweep = (forwards: boolean) => {
    const order = forwards
      ? [...columns.keys()].slice(1)
      : [...columns.keys()].slice(0, -1).reverse();

    for (const c of order) {
      const reference = columns[forwards ? c - 1 : c + 1];
      const scored = columns[c].map((node, i) => {
        const rows = neighbourRows(node, reference, forwards);
        const barycentre =
          rows.length > 0 ? rows.reduce((a, b) => a + b, 0) / rows.length : i;
        return { node, barycentre, i };
      });
      // A stable tie-break keeps unconnected nodes where they were.
      scored.sort((a, b) => a.barycentre - b.barycentre || a.i - b.i);
      columns[c] = scored.map((s) => s.node);
    }
  };

  for (let pass = 0; pass < 3; pass++) {
    sweep(true);
    sweep(false);
  }

  /* --- place ------------------------------------------------------------ */

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const width = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * COL_GAP;

  const placed: PlacedNode[] = [];
  columns.forEach((col, c) => {
    // Centre short columns against the tallest one.
    const colHeight = col.length * NODE_H + (col.length - 1) * ROW_GAP;
    const top = PAD + (height - PAD * 2 - colHeight) / 2;
    col.forEach((node, r) => {
      placed.push({
        ...node,
        column: c,
        x: PAD + c * (NODE_W + COL_GAP),
        y: top + r * (NODE_H + ROW_GAP),
      });
    });
  });

  const byId = new Map(placed.map((n) => [n.id, n]));

  /* --- route ------------------------------------------------------------ */

  const edges: PlacedEdge[] = [];
  /*
   * Same-column arcs bow out to the right of their column. When that column is
   * the last one — which it always is for KPI-to-KPI links — the bulge reaches
   * past the width the columns alone imply, and the SVG viewBox clips it. The
   * furthest any arc reaches is tracked here and folded into the width below.
   */
  let rightmost = 0;

  for (const edge of graph.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;

    if (a.column === b.column) {
      /*
       * A same-column link (KPI to KPI) bows out to the right of the column so
       * it cannot be mistaken for a feed arrow, and so it stays clear of the
       * node bodies it passes.
       */
      const x = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const y2 = b.y + NODE_H / 2;
      const bulge = 34 + Math.abs(y2 - y1) * 0.16;
      // The control points sit at x + bulge, so that is how far the curve can
      // reach; a cubic never exceeds the hull of its control points.
      rightmost = Math.max(rightmost, x + bulge);
      edges.push({
        ...edge,
        sameColumn: true,
        d: `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`,
        tip: { x, y: y2 },
      });
      continue;
    }

    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mid = (x2 - x1) / 2;
    edges.push({
      ...edge,
      sameColumn: false,
      d: `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`,
      tip: { x: x2, y: y2 },
    });
  }

  return {
    nodes: placed,
    edges,
    width: Math.max(width, Math.ceil(rightmost) + PAD),
    height,
  };
}

/**
 * Everything upstream and downstream of one node.
 *
 * Used to dim the rest of the diagram when a node is selected: a lineage
 * diagram is only useful if you can isolate one thread of it.
 */
export function connectedTo(graph: LineageGraph, id: string): Set<string> {
  const keep = new Set<string>([id]);

  const walk = (start: string, forwards: boolean) => {
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const edge of graph.edges) {
        const from = forwards ? edge.from : edge.to;
        const to = forwards ? edge.to : edge.from;
        if (from !== current || keep.has(to)) continue;
        keep.add(to);
        queue.push(to);
      }
    }
  };

  walk(id, true);
  walk(id, false);
  return keep;
}
