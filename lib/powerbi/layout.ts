/**
 * Parser for the `Report/Layout` part, which is UTF-16LE JSON and is present in
 * both PBIX and PBIT. This is the entire report layer: pages, visuals and every
 * field binding.
 *
 * Bindings are collected by walking the whole visual config rather than only
 * `prototypeQuery.Select`, because references also hide in `Where`, `OrderBy`,
 * container `filters` and `dataTransforms`. A rename that misses one of those
 * produces exactly the broken report the spec forbids.
 */
import type { FieldRef, Page, Visual } from "./model.ts";

/** Fields whose value is itself a JSON document encoded as a string. */
const NESTED_JSON_FIELDS = ["config", "filters", "query", "dataTransforms"];

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Expand the string-encoded JSON fields one level so the walker can see them. */
function expand(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  for (const field of NESTED_JSON_FIELDS) {
    if (field in out) out[field] = parseMaybeJson(out[field]);
  }
  return out;
}

type AliasMap = Record<string, string>;

function readFrom(node: Record<string, unknown>, inherited: AliasMap): AliasMap {
  const from = node.From;
  if (!Array.isArray(from)) return inherited;
  const map: AliasMap = { ...inherited };
  for (const entry of from) {
    if (entry && typeof entry === "object") {
      const { Name, Entity } = entry as { Name?: string; Entity?: string };
      if (Name && Entity) map[Name] = Entity;
    }
  }
  return map;
}

function sourceAlias(expression: unknown): string | undefined {
  if (!expression || typeof expression !== "object") return undefined;
  const sourceRef = (expression as { SourceRef?: { Source?: string; Entity?: string } })
    .SourceRef;
  return sourceRef?.Source ?? sourceRef?.Entity;
}

/**
 * Recursively collect every measure/column/hierarchy binding, resolving the
 * `SourceRef` alias against the nearest enclosing `From` clause.
 */
export function collectRefs(root: unknown): FieldRef[] {
  const found = new Map<string, FieldRef>();

  const visit = (node: unknown, aliases: AliasMap): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, aliases);
      return;
    }
    if (!node || typeof node !== "object") return;

    const current = expand(node as Record<string, unknown>);
    const scope = readFrom(current, aliases);

    for (const [key, value] of Object.entries(current)) {
      if (
        (key === "Measure" || key === "Column") &&
        value &&
        typeof value === "object"
      ) {
        const { Expression, Property } = value as {
          Expression?: unknown;
          Property?: string;
        };
        if (Property) {
          const alias = sourceAlias(Expression);
          const table = alias ? scope[alias] ?? alias : undefined;
          const kind = key === "Measure" ? "measure" : "column";
          const id = `${kind}:${table ?? ""}[${Property}]`;
          if (!found.has(id)) found.set(id, { table, field: Property, kind });
        }
      }

      if (key === "Hierarchy" && value && typeof value === "object") {
        const { Expression, Hierarchy } = value as {
          Expression?: unknown;
          Hierarchy?: string;
        };
        if (Hierarchy) {
          const alias = sourceAlias(Expression);
          const table = alias ? scope[alias] ?? alias : undefined;
          const id = `hierarchy:${table ?? ""}[${Hierarchy}]`;
          if (!found.has(id)) {
            found.set(id, { table, field: Hierarchy, kind: "hierarchy" });
          }
        }
      }

      visit(value, scope);
    }
  };

  visit(root, {});
  return [...found.values()];
}

function visualTitle(singleVisual: Record<string, unknown>): string | undefined {
  const vcObjects = singleVisual.vcObjects as
    | { title?: Array<{ properties?: { text?: { expr?: { Literal?: { Value?: string } } } } }> }
    | undefined;
  const raw = vcObjects?.title?.[0]?.properties?.text?.expr?.Literal?.Value;
  // Literal values arrive single-quoted, e.g. "'Net Sales by Month'".
  return typeof raw === "string" ? raw.replace(/^'|'$/g, "") : undefined;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Parse a decoded `Report/Layout` document into normalized pages and visuals. */
export function parseLayout(layout: unknown): { pages: Page[]; warnings: string[] } {
  const warnings: string[] = [];
  const sections = (layout as { sections?: unknown[] })?.sections;
  if (!Array.isArray(sections)) {
    return { pages: [], warnings: ["Report/Layout contained no report sections."] };
  }

  const pages = sections.map((rawSection, index): Page => {
    const section = rawSection as Record<string, unknown>;
    const config = parseMaybeJson(section.config) as { visibility?: number } | undefined;
    const containers = Array.isArray(section.visualContainers)
      ? (section.visualContainers as Record<string, unknown>[])
      : [];

    const name = String(section.name ?? `section${index}`);

    const visuals = containers.flatMap((container): Visual[] => {
      const config = parseMaybeJson(container.config) as Record<string, unknown> | undefined;
      if (!config || typeof config !== "object") return [];

      // Visual groups are layout containers, not data-bound visuals.
      if (config.singleVisualGroup) return [];

      const singleVisual = config.singleVisual as Record<string, unknown> | undefined;
      if (!singleVisual) return [];

      return [
        {
          id: String(config.name ?? container.id ?? ""),
          page: name,
          type: String(singleVisual.visualType ?? "unknown"),
          title: visualTitle(singleVisual),
          x: num(container.x),
          y: num(container.y),
          width: num(container.width),
          height: num(container.height),
          refs: collectRefs(container),
        },
      ];
    });

    return {
      name,
      displayName: String(section.displayName ?? name),
      ordinal: num(section.ordinal, index),
      // `visibility: 1` is HiddenInViewMode; absent means visible.
      isHidden: config?.visibility === 1,
      width: num(section.width, 1280),
      height: num(section.height, 720),
      visuals,
    };
  });

  pages.sort((a, b) => a.ordinal - b.ordinal);
  return { pages, warnings };
}
