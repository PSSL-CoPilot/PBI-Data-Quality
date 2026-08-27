/**
 * What a reviewer has decided about each finding.
 *
 * A QA run is a machine opinion. Triage is the human one laid over it: this is
 * real and I will fix it, this is real but it is how we want it, this is done.
 * The two are kept apart so that re-running the rules never overwrites a
 * decision, and so that nothing here can change a score — the score describes
 * the file, not how the reviewer feels about it.
 *
 * State lives for the session only. Persisting it would mean deciding what a
 * decision is attached to when the file changes underneath it, and a wrong
 * answer there silently hides a real problem.
 */
import type { Finding, QaResult } from "./engine.ts";
import { SEVERITY_ORDER } from "./engine.ts";
import type { Severity } from "./rules.ts";

export type TriageState = "open" | "flagged" | "resolved" | "ignored";

export const TRIAGE_LABEL: Record<TriageState, string> = {
  open: "Open",
  flagged: "Flagged",
  resolved: "Resolved",
  ignored: "Accepted design",
};

export type Triage = Record<string, TriageState>;

export const stateOf = (triage: Triage, finding: Finding): TriageState =>
  triage[finding.id] ?? "open";

/** A finding still asking for a decision. */
export const isOutstanding = (state: TriageState) => state === "open" || state === "flagged";

export function setState(triage: Triage, id: string, state: TriageState): Triage {
  const next = { ...triage };
  if (state === "open") delete next[id];
  else next[id] = state;
  return next;
}

export interface InboxCounts {
  /** Outstanding findings per severity — what the reviewer still owes. */
  bySeverity: Record<Severity, number>;
  outstanding: number;
  flagged: number;
  resolved: number;
  ignored: number;
}

export function countInbox(qa: QaResult, triage: Triage): InboxCounts {
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<
    Severity,
    number
  >;
  let flagged = 0;
  let resolved = 0;
  let ignored = 0;

  for (const finding of qa.findings) {
    const state = stateOf(triage, finding);
    if (state === "flagged") flagged++;
    if (state === "resolved") resolved++;
    if (state === "ignored") ignored++;
    if (isOutstanding(state)) bySeverity[finding.severity]++;
  }

  return {
    bySeverity,
    outstanding: SEVERITY_ORDER.reduce((sum, s) => sum + bySeverity[s], 0),
    flagged,
    resolved,
    ignored,
  };
}

/**
 * Findings grouped into the four severity buckets, worst first.
 *
 * Empty buckets are kept so the inbox always shows the same four headings and
 * a reviewer can see that nothing critical was found, rather than inferring it
 * from an absence.
 */
export function groupBySeverity(findings: Finding[]): Array<{
  severity: Severity;
  findings: Finding[];
}> {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((f) => f.severity === severity),
  }));
}
