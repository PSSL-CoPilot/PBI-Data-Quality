/**
 * The measures workspace.
 *
 * Three ways of looking at the same set: flat, grouped by the report page whose
 * visuals bind them, and grouped by the table their DAX actually reads. The
 * last one deliberately ignores the home table, because a model with a single
 * `Measures` table would otherwise collapse into one meaningless group.
 *
 * KPI names are inferred from report layout and always labelled "Likely", since
 * nothing in the file states the link between `M Unique Sales` and the heading
 * a reader sees.
 */
import { useMemo, useState } from "react";

import { rewriteAsChange, type OptimizationResult, type Opportunity } from "../lib/optimize/engine.ts";
import type { Change } from "../lib/edit/session.ts";
import { bestKpiName, inferKpiNames } from "../lib/powerbi/kpi.ts";
import { allMeasures, type Measure, type Model } from "../lib/powerbi/model.ts";
import {
  analyseMeasureSources,
  groupMeasuresByPage,
  groupMeasuresBySourceTable,
  measuresNotOnAnyPage,
  type MeasureSources,
  type VisualBinding,
} from "../lib/powerbi/sources.ts";
import { findMeasureReferences, findUsage, usageLabel } from "../lib/powerbi/usage.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { MeasureEditor } from "./Editor.tsx";

type Mode = "All" | "By Report" | "By PBI Table";
const MODES: Mode[] = ["All", "By Report", "By PBI Table"];

export type Focus = { type: string; name: string; table?: string; page?: string } | null;

