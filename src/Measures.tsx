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
import { useDeferredValue, useMemo, useState } from "react";

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
import { buildMeasureReferenceIndex, UsageIndex, usageLabel } from "../lib/powerbi/usage.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { MeasureEditor } from "./Editor.tsx";
import { useDrawerPresence } from "./drawer.tsx";
import { Collapsible } from "./ui.tsx";

type Mode = "By Report" | "By PBI Table" | "All";
const MODES: Mode[] = ["By Report", "By PBI Table", "All"];

export type Focus = { type: string; name: string; table?: string; page?: string } | null;

let counter = 0;
const nextId = () => `opt-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

interface Analysis {
  kpis: ReturnType<typeof inferKpiNames>;
  sources: Map<string, MeasureSources>;
  rewriteFor: Map<string, Opportunity>;
  /** One pass over the report, shared by every row that asks "used where?". */
  usage: UsageIndex;
  /** Measure name to the measures that call it, built once. */
  callers: Map<string, string[]>;
}

type Kpi = NonNullable<ReturnType<typeof bestKpiName>>;

/** Where an inferred business name came from, in one sentence. */
function kpiReason(kpi: Kpi): string {
  const from = kpi.source === "visual-title" ? "the title of a visual" : "the nearest caption";
  const near = kpi.distance !== undefined ? `, ${kpi.distance}px away` : "";
  return `This name was read from ${from} on ${kpi.pageDisplayName}${near}. The report does not state a business name for this measure, so this is an informed guess rather than something the file declares.`;
}

/** An unobtrusive "why does it say that" marker. */
function InfoDot({ text }: { text: string }) {
  return (
    <span className="infoDot" title={text} role="img" aria-label={text}>
      i
    </span>
  );
}

/**
 * A measure's name, business-first.
 *
 * Functional users recognise "Revenue this year", not `[MTD_Rev_Amt_v2]`, so
 * the inferred business name leads and the technical name follows it. When
 * nothing could be inferred the technical name is all there is, and it leads.
 */
function MeasureName({ kpi, name }: { kpi: Kpi | undefined; name: string }) {
  if (!kpi) return <b>{name}</b>;
  return (
    <>
      <b className={kpi.confidence === "low" ? "bizName weak" : "bizName"}>{kpi.label}</b>
      <span className="techName">{name}</span>
      <InfoDot text={kpiReason(kpi)} />
    </>
  );
}

function SourceTags({ analysis, measure }: { analysis: Analysis; measure: Measure }) {
  const sources = analysis.sources.get(`${measure.table}[${measure.name}]`);

  return (
    <>
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
  measure,
  analysis,
  onOpen,
  onOptimize,
}: {
  measure: Measure;
  analysis: Analysis;
  onOpen: (measure: Measure) => void;
  onOptimize: (opportunity: Opportunity) => void;
}) {
  const [open, setOpen] = useState(false);
  const key = `${measure.table}[${measure.name}]`;
  const sources = analysis.sources.get(key);
  const rewrite = analysis.rewriteFor.get(key);
  const usage = analysis.usage.find("measure", measure.table, measure.name);

  return (
    <div className="measureRow">
      <div className="measureTop">
        <MeasureName kpi={bestKpiName(analysis.kpis, measure.table, measure.name)} name={measure.name} />
        <SourceTags analysis={analysis} measure={measure} />
        <span className="srcTag">Home: {measure.table}</span>
      </div>

      <div className="measureMeta">
        {usageLabel(usage, analysis.callers.get(measure.name) ?? [])}
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
            const boundKpi = bestKpiName(
              analysis.kpis,
              bound.measure?.table ?? bound.boundTable ?? "",
              bound.name
            );
            return (
              <div className="bindRow" key={`${visual.visualId}-${key}`}>
                <span className="arrow">→</span>
                {/* The visual heading right above already says it; repeating
                    the same words on the next line only reads as a stutter. */}
                <MeasureName
                  kpi={boundKpi?.label === label ? undefined : boundKpi}
                  name={bound.name}
                />
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
  /** A thunk, so a collapsed page costs nothing to render. */
  children: () => React.ReactNode;
}) {
  /*
   * Closed on arrival, like every other expandable section in the app. A
   * sixteen-page report opened as sixteen expanded pages of visuals, which put
   * several hundred rows on screen before the reviewer had asked for any of
   * them — slow to render and impossible to scan.
   */
  return (
    <Collapsible
      className="groupCard"
      summary={
        <>
          <b>{title}</b>
          <em className="groupNote">
            {count} measure{count === 1 ? "" : "s"}
            {note ? ` · ${note}` : ""}
          </em>
        </>
      }
    >
      {children}
    </Collapsible>
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
  const [mode, setMode] = useState<Mode>("By Report");
  /*
   * The box stays controlled by `query`, so a keystroke always shows
   * immediately. Filtering reads the deferred copy instead, which React may
   * render late and abandon when the next keystroke arrives — without it every
   * character re-filtered the whole model and cost about 90ms, which is five
   * dropped frames per letter.
   */
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
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
    return {
      kpis: inferKpiNames(model),
      sources: analyseMeasureSources(model),
      rewriteFor,
      usage: new UsageIndex(model),
      callers: buildMeasureReferenceIndex(model),
    };
  }, [model, opt]);

  const measures = useMemo(() => allMeasures(model), [model]);
  const byPage = useMemo(() => groupMeasuresByPage(model), [model]);
  const bySourceTable = useMemo(
    () => groupMeasuresBySourceTable(model, analysis.sources),
    [model, analysis.sources]
  );
  const orphans = useMemo(() => measuresNotOnAnyPage(model), [model]);
  const matches = (measure: Measure) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    const kpi = bestKpiName(analysis.kpis, measure.table, measure.name)?.label ?? "";
    return `${measure.name} ${measure.table} ${measure.expression} ${kpi}`
      .toLowerCase()
      .includes(needle);
  };

  /** Search by name alone, for bindings whose model definition may be absent. */
  const matchesName = (name: string) => {
    const needle = search.trim().toLowerCase();
    return needle ? name.toLowerCase().includes(needle) : true;
  };

  const visible = measures.filter(matches);

  const optimize = (opportunity: Opportunity) => {
    const change = rewriteAsChange(opportunity, nextId(), Date.now());
    if (change) onApply([change]);
  };

  const rowProps = { analysis, onOpen: setSelected, onOptimize: optimize };

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
                {["Business name", "Measure name", "Home table", "Source tables", "DAX", "Used on"].map(
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
                const usage = analysis.usage.find("measure", measure.table, measure.name);
                const focused = focus?.type === "measure" && focus.name === measure.name;
                return (
                  <tr
                    key={key}
                    className={focused ? "hit" : ""}
                    onClick={() => setSelected(measure)}
                  >
                    <td>
                      {kpi ? (
                        <>
                          <b className={kpi.confidence === "low" ? "bizName weak" : "bizName"}>
                            {kpi.label}
                          </b>
                          <InfoDot text={kpiReason(kpi)} />
                        </>
                      ) : (
                        <span className="advisory">Not named in the report</span>
                      )}
                    </td>
                    <td>
                      <span className="techName">{measure.name}</span>
                    </td>
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
          {byPage.map((group) => {
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
                {() => (
                  <>
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
                  </>
                )}
              </Group>
            );
          })}

          {(() => {
            const shown = orphans.filter(matches);
            return shown.length > 0 ? (
              <Group title="Not on any page" count={shown.length}>
                {() =>
                  shown.map((measure) => (
                    <MeasureRow
                      key={`${measure.table}.${measure.name}`}
                      measure={measure}
                      {...rowProps}
                    />
                  ))
                }
              </Group>
            ) : null;
          })()}
        </>
      )}

      {mode === "By PBI Table" &&
        bySourceTable.map((group) => {
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
              {() =>
                shown.map((measure) => (
                  <MeasureRow
                    key={`${measure.table}.${measure.name}`}
                    measure={measure}
                    {...rowProps}
                  />
                ))
              }
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
  // Tells the shell to make room, so the list beside this stays readable.
  useDrawerPresence();
  const [editing, setEditing] = useState(false);
  const key = `${measure.table}[${measure.name}]`;
  const usage = analysis.usage.find("measure", measure.table, measure.name);
  const daxRefs = analysis.callers.get(measure.name) ?? [];
  const kpi = bestKpiName(analysis.kpis, measure.table, measure.name);
  const sources = analysis.sources.get(key);
  const rewrite = analysis.rewriteFor.get(key);

  return (
    <div className="drawer">
      <div className="drawerHead">
        <div>
          <small>MEASURE</small>
          <h2>
            {kpi ? kpi.label : measure.name}
            {kpi && <InfoDot text={kpiReason(kpi)} />}
          </h2>
          {kpi && <span className="techName">{measure.name}</span>}
        </div>
        <button onClick={close} aria-label="Close">
          ×
        </button>
      </div>

      <div className="drawerTabs">
        <button className={editing ? "" : "on"} onClick={() => setEditing(false)}>
          Overview
        </button>
        <button className={editing ? "on" : ""} onClick={() => setEditing(true)}>
          Edit measure
        </button>
      </div>

      <div className="drawerBody">
      {editing ? (
        <MeasureEditor
          model={model}
          measure={measure}
          onApply={onApply}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="measureTop">
            <SourceTags analysis={analysis} measure={measure} />
          </div>
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
      </div>

      <div className="drawerFoot">
        <button className="primarySmall" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}
