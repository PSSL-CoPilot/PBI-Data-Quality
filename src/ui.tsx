/**
 * Presentation primitives shared by the QA and Optimization views.
 *
 * `ScoreBars` takes an already-computed list rather than a QaResult or an
 * OptimizationResult, so neither engine's shape leaks into the other's view.
 */
import { useState } from "react";

export function Head({
  over,
  title,
  action,
}: {
  over: string;
  title: string;
  action?: string;
}) {
  return (
    <div className="head">
      <div>
        <small>{over}</small>
        <h3>{title}</h3>
      </div>
      {action ? <button>{action}</button> : null}
    </div>
  );
}

/** A null score renders as "not assessed", never as zero or a full ring. */
export function ScoreRing({ score }: { score: number | null }) {
  return (
    <div
      className={score === null ? "ring none" : "ring"}
      style={{ "--pct": score ?? 0 } as React.CSSProperties}
    >
      <span>
        <b>{score ?? "—"}</b>
        <small>{score === null ? "not assessed" : "/ 100"}</small>
      </span>
    </div>
  );
}

export interface ScoreBar {
  label: string;
  score: number | null;
  /** Why the category could not be assessed, shown on hover. */
  reason?: string;
}

export function ScoreBars({ bars }: { bars: ScoreBar[] }) {
  return (
    <div className="bars">
      {bars.map((bar) => (
        <div key={bar.label} title={bar.reason ?? ""}>
          <span>{bar.label}</span>
          <b>
            {/* An unassessed bar is drawn full but greyed, so it cannot be
                mistaken for a zero score. */}
            <i
              className={bar.score === null ? "dim" : ""}
              style={{ width: `${bar.score ?? 100}%` }}
            />
          </b>
          <em>{bar.score ?? "—"}</em>
        </div>
      ))}
    </div>
  );
}

/**
 * A section that starts closed and animates open at 60fps.
 *
 * Two things make this cheap enough to run on every row of a long list.
 *
 * The children are not mounted until the section is opened, so a screen with
 * thirty collapsed queries costs thirty buttons rather than thirty CodeMirror
 * instances. That is the difference between a screen that appears and one that
 * hangs for a second first.
 *
 * Children may be passed as a function, and for anything expensive they should
 * be. JSX evaluates its children eagerly: writing `<Collapsible>{rows}</...>`
 * builds every row element before the component decides not to mount them, so
 * sixteen collapsed pages still cost the construction of every visual on all
 * sixteen. A thunk is not called until the section is actually open.
 *
 * The open animation runs on `transform` and `opacity` only. Animating `height`
 * would be the obvious way to do it and the wrong one: height is a layout
 * property, so every frame would re-run layout for the whole document and drop
 * below 60fps on exactly the long lists where it matters. `grid-template-rows`
 * cannot be transitioned reliably in Chrome either — it animates open and then
 * sticks on the way back. Transform and opacity are composited on the GPU and
 * touch neither layout nor paint.
 */
export function Collapsible({
  summary,
  children,
  className = "",
  defaultOpen = false,
  count,
}: {
  summary: React.ReactNode;
  /** Pass a function whenever building the children is not trivial. */
  children: React.ReactNode | (() => React.ReactNode);
  className?: string;
  /** Sections are closed unless a caller has a specific reason otherwise. */
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`collapsible ${open ? "isOpen" : ""} ${className}`.trim()}>
      <button
        className="collapsibleHead"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="caret" aria-hidden="true">
          ▶
        </span>
        <span className="collapsibleSummary">{summary}</span>
        {count !== undefined && <em>{count}</em>}
      </button>

      {/* Not built and not mounted while closed: an unopened section costs
          nothing beyond its own header. */}
      {open && (
        <div className="collapsibleBody">
          {typeof children === "function" ? children() : children}
        </div>
      )}
    </div>
  );
}
