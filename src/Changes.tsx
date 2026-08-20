/**
 * The change workspace: what has been edited this session, what it did to the
 * scores, and whether anything is now broken.
 *
 * The uploaded file is never touched. Everything here is a pending change over
 * the original, which is why undo and revert are always available and why the
 * before/after comparison is exact rather than remembered.
 */
import { useState } from "react";

import { diffLines, summariseDiff } from "../lib/edit/diff.ts";
import {
  describeChange,
  regressions,
  type Change,
  type EditSession,
  type WorkingState,
} from "../lib/edit/session.ts";
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

function ExportPanel({
  session,
  raw,
}: {
  session: EditSession;
  raw: RawSources | null;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const exportable = Boolean(raw?.sourceBytes);
  const format = session.original.source.format === "pbip" ? "PBIP project" : "PBIT template";

  const run = async () => {
    if (!raw) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await exportUpdatedFile(raw, session.original, session.changes);
      setResult(outcome);
      // Only hand over a file that was re-opened and verified.
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
          <p className="scoreNote">
            The original archive is repacked with only the changed documents replaced, so
            everything this build does not parse is carried across untouched. The result is then
            re-opened and re-validated before it is offered; if that check fails you get the
            reason instead of a file.
          </p>

          <div className="editActions">
            <button className="go" onClick={run} disabled={busy || session.changes.length === 0}>
              {busy ? "Validating…" : `Validate and download`}
            </button>
            <span className="spacer">
              {session.changes.length} change{session.changes.length === 1 ? "" : "s"} to write
            </span>
          </div>

          {result && !result.ok && (
            <div className="unavailable" style={{ marginTop: 12 }}>
              <b>Export refused — the file was not produced</b>
              {result.problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
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
                The exported file was re-opened and checked: every renamed object is present and
                no new broken references were introduced. Open it in Power BI Desktop
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

  const broken = regressions(session, working.model);
  const qaBefore = runQa(session.original);
  const qaAfter = runQa(working.model);
  const optBefore = runOptimization(session.original);
  const optAfter = runOptimization(working.model);

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

      <ExportPanel session={session} raw={raw} />
    </>
  );
}

export function changeCount(session: EditSession | null): number {
  return session ? session.changes.length : 0;
}

export type { Model };
