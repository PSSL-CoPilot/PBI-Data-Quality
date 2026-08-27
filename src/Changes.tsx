/**
 * The change workspace: what has been edited this session, what it did to the
 * scores, and whether anything is now broken.
 *
 * The uploaded file is never touched. Everything here is a pending change over
 * the original, which is why undo and revert are always available and why the
 * before/after comparison is exact rather than remembered.
 */
import { useMemo, useState } from "react";

import { diffLines, summariseDiff } from "../lib/edit/diff.ts";
import {
  describeChange,
  regressions,
  type Change,
  type EditSession,
  type WorkingState,
} from "../lib/edit/session.ts";
import type { AuditCheck } from "../lib/export/audit.ts";
import { downloadBytes, exportUpdatedFile, type ExportResult } from "../lib/export/pbit.ts";
import type { RawSources } from "../lib/powerbi/extract.ts";
import type { Model } from "../lib/powerbi/model.ts";
import { runQa } from "../lib/qa/engine.ts";
import { runOptimization } from "../lib/optimize/engine.ts";
import { Head } from "./ui.tsx";

function Diff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  const summary = summariseDiff(lines);

  return (
    <>
      <div className="diff">
        <table>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={line.kind === "same" ? "" : line.kind}>
                <td className="gutter">{line.beforeLine ?? ""}</td>
                <td className="gutter">{line.afterLine ?? ""}</td>
                <td className="sign">
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
                </td>
                <td>{line.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="scoreNote">
        {summary.added} line(s) added, {summary.removed} removed, {summary.unchanged} unchanged.
      </p>
    </>
  );
}

