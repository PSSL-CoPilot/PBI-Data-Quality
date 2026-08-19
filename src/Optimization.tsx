/**
 * Optimization view: score, opportunities, Current DAX -> Suggested DAX, and
 * page complexity.
 *
 * The honesty rules from the engine are surfaced here rather than hidden:
 * every rewrite is labelled "not benchmarked", unassessed categories show a
 * dash instead of a number, and performance is presented as a section that was
 * not measured rather than as a score.
 */
import { useState } from "react";

import {
  IMPACT_ORDER,
  optimizationLabel,
  type Impact,
  type OptCategory,
  type OptimizationResult,
  type Opportunity,
} from "../lib/optimize/engine.ts";
import type { FindingTarget } from "../lib/qa/engine.ts";
import { Head, ScoreBars, ScoreRing } from "./ui.tsx";

/** Impact reuses the severity badge modifiers so the two views read alike. */
const IMPACT_CLASS: Record<Impact, string> = { high: "s1", medium: "s2", low: "s3" };

const label = (target: Opportunity["target"]) =>
  target.table ? `${target.table}[${target.name}]` : target.name;

function RewritePanel({ opportunity }: { opportunity: Opportunity }) {
  const rewrite = opportunity.rewrite;
  if (!rewrite) return null;

  return (
    <div className="rewrite">
      <div className="rewriteHead">
        <b>{label(opportunity.target)}</b>
        <span className="badge">confidence: {rewrite.confidence}</span>
        <span className="badge flat">impact: {opportunity.impact}</span>
        <span className="badge warn">not benchmarked</span>
      </div>

      <div className="rewriteGrid">
        <div>
          <span className="codeLabel">CURRENT DAX</span>
          <pre>{rewrite.original}</pre>
        </div>
        <div className="after">
          <span className="codeLabel">SUGGESTED DAX</span>
          <pre>{rewrite.suggested}</pre>
        </div>
      </div>

      <p className="rewriteNote">
        <b>Reason.</b> {rewrite.reason}
      </p>
      <p className="rewriteNote">
        <b>Recommendation.</b> {rewrite.recommendation}
      </p>
      <p className="rewriteNote">
        <b>Impact.</b> {rewrite.impact} Nothing was executed or timed, so this is not a claim
        that the result runs faster.
      </p>
      {rewrite.behaviourChange && (
        <p className="rewriteNote">
          <b>Behaviour change.</b> {rewrite.behaviourChange}
        </p>
      )}
    </div>
  );
}

function OpportunityRow({
  opportunity,
  goTo,
}: {
  opportunity: Opportunity;
  goTo: (target: FindingTarget) => void;
}) {
  const open = () => goTo(opportunity.target);
  return (
    <div
      className="finding findingRow"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <i className={`sev ${IMPACT_CLASS[opportunity.impact]}`}>{opportunity.impact}</i>
      <div>
        <b>{label(opportunity.target)}</b>
        <p>{opportunity.detail}</p>
        <small>
          {opportunity.category} · {opportunity.ruleId} · {opportunity.recommendation}
        </small>
      </div>
      <span aria-hidden="true">›</span>
    </div>
  );
}

export function Optimization({
  opt,
  goTo,
}: {
  opt: OptimizationResult;
  goTo: (target: FindingTarget) => void;
}) {
  const [category, setCategory] = useState<OptCategory | "All">("All");
  const shown = opt.opportunities.filter((o) => category === "All" || o.category === category);
  const plural = opt.opportunities.length === 1 ? "y" : "ies";

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
            <i>{optimizationLabel(opt.overall)}</i>
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
            <b>{opt.rewrites.length}</b>
            <small>with a rewrite</small>
          </div>
        </div>

        <p className="scoreNote">
          Each opportunity deducts from its category: high 8, medium 3, low 1, floored at zero.
        </p>
      </article>

      {opt.rewrites.length > 0 && (
        <article className="card checksWide">
          <Head
            over="CURRENT DAX → SUGGESTED DAX"
            title={`${opt.rewrites.length} rewrite${opt.rewrites.length === 1 ? "" : "s"} available`}
          />
          <p className="scoreNote">
            Only rewrites that could be generated mechanically and then validated appear here.
            Everything else stays advice without generated code, because a plausible rewrite that
            quietly changes results is worse than no rewrite.
          </p>
          {opt.rewrites.map((o) => (
            <RewritePanel key={o.id} opportunity={o} />
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
          shown.map((o) => <OpportunityRow key={o.id} opportunity={o} goTo={goTo} />)
        )}
      </article>

      {opt.pages.length > 0 && (
        <article className="card checksWide">
          <Head over="PAGE COMPLEXITY" title="Structural cost per page" />
          <table className="complexity">
            <thead>
              <tr>
                {["Page", "Score", "Band", "Visuals", "Slicers", "Fields", "Large grids"].map((h) => (
                  <th key={h}>{h}</th>
                ))}
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
