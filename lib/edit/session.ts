/**
 * The change workspace.
 *
 * The extracted model is kept untouched and the working model is *derived* by
 * replaying the change list over it. Undo and revert are therefore just list
 * operations: there are no inverse edits to get wrong, and reverting a change
 * from the middle of the list cannot leave the model in a state no sequence of
 * edits could have produced.
 *
 * Replaying is cheap because models are small (tens of KB), so correctness wins
 * over incremental application here.
 */
import type { Model } from "../powerbi/model.ts";
import { runQa, type Finding } from "../qa/engine.ts";
import { ALL_RULES } from "../qa/rules.ts";
import { applyChange, type Change } from "./apply.ts";

export type { Change, EditTarget, EditableField, DependencyPreview } from "./apply.ts";
export { previewRename } from "./apply.ts";

export interface EditSession {
  /** Exactly as extracted. Never modified. */
  original: Model;
  changes: Change[];
}

export interface WorkingState {
  model: Model;
  /** Warnings raised while replaying, keyed by change id. */
  unresolved: Array<{ changeId: string; notes: string[] }>;
  /** Changes that could no longer be applied, with the reason. */
  failed: Array<{ changeId: string; error: string }>;
}

export const newSession = (original: Model): EditSession => ({ original, changes: [] });

/** Replay every change over the original to produce the current model. */
export function workingModel(session: EditSession): WorkingState {
  let model = session.original;
  const unresolved: WorkingState["unresolved"] = [];
  const failed: WorkingState["failed"] = [];

  for (const change of session.changes) {
    const result = applyChange(model, change);
    if (result.error) {
      failed.push({ changeId: change.id, error: result.error });
      continue;
    }
    model = result.model;
    if (result.unresolved.length) {
      unresolved.push({ changeId: change.id, notes: result.unresolved });
    }
  }

  return { model, unresolved, failed };
}

export const addChange = (session: EditSession, change: Change): EditSession => ({
  ...session,
  changes: [...session.changes, change],
});

export const undoLast = (session: EditSession): EditSession => ({
  ...session,
  changes: session.changes.slice(0, -1),
});

export const revertChange = (session: EditSession, changeId: string): EditSession => ({
  ...session,
  changes: session.changes.filter((c) => c.id !== changeId),
});

export const revertAll = (session: EditSession): EditSession => ({
  ...session,
  changes: [],
});

export const hasChanges = (session: EditSession): boolean => session.changes.length > 0;

/**
 * Reference integrity of the working model.
 *
 * Reuses the QA rules that already detect dangling references rather than
 * defining a second, potentially divergent, set of checks.
 */
const INTEGRITY_RULE_IDS = [
  "REP-BROKEN-FIELD",
  "DQ-MEASURE-MISSING-DEPENDENCY",
  "DQ-RELATIONSHIP-TYPE-MISMATCH",
];

export interface ValidationResult {
  ok: boolean;
  problems: Finding[];
}

export function validateReferences(model: Model): ValidationResult {
  const rules = ALL_RULES.filter((rule) => INTEGRITY_RULE_IDS.includes(rule.id));
  const problems = runQa(model, rules).findings;
  return { ok: problems.length === 0, problems };
}

/**
 * Problems the edits introduced: present in the working model but not in the
 * original. Pre-existing issues are not the edit's fault and are excluded, so
 * "this change broke something" means exactly that.
 */
export function regressions(session: EditSession, working: Model): Finding[] {
  const before = new Set(validateReferences(session.original).problems.map((p) => p.id));
  return validateReferences(working).problems.filter((p) => !before.has(p.id));
}

/** A short human label for the pending-changes list. */
export function describeChange(change: Change): string {
  const object =
    change.target.table && change.target.type !== "table"
      ? `${change.target.table}[${change.target.name}]`
      : change.target.name;

  switch (change.field) {
    case "name":
      return `${capitalise(change.target.type)} renamed`;
    case "expression":
      return change.target.type === "partition" ? "Query modified" : "DAX modified";
    case "description":
      return "Description changed";
    case "formatString":
      return "Format changed";
    case "homeTable":
      return "Home table changed";
    default:
      return `${capitalise(change.target.type)} ${object} changed`;
  }
}

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