let counter = 0;
const nextId = () => `opt-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

interface Analysis {
  kpis: ReturnType<typeof inferKpiNames>;
  sources: Map<string, MeasureSources>;
  rewriteFor: Map<string, Opportunity>;
}

function SourceTags({ analysis, measure }: { analysis: Analysis; measure: Measure }) {
  const kpi = bestKpiName(analysis.kpis, measure.table, measure.name);
  const sources = analysis.sources.get(`${measure.table}[${measure.name}]`);

  return (
    <>
      {kpi && (
        <span
          className={kpi.confidence === "low" ? "kpiTag low" : "kpiTag"}
          title={`From the ${
            kpi.source === "visual-title" ? "visual title" : "nearest caption"
          } on ${kpi.pageDisplayName}${kpi.distance !== undefined ? `, ${kpi.distance}px away` : ""}`}
        >
          Likely KPI: {kpi.label}
        </span>
      )}
      {sources?.primary ? (
        <span className="srcTag" title={sources.reason}>
          Source: {sources.primary}
        </span>
      ) : sources && sources.all.length > 0 ? (
        <span className="srcTag" title={sources.reason}>
          Sources: {sources.all.slice(0, 3).join(", ")}
        </span>
      ) : null}
    </>
  );
}

function MeasureRow({
  model,
  measure,
  analysis,
  onOpen,
  onOptimize,
}: {
  model: Model;
  measure: Measure;
  analysis: Analysis;
  onOpen: (measure: Measure) => void;
  onOptimize: (opportunity: Opportunity) => void;
}) {
  const [open, setOpen] = useState(false);
  const key = `${measure.table}[${measure.name}]`;
  const sources = analysis.sources.get(key);
  const rewrite = analysis.rewriteFor.get(key);
  const usage = findUsage(model, "measure", measure.table, measure.name);

  return (
    <div className="measureRow">
      <div className="measureTop">
        <b>ƒ {measure.name}</b>
        <SourceTags analysis={analysis} measure={measure} />
        <span className="srcTag">Home: {measure.table}</span>
      </div>

      <div className="measureMeta">
        {usageLabel(usage, findMeasureReferences(model, measure.name))}
        {sources?.reason ? ` · ${sources.reason}` : ""}
      </div>

      <div className="measureActions">
        <button onClick={() => setOpen((v) => !v)}>{open ? "Hide DAX" : "View DAX"}</button>
        <button onClick={() => onOpen(measure)}>Open / edit</button>
        {rewrite && (
          <button className="go" onClick={() => onOptimize(rewrite)}>
            ⚡ Optimize
          </button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <CodeEditor value={measure.expression} language="dax" readOnly minHeight={120} />
        </div>
      )}
    </div>
  );
}

/**
 * One visual and the measures it binds.
 *
 * This is the report's own statement of what powers a KPI, so it renders even
 * when the model could not be read: the binding names the measure, and the DAX
 * is attached only if it happens to be available.
 */
function VisualBindingRow({
  visual,
  page,
  analysis,
  model,
  onOpen,
  onOptimize,
}: {
  visual: VisualBinding;
  page: string;
  analysis: Analysis;
  model: Model;
  onOpen: (measure: Measure) => void;
  onOptimize: (opportunity: Opportunity) => void;
}) {
  // The visual's own title is the strongest KPI label; otherwise fall back to
  // the caption inference already computed for its measures.
  const inferred = visual.measures
    .map((m) => bestKpiName(analysis.kpis, m.boundTable ?? m.measure?.table ?? "", m.name))
    .find(Boolean);
  const label = visual.title ?? inferred?.label;

  return (
    <div className="measureRow">
      <div className="measureTop">
        <b>▦ {label ?? visual.visualType}</b>
        <span className="srcTag">{visual.visualType}</span>
        {label && !visual.title && (
          <span className={inferred?.confidence === "low" ? "kpiTag low" : "kpiTag"}>
            Likely KPI name
          </span>
        )}
      </div>

      {visual.measures.length === 0 ? (
        <div className="measureMeta">Binds columns only: {visual.columns.map((c) => c.name).join(", ")}</div>
      ) : (
        <div className="bindList">
          {visual.measures.map((bound) => {
            const key = bound.measure
              ? `${bound.measure.table}[${bound.measure.name}]`
              : `${bound.boundTable ?? "?"}[${bound.name}]`;
            const rewrite = bound.measure ? analysis.rewriteFor.get(key) : undefined;
            return (
              <div className="bindRow" key={`${visual.visualId}-${key}`}>
                <span className="arrow">→</span>
                <b>[{bound.name}]</b>
                {bound.boundTable && <span className="srcTag">{bound.boundTable}</span>}
                {bound.measure ? (
                  <>
                    <button onClick={() => onOpen(bound.measure!)}>Open / edit</button>
                    {rewrite && (
                      <button className="go" onClick={() => onOptimize(rewrite)}>
                        ⚡ Optimize
                      </button>
                    )}
                  </>
                ) : (
                  <span className="advisory">
                    {model.capabilities.model.available
                      ? "not found in the model"
                      : "DAX needs the full file"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {visual.columns.length > 0 && visual.measures.length > 0 && (
        <div className="measureMeta">
          Also uses columns: {visual.columns.map((c) => c.name).join(", ")}
        </div>
      )}
      <div className="measureMeta">On {page}</div>
    </div>
  );
}

function Group({
  title,
  note,
  count,
  children,
}: {
  title: string;
  note?: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <article className="groupCard">
      <button className="groupHead" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▼" : "▶"}</span>
        <b>{title}</b>
        <em>
          {count} measure{count === 1 ? "" : "s"}
          {note ? ` · ${note}` : ""}
        </em>
      </button>
      {open && <div className="groupBody">{children}</div>}
    </article>
  );
}

export function Measures({
  model,
  focus,
  opt,
  onApply,
}: {
  model: Model;
  focus: Focus;
  opt: OptimizationResult;
  onApply: (changes: Change[]) => void;
}) {
  const [mode, setMode] = useState<Mode>("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Measure | null>(() =>
    focus?.type === "measure"
      ? (allMeasures(model).find(
          (m) => m.name === focus.name && (!focus.table || m.table === focus.table)
        ) ?? null)
      : null
  );

  const analysis: Analysis = useMemo(() => {
    const rewriteFor = new Map<string, Opportunity>();
    for (const item of opt.rewrites) {
      if (item.target.type === "measure" && item.target.table) {
        const key = `${item.target.table}[${item.target.name}]`;
        // Keep the highest-confidence rewrite per measure.
        if (!rewriteFor.has(key)) rewriteFor.set(key, item);
      }
    }
    return { kpis: inferKpiNames(model), sources: analyseMeasureSources(model), rewriteFor };
  }, [model, opt]);

  const measures = allMeasures(model);
  const matches = (measure: Measure) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const kpi = bestKpiName(analysis.kpis, measure.table, measure.name)?.label ?? "";
    return `${measure.name} ${measure.table} ${measure.expression} ${kpi}`
      .toLowerCase()
      .includes(needle);
  };

  /** Search by name alone, for bindings whose model definition may be absent. */
  const matchesName = (name: string) => {
    const needle = query.trim().toLowerCase();
    return needle ? name.toLowerCase().includes(needle) : true;
  };

  const visible = measures.filter(matches);

  const optimize = (opportunity: Opportunity) => {
    const change = rewriteAsChange(opportunity, nextId(), Date.now());
    if (change) onApply([change]);
  };

  const rowProps = { model, analysis, onOpen: setSelected, onOptimize: optimize };

  return (
    <>
      <article className="card explorer">
        <div className="toolbar">
          <div className="viewToggle">
            {MODES.map((option) => (
              <button
                key={option}
                className={mode === option ? "on" : ""}
                onClick={() => setMode(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="filter">
            ⌕{" "}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search measures, DAX and KPI names..."
            />
          </div>
          <button>
            {visible.length} of {measures.length}
          </button>
        </div>

        {mode === "All" && (
          <table>
            <thead>
              <tr>
                {["Measure name", "Likely KPI", "Home table", "Source tables", "DAX", "Used on"].map(
                  (h) => (
                    <th key={h}>{h}</th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((measure) => {
                const key = `${measure.table}[${measure.name}]`;
                const kpi = bestKpiName(analysis.kpis, measure.table, measure.name);
                const sources = analysis.sources.get(key);
                const usage = findUsage(model, "measure", measure.table, measure.name);
                const focused = focus?.type === "measure" && focus.name === measure.name;
                return (
                  <tr
                    key={key}
                    className={focused ? "hit" : ""}
                    onClick={() => setSelected(measure)}
                  >
                    <td>
                      <b>ƒ {measure.name}</b>
                    </td>
                    <td>{kpi ? kpi.label : "—"}</td>
                    <td>{measure.table}</td>
                    <td>{sources?.primary ?? sources?.all.slice(0, 2).join(", ") ?? "—"}</td>
                    <td>{measure.expression.replace(/\s+/g, " ").slice(0, 60)}</td>
                    <td>
                      {usage.pages.length} page{usage.pages.length === 1 ? "" : "s"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </article>

      {mode === "By Report" && (
        <>
          {groupMeasuresByPage(model).map((group) => {
            const visuals = group.visuals.filter((v) =>
              v.measures.some((m) => matchesName(m.name)) || matchesName(v.title ?? "")
            );
            const shownMeasures = group.measures.filter((m) => matchesName(m.name));
            return (
              <Group
                key={group.page}
                title={group.displayName}
                note={[
                  group.isHidden ? "hidden page" : null,
                  `${group.visuals.length} visual${group.visuals.length === 1 ? "" : "s"}`,
                  group.unresolved.length
                    ? `${group.unresolved.length} not found in model`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                count={shownMeasures.length}
              >
                {visuals.length === 0 ? (
                  <p className="emptyNote">
                    {group.visuals.length === 0
                      ? "No visual on this page binds a measure or column."
                      : "Nothing on this page matches the search."}
                  </p>
                ) : (
                  visuals.map((visual) => (
                    <VisualBindingRow
                      key={visual.visualId}
                      visual={visual}
                      page={group.displayName}
                      analysis={analysis}
                      model={model}
                      onOpen={setSelected}
                      onOptimize={optimize}
                    />
                  ))
                )}
                {group.unresolved.length > 0 && (
                  <p className="emptyNote">
                    Bound by a visual but not present in the model:{" "}
                    {group.unresolved.join(", ")}
                  </p>
                )}
              </Group>
            );
          })}

          {(() => {
            const orphans = measuresNotOnAnyPage(model).filter(matches);
            return orphans.length > 0 ? (
              <Group title="Not on any page" count={orphans.length}>
                {orphans.map((measure) => (
                  <MeasureRow key={`${measure.table}.${measure.name}`} measure={measure} {...rowProps} />
                ))}
              </Group>
            ) : null;
          })()}
        </>
      )}

      {mode === "By PBI Table" &&
        groupMeasuresBySourceTable(model, analysis.sources).map((group) => {
          const shown = group.measures.filter(matches);
          if (shown.length === 0) return null;
          return (
            <Group
              key={group.table}
              title={group.table}
              note={
                group.movedIn > 0
                  ? `${group.movedIn} grouped by DAX, not by home table`
                  : undefined
              }
              count={shown.length}
            >
              {shown.map((measure) => (
                <MeasureRow key={`${measure.table}.${measure.name}`} measure={measure} {...rowProps} />
              ))}
            </Group>
          );
        })}

      {selected && (
        <MeasureDrawer
          model={model}
          measure={selected}
          analysis={analysis}
          close={() => setSelected(null)}
          onApply={(changes) => {
            onApply(changes);
            setSelected(null);
          }}
          onOptimize={optimize}
        />
      )}
    </>
  );
}

function MeasureDrawer({
  model,
  measure,
  analysis,
  close,
  onApply,
  onOptimize,
}: {
  model: Model;
  measure: Measure;
  analysis: Analysis;
  close: () => void;
  onApply: (changes: Change[]) => void;
  onOptimize: (opportunity: Opportunity) => void;
}) {
  const [editing, setEditing] = useState(false);
  const key = `${measure.table}[${measure.name}]`;
  const usage = findUsage(model, "measure", measure.table, measure.name);
  const daxRefs = findMeasureReferences(model, measure.name);
  const kpi = bestKpiName(analysis.kpis, measure.table, measure.name);
  const sources = analysis.sources.get(key);
  const rewrite = analysis.rewriteFor.get(key);

  return (
    <div className="drawer">
      <div className="drawerHead">
        <div>
          <small>MEASURE</small>
          <h2>{measure.name}</h2>
        </div>
        <button onClick={close}>×</button>
      </div>

      <div className="tabs">
        <button className={editing ? "" : "on"} onClick={() => setEditing(false)}>
          Overview
        </button>
        <button className={editing ? "on" : ""} onClick={() => setEditing(true)}>
          Edit measure
        </button>
      </div>

      {editing ? (
        <MeasureEditor
          model={model}
          measure={measure}
          onApply={onApply}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="measureTop" style={{ marginTop: 12 }}>
            <SourceTags analysis={analysis} measure={measure} />
          </div>
          {kpi && (
            <p className="measureMeta">
              Inferred from the {kpi.source === "visual-title" ? "visual title" : "nearest caption"}{" "}
              on {kpi.pageDisplayName}
              {kpi.distance !== undefined ? `, ${kpi.distance}px away` : ""}. This is a guess, not a
              stated name.
            </p>
          )}
          {sources && <p className="measureMeta">{sources.reason}</p>}

          {rewrite && (
            <div className="measureActions" style={{ marginBottom: 10 }}>
              <button className="go" onClick={() => onOptimize(rewrite)}>
                ⚡ Optimize: {rewrite.rewrite?.recommendation}
              </button>
            </div>
          )}

          <CodeEditor value={measure.expression} language="dax" readOnly label="DAX expression" />

          <div className="meta" style={{ marginTop: 12 }}>
            <span>
              <small>FORMAT</small>
              {measure.formatString ?? "—"}
            </span>
            <span>
              <small>HOME TABLE</small>
              {measure.table}
            </span>
            <span>
              <small>USED IN</small>
              {usageLabel(usage, daxRefs)}
            </span>
          </div>

          <div className="objectList">
            <h3>Report usage</h3>
            {usage.hits.length === 0 ? (
              <div>◇ Not referenced by any visual in this report.</div>
            ) : (
              usage.hits.map((hit) => (
                <div key={`${hit.page.name}-${hit.visual.id}`}>
                  ◇ {hit.page.displayName} · {hit.visual.title ?? hit.visual.type}
                </div>
              ))
            )}

            <h3>Referenced by measures</h3>
            {daxRefs.length === 0 ? (
              <div>◇ No other measure references this one.</div>
            ) : (
              daxRefs.map((ref) => <div key={ref}>◇ {ref}</div>)
            )}
          </div>
        </>
      )}

      <div className="drawerFoot">
        <button onClick={close}>Done</button>
      </div>
    </div>
  );
}
