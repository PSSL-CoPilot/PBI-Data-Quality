/**
 * Producing an updated Power BI file.
 *
 * The archive is repacked from the *original* bytes: every part is carried
 * across untouched and only the two documents that changed are replaced. Parts
 * this build never parses — DiagramLayout, Settings, SecurityBindings, static
 * resources — therefore survive exactly as they were.
 *
 * The result is then re-opened and re-validated before it is handed back. If
 * the round trip does not produce the expected model, or introduces a broken
 * reference, the export reports that instead of offering a download. "It
 * probably worked" is not a state this module can return.
 */
import type { Change } from "../edit/apply.ts";
import { validateReferences } from "../edit/session.ts";
import { extract, type RawSources } from "../powerbi/extract.ts";
import { allMeasures, type Model } from "../powerbi/model.ts";
import { encodeUtf16, encodeUtf8, readZip, writeZip } from "../powerbi/zip.ts";
import { applyChangeToLayout, applyChangeToTmsl } from "./writer.ts";

export interface ExportResult {
  ok: boolean;
  /** The repacked archive, only when `ok`. */
  bytes?: Uint8Array;
  fileName?: string;
  /** Why the export could not be produced or could not be trusted. */
  problems: string[];
  /** What the verification pass confirmed, for display. */
  verified?: {
    tables: number;
    measures: number;
    pages: number;
    renamedObjectsFound: string[];
  };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function encodePart(
  value: unknown,
  encoding: "utf-16le" | "utf-8",
  withBom: boolean
): Uint8Array {
  const text = JSON.stringify(value);
  return encoding === "utf-16le"
    ? encodeUtf16(text, withBom)
    : encodeUtf8(withBom ? "﻿" + text : text);
}

/** Rename the file so an export never overwrites the user's original. */
export function exportFileName(original: string): string {
  const dot = original.lastIndexOf(".");
  const stem = dot === -1 ? original : original.slice(0, dot);
  const extension = dot === -1 ? ".pbit" : original.slice(dot);
  return `${stem} (edited)${extension}`;
}

/**
 * Objects the change list says should exist afterwards, used to confirm the
 * exported file really contains the edits rather than assuming it does.
 */
function expectedRenames(changes: Change[]): Array<{ type: string; name: string }> {
  return changes
    .filter((c) => c.field === "name")
    .map((c) => ({ type: c.target.type, name: c.after }));
}

export async function exportUpdatedFile(
  raw: RawSources,
  original: Model,
  changes: Change[]
): Promise<ExportResult> {
  const problems: string[] = [];

  if (!raw.sourceBytes) {
    return {
      ok: false,
      problems: [
        "The original archive is not available, so there is nothing to repack. Export is only possible for files whose model could be read (.pbit or .pbip).",
      ],
    };
  }
  if (changes.length === 0) {
    return { ok: false, problems: ["There are no changes to export."] };
  }

  // Start from every original part, not just the parsed ones.
  const parts = readZip(raw.sourceBytes);

  if (raw.modelSchemaPath && raw.modelSchema) {
    const document = clone(raw.modelSchema) as Record<string, unknown>;
    for (const change of changes) applyChangeToTmsl(document, change);
    parts[raw.modelSchemaPath] = encodePart(
      document,
      raw.modelSchemaEncoding,
      raw.modelSchemaBom
    );
  } else {
    problems.push("No model document was captured at upload, so model edits cannot be written.");
  }

  if (raw.layoutPath && raw.layout) {
    let document: unknown = clone(raw.layout);
    for (const change of changes) document = applyChangeToLayout(document, change);
    parts[raw.layoutPath] = encodePart(document, raw.layoutEncoding, raw.layoutBom);
  } else if (original.pages.length > 0) {
    problems.push("No report document was captured, so report bindings cannot be updated.");
  }

  if (problems.length > 0) return { ok: false, problems };

  let bytes: Uint8Array;
  try {
    bytes = writeZip(parts);
  } catch (error) {
    return {
      ok: false,
      problems: [
        `The archive could not be repacked: ${error instanceof Error ? error.message : "unknown error"}`,
      ],
    };
  }

  // Re-open what was just produced and check it, rather than trusting it.
  const fileName = exportFileName(original.source.fileName);
  let reopened: Model;
  try {
    reopened = (await extract(fileName, bytes)).model;
  } catch (error) {
    return {
      ok: false,
      problems: [
        `The exported file could not be re-opened, so it is not safe to use: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      ],
    };
  }

  if (!reopened.capabilities.model.available) {
    return {
      ok: false,
      problems: ["The exported file no longer exposes a readable model."],
    };
  }

  const measureNames = new Set(allMeasures(reopened).map((m) => m.name));
  const tableNames = new Set(reopened.tables.map((t) => t.name));
  const columnNames = new Set(
    reopened.tables.flatMap((t) => t.columns.map((c) => c.name))
  );

  const found: string[] = [];
  for (const expected of expectedRenames(changes)) {
    const present =
      expected.type === "measure"
        ? measureNames.has(expected.name)
        : expected.type === "table"
          ? tableNames.has(expected.name)
          : columnNames.has(expected.name);
    if (present) found.push(expected.name);
    else problems.push(`"${expected.name}" is missing from the exported file.`);
  }

  // A pre-existing problem is not this export's fault; a new one is.
  const before = new Set(validateReferences(original).problems.map((p) => p.id));
  const introduced = validateReferences(reopened).problems.filter((p) => !before.has(p.id));
  for (const problem of introduced) {
    problems.push(
      `The exported file has a broken reference: ${
        problem.target.table ? `${problem.target.table}[${problem.target.name}]` : problem.target.name
      } — ${problem.detail}`
    );
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    bytes,
    fileName,
    problems: [],
    verified: {
      tables: reopened.tables.length,
      measures: allMeasures(reopened).length,
      pages: reopened.pages.length,
      renamedObjectsFound: found,
    },
  };
}

/** Hand the repacked archive to the browser as a download. */
export function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
