/**
 * The export screen.
 *
 * Deliberately one screen with one button. Everything the workbook needs is
 * already in memory from the upload, so there is nothing to configure and
 * nothing to re-parse — the counts shown here are the same numbers the rest of
 * the app is working from, which is also the point of showing them: a reader
 * can see what is about to be documented before committing to it.
 *
 * ExcelJS is around 900 KB and is only needed at the moment someone exports,
 * so it is fetched on the click rather than bundled into the first load.
 */
import { useMemo, useState } from "react";

import { buildDocument, type DocumentModel } from "../lib/export/document.ts";
import {
  buildWorkbook,
  documentationFileName,
  downloadWorkbook,
} from "../lib/export/workbook.ts";
import { allMeasures, type Model } from "../lib/powerbi/model.ts";
import { Head } from "./ui.tsx";

type Status =
  | { kind: "idle" }
  | { kind: "working"; step: string }
  | { kind: "done"; fileName: string; bytes: number }
  | { kind: "refused"; problems: string[] }
  | { kind: "failed"; error: string };

export function Export({ model }: { model: Model }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // The same analysis the workbook is built from, so the summary on screen and
  // the numbers in the file can never disagree.
  const doc: DocumentModel = useMemo(() => buildDocument(model), [model]);

  const tablesWithSql = doc.tables.filter((t) => t.sqlAvailable).length;
  const measureCount = allMeasures(model).length;

  const run = async () => {
    setStatus({ kind: "working", step: "Checking the extracted metadata" });

    // A documentation file gets emailed and filed; a quiet omission in one is
    // not noticed for months. Refuse rather than produce something wrong.
    if (!doc.validation.ok) {
      setStatus({
        kind: "refused",
        problems: doc.validation.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
      });
      return;
    }

    try {
      setStatus({ kind: "working", step: "Loading the spreadsheet writer" });
      const ExcelJS = await import("exceljs");

      setStatus({ kind: "working", step: "Building the workbook" });
      const bytes = await buildWorkbook(doc, ExcelJS);

      const fileName = documentationFileName(model.source.fileName);
      downloadWorkbook(bytes, fileName);
      setStatus({ kind: "done", fileName, bytes: bytes.byteLength });
    } catch (error) {
      setStatus({
        kind: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const stats: Array<[string, string]> = [
    ["Power BI file", model.source.fileName],
    ["Tables", String(model.tables.length)],
    ["Measures", String(measureCount)],
    ["Native SQL available", `${tablesWithSql} / ${model.tables.length}`],
    ["Report pages", String(model.pages.length)],
    [
      "Measures mapped to a table",
      `${measureCount - doc.multiTableMeasures.length - doc.unmappedMeasures.length} / ${measureCount}`,
    ],
  ];

  return (
    <article className="card checksWide">
      <Head over="EXPORT POWER BI DOCUMENTATION" title="Export to Excel" />

      <dl className="exportFacts">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <p className="scoreNote">
        Every measure is documented under the table its DAX actually reads, not the table it
        happens to be stored in. Where no single table dominates, the measure is listed under
        Multi-Table Measures with every table it references, rather than being filed under a guess.
        Source SQL is shown only where the file contains a statement; nothing is reconstructed from
        Power Query.
      </p>

      <div className="editActions">
        <button
          className="go"
          onClick={run}
          disabled={status.kind === "working" || !model.capabilities.model.available}
        >
          {status.kind === "working" ? `${status.step}…` : "Export Power BI Documentation to Excel"}
        </button>
        {status.kind === "done" && (
          <span className="spacer">
            {(status.bytes / 1024).toFixed(0)} KB written
          </span>
        )}
      </div>

      {!model.capabilities.model.available && (
        <div className="unavailable">
          <b>This file has no readable model to document</b>
          <p>
            A .pbix stores its model in a compressed Analysis Services part that cannot be opened
            in a browser, so there are no tables, measures or DAX to write out. Save the report as
            .pbit from Power BI Desktop and upload that instead.
          </p>
        </div>
      )}

      {status.kind === "done" && (
        <div className="preview" style={{ marginTop: 12 }}>
          <h4>Downloaded: {status.fileName}</h4>
          <p className="scoreNote" style={{ margin: 0 }}>
            Four sheets: Model Overview, Table &amp; Measure Docs, Measure Catalogue and Table
            Catalogue. The two catalogues link back to the matching section of the main sheet, and
            every sheet has filters and frozen headers.
          </p>
        </div>
      )}

      {status.kind === "refused" && (
        <div className="unavailable" style={{ marginTop: 12 }}>
          <b>Export refused — no file was produced</b>
          <p>
            The extracted metadata did not pass its own accuracy checks, so a workbook built from
            it would be misleading.
          </p>
          {status.problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </div>
      )}

      {status.kind === "failed" && (
        <div className="unavailable" style={{ marginTop: 12 }}>
          <b>The workbook could not be written</b>
          <p>{status.error}</p>
        </div>
      )}

      <h4 className="auditHeading">Checked before writing</h4>
      <ul className="auditList">
        {doc.validation.checks.map((check) => (
          <li key={check.name} className={check.ok ? "auditPass" : "auditFail"}>
            <span aria-hidden="true">{check.ok ? "✓" : "✕"}</span>
            <div>
              <b>{check.name}</b>
              <p>{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}
