/**
 * Optimization view: score, opportunities, Current DAX -> Suggested DAX, and
 * page complexity.
 *
 * The honesty rules from the engine are surfaced rather than hidden: every
 * rewrite is labelled "not benchmarked", unassessed categories show a dash
 * instead of a number, and performance is presented as a section that was not
 * measured rather than as a score.
 *
 * Only opportunities carrying a validated rewrite can be applied. Advisory
 * findings have no Optimize button at all, so there is no path by which an
 * uncertain suggestion is written into the model by a stray click.
 */
import { useMemo, useState } from "react";

import {
  DIALECT_LABEL,
  IMPACT_ORDER,
  optimizationLabel,
  rewriteAsChange,
  safeRewrites,
  type Impact,
  type OptCategory,
  type OptimizationResult,
  type Opportunity,
} from "../lib/optimize/engine.ts";
import type { Change } from "../lib/edit/session.ts";
import type { Model } from "../lib/powerbi/model.ts";
import type { FindingTarget } from "../lib/qa/engine.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { Head, ScoreBars, ScoreRing } from "./ui.tsx";

/** Impact reuses the severity badge modifiers so the two views read alike. */
const IMPACT_CLASS: Record<Impact, string> = { high: "s1", medium: "s2", low: "s3" };

const label = (target: Opportunity["target"]) =>
  target.table ? `${target.table}[${target.name}]` : target.name;

