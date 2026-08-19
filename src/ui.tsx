/**
 * Presentation primitives shared by the QA and Optimization views.
 *
 * `ScoreBars` takes an already-computed list rather than a QaResult or an
 * OptimizationResult, so neither engine's shape leaks into the other's view.
 */

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