function ScoreDelta({ label, before, after }: { label: string; before: number | null; after: number | null }) {
  const delta = before !== null && after !== null ? after - before : null;
  return (
    <div>
      <small>{label.toUpperCase()}</small>
      <b>
        {before ?? "—"} → {after ?? "—"}
      </b>
      {delta !== null && delta !== 0 && (
        <i className={delta > 0 ? "up" : "down"}>
          {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
        </i>
      )}
    </div>
  );
}

/** One line of the audit, pass or fail, with what was actually found. */
function CheckLine({ check }: { check: AuditCheck }) {
  return (
    <li className={check.ok ? "auditPass" : "auditFail"}>
      <span aria-hidden="true">{check.ok ? "✓" : "✕"}</span>
      <div>
        <b>{check.name}</b>
        <p>{check.detail}</p>
      </div>
    </li>
  );
}

/**
 * Checkout.
 *
 * Two gates, in order. The first runs before anything is written: every change
 * must have applied cleanly and the edited model must not have picked up a
 * broken reference. The second runs on the archive itself — it is repacked,
 * re-opened, and compared against the model the edits were supposed to produce.
 *
 * Failing either gate produces an explanation, not a file. There is no
 * "download anyway": a Power BI file that opens and quietly shows wrong numbers
 * does more damage than one that never arrives.
 */
function ExportPanel({
  session,
  working,
  raw,
}: {
  session: EditSession;
  working: WorkingState;
  raw: RawSources | null;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const exportable = Boolean(raw?.sourceBytes);
  const format = session.original.source.format === "pbip" ? "PBIP project" : "PBIT template";

  // Pre-flight: what can be known without writing anything.
  const broken = regressions(session, working.model);
  const preflight: AuditCheck[] = [
    {
      name: "Every change applied",
      ok: working.failed.length === 0,
      detail:
        working.failed.length === 0
          ? `All ${session.changes.length} change${session.changes.length === 1 ? "" : "s"} replayed cleanly over the original.`
          : `${working.failed.length} change${working.failed.length === 1 ? "" : "s"} could no longer be applied: ${working.failed
              .map((f) => f.error)
              .join("; ")}`,
    },
    {
      name: "No unresolved edit",
      ok: working.unresolved.length === 0,
      detail:
        working.unresolved.length === 0
          ? "No edit left something that needs checking by hand."
          : `${working.unresolved.length} edit${working.unresolved.length === 1 ? "" : "s"} need a manual check before this file is trustworthy.`,
    },
    {
      name: "References still valid",
      ok: broken.length === 0,
      detail:
        broken.length === 0
          ? "No edit introduced a reference to something that does not exist."
          : `${broken.length} broken reference${broken.length === 1 ? "" : "s"} introduced by these edits.`,
    },
  ];

  // An unresolved note is a warning, not a stop: the edit did apply.
  const blocked = preflight.some((c) => !c.ok && c.name !== "No unresolved edit");

  const run = async () => {
    if (!raw) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await exportUpdatedFile(
        raw,
        session.original,
        session.changes,
        working.model
      );
      setResult(outcome);
      // Only hand over a file that was re-opened and passed every check.
      if (outcome.ok && outcome.bytes && outcome.fileName) {
        downloadBytes(outcome.bytes, outcome.fileName);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card" style={{ marginTop: 14 }}>
      <Head over="EXPORT" title={`Download updated ${format}`} />

      {!exportable ? (
        <div className="unavailable">
          <b>This file cannot be exported</b>
          <p>
            Only files whose model could be read are exportable. A .pbix keeps its model in a
            binary Analysis Services part, so there is nothing to write changes into.
          </p>
        </div>
      ) : (
        <>
          <h4 className="auditHeading">Before writing</h4>
          <ul className="auditList">
            {preflight.map((check) => (
              <CheckLine key={check.name} check={check} />
            ))}
          </ul>

          <p className="scoreNote">
            The original archive is repacked with only the changed documents replaced, so
            everything this build does not parse is carried across untouched. The result is then
            re-opened and compared against the model these edits were meant to produce — tables,
            columns, measures, DAX, calculated objects, relationships, native SQL, report
            bindings, renames and their dependents. A single mismatch means no download.
          </p>

          <div className="editActions">
            <button
              className="go"
              onClick={run}
              disabled={busy || session.changes.length === 0 || blocked}
            >
              {busy ? "Writing and re-checking…" : "Validate and download"}
            </button>
            <span className="spacer">
              {blocked
                ? "Fix the failures above before exporting."
                : `${session.changes.length} change${session.changes.length === 1 ? "" : "s"} to write`}
            </span>
          </div>

          {result && !result.ok && (
            <div className="unavailable" style={{ marginTop: 12 }}>
              <b>Export refused — no file was produced</b>
              {result.problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}

          {result?.checks && (
            <>
              <h4 className="auditHeading">
                {result.ok ? "Verified in the exported file" : "What the exported file was checked for"}
              </h4>
              <ul className="auditList">
                {result.checks.map((check) => (
                  <CheckLine key={check.name} check={check} />
                ))}
              </ul>
            </>
          )}

          {result?.ok && result.verified && (
            <div className="preview" style={{ marginTop: 12 }}>
              <h4>Verified and downloaded: {result.fileName}</h4>
              <div className="usedIn">
                <div>
                  <b>{result.verified.tables}</b>
                  <small>tables</small>
                </div>
                <div>
                  <b>{result.verified.measures}</b>
                  <small>measures</small>
                </div>
                <div>
                  <b>{result.verified.pages}</b>
                  <small>report pages</small>
                </div>
                <div>
                  <b>{result.verified.renamedObjectsFound.length}</b>
                  <small>renames confirmed</small>
                </div>
              </div>
              <p className="scoreNote" style={{ margin: 0 }}>
                Every check above was run against the file that was just downloaded, not against
                what was intended. Open it in Power BI Desktop
                {session.original.source.format === "pbit"
                  ? " and save as .pbix from there."
                  : "."}
              </p>
            </div>
          )}
        </>
      )}
    </article>
  );
}

export function Changes({
  session,
  working,
  raw,
  onUndo,
  onRevert,
  onRevertAll,
}: {
  session: EditSession;
  working: WorkingState;
  raw: RawSources | null;
  onUndo: () => void;
  onRevert: (changeId: string) => void;
  onRevertAll: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  /*
   * These four are the most expensive things the app does, and they depend
   * only on the two models. Running them in the render body re-ran the whole
   * rule engine four times for every keystroke and every diff that was opened.
   * They must be memoised above the early return, because a hook cannot be
   * called conditionally.
   */
  const qaBefore = useMemo(() => runQa(session.original), [session.original]);
  const qaAfter = useMemo(() => runQa(working.model), [working.model]);
  const optBefore = useMemo(() => runOptimization(session.original), [session.original]);
  const optAfter = useMemo(() => runOptimization(working.model), [working.model]);
  const broken = useMemo(
    () => regressions(session, working.model),
    [session, working.model]
  );

  if (session.changes.length === 0) {
    return (
      <article className="card placeholder">
        <span>⎋</span>
        <h2>No pending changes</h2>
        <p>
          Edit a measure, table or column and it will appear here. The uploaded file is never
          modified: changes are kept separately and replayed over the original.
        </p>
      </article>
    );
  }

  const notesFor = (change: Change) =>
    working.unresolved.find((u) => u.changeId === change.id)?.notes ?? [];
  const failureFor = (change: Change) =>
    working.failed.find((f) => f.changeId === change.id)?.error;

  return (
    <>
      <article className="card">
        <Head
          over="PENDING CHANGES"
          title={`${session.changes.length} change${session.changes.length === 1 ? "" : "s"} in this session`}
        />

        <div className="delta">
          <ScoreDelta label="Quality score" before={qaBefore.overall} after={qaAfter.overall} />
          <ScoreDelta
            label="Optimization score"
            before={optBefore.overall}
            after={optAfter.overall}
          />
          <div>
            <small>REFERENCES</small>
            <b>{broken.length === 0 ? "Valid" : `${broken.length} broken`}</b>
          </div>
        </div>

        {broken.length > 0 && (
          <div className="unavailable" style={{ marginTop: 12 }}>
            <b>These edits introduced broken references</b>
            {broken.map((problem) => (
              <p key={problem.id}>
                {problem.target.table
                  ? `${problem.target.table}[${problem.target.name}]`
                  : problem.target.name}
                : {problem.detail}
              </p>
            ))}
          </div>
        )}

        <div className="changeList">
          {session.changes.map((change) => {
            const notes = notesFor(change);
            const failure = failureFor(change);
            const isOpen = open === change.id;

            return (
              <div key={change.id}>
                <div className="changeItem">
                  <div>
                    <b>{describeChange(change)}</b>
                    <p>
                      <code>{change.before || "(empty)"}</code> →{" "}
                      <code>{change.after || "(empty)"}</code>
                    </p>
                    {failure && <p style={{ color: "#a9564a" }}>Could not apply: {failure}</p>}
                    {notes.map((note) => (
                      <p key={note} style={{ color: "#a97037" }}>
                        Needs a manual check: {note}
                      </p>
                    ))}
                  </div>
                  <div className="ops">
                    <button onClick={() => setOpen(isOpen ? null : change.id)}>
                      {isOpen ? "Hide" : "View change"}
                    </button>
                    <button className="danger" onClick={() => onRevert(change.id)}>
                      Revert
                    </button>
                  </div>
                </div>
                {isOpen && <Diff before={change.before} after={change.after} />}
              </div>
            );
          })}
        </div>

        <div className="editActions">
          <button onClick={onUndo}>Undo last change</button>
          <button className="danger" onClick={onRevertAll}>
            Revert all
          </button>
          <span className="spacer">
            The original {session.original.source.fileName} is kept untouched.
          </span>
        </div>
      </article>

      <ExportPanel session={session} working={working} raw={raw} />
    </>
  );
}

export function changeCount(session: EditSession | null): number {
  return session ? session.changes.length : 0;
}

export type { Model };