let counter = 0;
const nextId = () => `opt-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

function RewritePanel({
  opportunity,
  selected,
  onToggle,
  onOptimize,
}: {
  opportunity: Opportunity;
  selected: boolean;
  onToggle: () => void;
  onOptimize: (opportunity: Opportunity) => void;
}) {
  const sql = opportunity.sql;
  const rewrite = opportunity.rewrite;
  if (!rewrite && !sql?.rewrite) return null;

  const language = sql ? "sql" : "dax";
  const before = sql ? sql.statement : rewrite!.original;
  const after = sql ? sql.rewrite!.suggested : rewrite!.suggested;
  const confidence = sql ? sql.rewrite!.confidence : rewrite!.confidence;
  const behaviour = sql ? sql.rewrite!.behaviourChange : rewrite!.behaviourChange;

  return (
    <div className="rewrite">
      <div className="rewriteHead">
        <label className="pick">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          <b>{label(opportunity.target)}</b>
        </label>
        <span className="badge">confidence: {confidence}</span>
        <span className="badge flat">impact: {opportunity.impact}</span>
        {sql && <span className="badge flat">{DIALECT_LABEL[sql.dialect]}</span>}
        <span className="badge warn">not benchmarked</span>
        <button className="applyOne" onClick={() => onOptimize(opportunity)}>
          ⚡ Optimize
        </button>
      </div>

      <div className="rewriteGrid">
        <div>
          <span className="codeLabel">CURRENT {language.toUpperCase()}</span>
          <CodeEditor value={before} language={language} readOnly minHeight={120} label="Current" />
        </div>
        <div className="after">
          <span className="codeLabel">SUGGESTED {language.toUpperCase()}</span>
          <CodeEditor value={after} language={language} readOnly minHeight={120} label="Suggested" />
        </div>
      </div>

      <p className="rewriteNote">
        <b>Problem.</b> {opportunity.detail}
      </p>
      <p className="rewriteNote">
        <b>Why it matters.</b> {sql ? sql.why : rewrite!.reason}
      </p>
      <p className="rewriteNote">
        <b>Recommendation.</b> {sql ? opportunity.recommendation : rewrite!.recommendation}
      </p>
      {behaviour && (
        <p className="rewriteNote">
          <b>Behaviour change.</b> {behaviour}
        </p>
      )}
      <p className="rewriteNote">
        {sql ? (
          <>
            <b>Source.</b>{" "}
            <a href={sql.source.url} target="_blank" rel="noreferrer">
              {sql.source.title}
            </a>
          </>
        ) : (
          <>
            <b>Impact.</b> {rewrite!.impact}
          </>
        )}{" "}
        Nothing was executed or timed, so this is not a claim that the result runs faster.
      </p>
    </div>
  );
}

function OpportunityRow({
  opportunity,
  goTo,
  onOptimize,
}: {
  opportunity: Opportunity;
  goTo: (target: FindingTarget) => void;
  onOptimize: (opportunity: Opportunity) => void;
}) {
  return (
    <div className="finding">
      <i className={`sev ${IMPACT_CLASS[opportunity.impact]}`}>{opportunity.impact}</i>
      <div>
        <b>{label(opportunity.target)}</b>
        <p>{opportunity.detail}</p>
        <small>
          {opportunity.category} · {opportunity.ruleId} · {opportunity.recommendation}
        </small>
        <div className="measureActions">
          <button onClick={() => goTo(opportunity.target)}>Open object</button>
          {/* A SQL finding carries its rewrite under `sql`, not `rewrite`. */}
          {opportunity.rewrite ?? opportunity.sql?.rewrite ? (
            <button className="go" onClick={() => onOptimize(opportunity)}>
              ⚡ Optimize
            </button>
          ) : (
            <span className="advisory">Advisory — no safe automatic rewrite</span>
          )}
          {opportunity.sql && (
            <a className="srcLink" href={opportunity.sql.source.url} target="_blank" rel="noreferrer">
              {opportunity.sql.source.title}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function Optimization({
  opt,
  model,
  goTo,
  onApply,
}: {
  opt: OptimizationResult;
  model: Model;
  goTo: (target: FindingTarget) => void;
  onApply: (changes: Change[]) => void;
}) {
  const [category, setCategory] = useState<OptCategory | "All">("All");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");

  const safe = useMemo(() => safeRewrites(opt), [opt]);
  const shown = opt.opportunities.filter((o) => category === "All" || o.category === category);
  const plural = opt.opportunities.length === 1 ? "y" : "ies";

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyMany = (items: Opportunity[]) => {
    const at = Date.now();
    const changes = items
      .map((item) => rewriteAsChange(item, nextId(), at, model))
      .filter((c): c is Change => Boolean(c));

    const skipped = items.length - changes.length;
    if (changes.length === 0) {
      setNote("Nothing was applied: none of the selected items has a safe rewrite.");
      return;
    }

    onApply(changes);
    setPicked(new Set());
    setNote(
      `Applied ${changes.length} rewrite${changes.length === 1 ? "" : "s"}${
        skipped > 0 ? `, skipped ${skipped} without a safe rewrite` : ""
      }. Each is listed in Changes, validated there, and can be undone.`
    );
  };

  const selectedItems = safe.filter((o) => picked.has(o.id));

  return (
    <div className="checks">
      <article className="card ruleSummary">
        <Head
          over="OPTIMIZATION"
          title={`${opt.rulesRun} rules evaluated · ${opt.opportunities.length} opportunit${plural}`}
        />
        <div className="qualityTop">
          <ScoreRing score={opt.overall} />
          <div>
            <i>
              {optimizationLabel(opt.overall)}
              {opt.skipped.length > 0 && " · partial"}
            </i>
            <h3>Optimization score</h3>
            <p>
              Structural only. Nothing is executed against the model, so no timing or size
              evidence exists and none is implied.
            </p>
          </div>
        </div>

        <ScoreBars
          bars={opt.categories.map((c) => ({
            label: c.category,
            score: c.score,
            reason: c.reason,
          }))}
        />

        <div className="counts">
          {IMPACT_ORDER.map((level) => (
            <div key={level}>
              <b>{opt.counts[level]}</b>
              <small>{level} impact</small>
            </div>
          ))}
          <div>
            <b>{safe.length}</b>
            <small>safe to apply</small>
          </div>
        </div>

        <p className="scoreNote">
          Each score is the share of that category&rsquo;s objects with nothing to improve, weighted
          by impact: high counts as 0.6 of an object, medium 0.3, low 0.1.
        </p>
      </article>

      {safe.length > 0 && (
        <article className="card checksWide">
          <Head
            over="CURRENT DAX → SUGGESTED DAX"
            title={`${safe.length} rewrite${safe.length === 1 ? "" : "s"} available`}
          />
          <p className="scoreNote">
            Only rewrites that could be generated mechanically and then validated appear here.
            Applying one edits the working model and lands in Changes, where it is validated and
            can be undone. Advisory findings appear further down without an Optimize button,
            because they have no safe automatic rewrite.
          </p>

          <div className="bulkBar">
            <button
              onClick={() =>
                setPicked(picked.size === safe.length ? new Set() : new Set(safe.map((o) => o.id)))
              }
            >
              {picked.size === safe.length ? "Clear selection" : "Select all safe optimizations"}
            </button>
            <button
              className="go"
              disabled={selectedItems.length === 0}
              onClick={() => applyMany(selectedItems)}
            >
              ⚡ Optimize selected ({selectedItems.length})
            </button>
            <span className="spacer">
              {picked.size} of {safe.length} selected
            </span>
          </div>

          {note && <div className="bulkNote">{note}</div>}

          {safe.map((o) => (
            <RewritePanel
              key={o.id}
              opportunity={o}
              selected={picked.has(o.id)}
              onToggle={() => toggle(o.id)}
              onOptimize={(item) => applyMany([item])}
            />
          ))}
        </article>
      )}

      <article className="card explorer checksWide">
        <div className="toolbar">
          <div className="filter">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as OptCategory | "All")}
            >
              <option value="All">All categories</option>
              {opt.categories.map((c) => (
                <option key={c.category} value={c.category}>
                  {c.category}
                </option>
              ))}
            </select>
          </div>
          <button>
            {shown.length} of {opt.opportunities.length}
          </button>
        </div>
        {shown.length === 0 ? (
          <p>No opportunities in this category.</p>
        ) : (
          shown.map((o) => (
            <OpportunityRow
              key={o.id}
              opportunity={o}
              goTo={goTo}
              onOptimize={(item) => applyMany([item])}
            />
          ))
        )}
      </article>

      {opt.pages.length > 0 && (
        <article className="card checksWide">
          <Head over="PAGE COMPLEXITY" title="Structural cost per page" />
          <div className="tableScroll">
            <table className="complexity">
              <thead>
                <tr>
                  {["Page", "Score", "Band", "Visuals", "Slicers", "Fields", "Large grids"].map(
                    (h) => (
                      <th key={h}>{h}</th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {opt.pages.map((p) => (
                  <tr key={p.page}>
                    <td>
                      <b>{p.displayName}</b>
                      {p.isHidden ? " · hidden" : ""}
                    </td>
                    <td style={{ width: 110 }}>
                      <div className="meter">
                        <i className={p.score >= 60 ? "hot" : ""} style={{ width: `${p.score}%` }} />
                      </div>
                      {p.score}/100
                    </td>
                    <td>{p.band}</td>
                    <td>{p.visuals}</td>
                    <td>{p.slicers}</td>
                    <td>{p.distinctFields}</td>
                    <td>{p.largeGrids}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="scoreNote">
            Higher means more complex. The score is the sum of its parts: visuals ×2, slicers ×4,
            large tables ×6, distinct fields ×1, repeated complex measures ×3. It measures
            structure, not measured load time.
          </p>
        </article>
      )}

      {opt.skipped.length > 0 && (
        <article className="card checksWide">
          <Head over="NOT RUN" title={`${opt.skipped.length} rules skipped`} />
          <div className="unavailable">
            <b>These rules could not run on this file</b>
            <p>{opt.skipped[0].reason}</p>
          </div>
          <ul className="notAssessed">
            {opt.skipped.map((rule) => (
              <li key={rule.ruleId}>
                {rule.category} · {rule.ruleId} — {rule.title}
              </li>
            ))}
          </ul>
        </article>
      )}

      <article className="card checksWide">
        <Head over="PERFORMANCE HOTSPOTS" title="Not assessed" />
        <ul className="notAssessed">
          {opt.performanceNotAssessed.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="scoreNote">
          Performance hotspots need a live engine and runtime traces. This build never executes
          the model, so none of the above is measured, estimated or scored.
        </p>
      </article>
    </div>
  );
}
