/**
 * The Excel workbook.
 *
 * Four sheets: an overview, the main table-by-table documentation, and flat
 * catalogues of measures and tables for searching and filtering.
 *
 * The layout choices are all in service of one thing — this has to read as a
 * document, not as a data dump. That means a table's name is a banded section
 * header rather than a repeated cell value, its SQL and DAX sit in monospace
 * blocks with their line breaks intact, and row heights are computed from the
 * content rather than left at the default, which would clip every multi-line
 * statement to one line.
 *
 * ExcelJS is imported dynamically by the caller, not here, so that ~900 KB of
 * spreadsheet library is fetched only when someone actually exports.
 */
import type { Alignment, Borders, Fill, Workbook, Worksheet } from "exceljs";

import type { DocumentModel, MeasureDoc, TableDoc } from "./document.ts";
import { NOT_DETECTED } from "./definitions.ts";

/* ---------------------------------------------------------------- theme --- */

const INK = "FF1F2733";
const ACCENT = "FF2F6F6B";
const ACCENT_SOFT = "FFE8F1F0";
const BAND = "FFF4F6F8";
const RULE = "FFD8DEE5";
const MUTED = "FF6B7183";
const CODE_BG = "FFF7F8FA";

const BODY_FONT = "Calibri";
const CODE_FONT = "Consolas";

const fill = (argb: string): Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb },
});

const thin = { style: "thin" as const, color: { argb: RULE } };
const border = (over?: Partial<Borders>): Partial<Borders> => ({
  top: thin,
  left: thin,
  bottom: thin,
  right: thin,
  ...over,
});

const topLeft: Partial<Alignment> = { vertical: "top", horizontal: "left", wrapText: true };

/** Excel counts a merged cell's height from one row, so it must be told. */
function heightFor(texts: string[], widths: number[], min = 18): number {
  let lines = 1;
  texts.forEach((text, i) => {
    if (!text) return;
    const width = widths[i] ?? 60;
    const count = text
      .split("\n")
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0);
    lines = Math.max(lines, count);
  });
  // 14pt per line is close enough at 11pt type, capped so one enormous
  // statement cannot produce a row taller than a screen.
  return Math.min(Math.max(min, lines * 14), 420);
}

/* ------------------------------------------------------------ sheet 1 --- */

function overviewSheet(wb: Workbook, doc: DocumentModel): void {
  const ws = wb.addWorksheet("Model Overview", {
    views: [{ showGridLines: false }],
  });

  ws.columns = [
    { key: "metric", width: 42 },
    { key: "value", width: 62 },
  ];

  const title = ws.addRow(["Power BI Documentation", ""]);
  title.height = 34;
  title.getCell(1).font = { name: BODY_FONT, size: 18, bold: true, color: { argb: INK } };
  ws.mergeCells(title.number, 1, title.number, 2);

  const subtitle = ws.addRow([doc.fileName, ""]);
  subtitle.getCell(1).font = { name: BODY_FONT, size: 11, color: { argb: MUTED } };
  ws.mergeCells(subtitle.number, 1, subtitle.number, 2);
  ws.addRow([]);

  const header = ws.addRow(["Metric", "Value"]);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { name: BODY_FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(INK);
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = border();
  });

  doc.overview.forEach(([metric, value], i) => {
    const row = ws.addRow([metric, String(value)]);
    row.height = 20;
    row.eachCell((cell, col) => {
      cell.font = { name: BODY_FONT, size: 11, bold: col === 1, color: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      cell.border = border();
      if (i % 2 === 1) cell.fill = fill(BAND);
    });
  });

  ws.addRow([]);

  // The accuracy checks are part of the document: a reader deserves to know
  // the export verified itself rather than assuming it did.
  const checksHeader = ws.addRow(["Validation", "Result"]);
  checksHeader.height = 22;
  checksHeader.eachCell((cell) => {
    cell.font = { name: BODY_FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(ACCENT);
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = border();
  });

  for (const check of doc.validation.checks) {
    const row = ws.addRow([check.name, `${check.ok ? "PASS" : "FAIL"} — ${check.detail}`]);
    row.height = heightFor(["", check.detail], [42, 62], 20);
    row.getCell(1).font = { name: BODY_FONT, size: 11, color: { argb: INK } };
    row.getCell(2).font = {
      name: BODY_FONT,
      size: 11,
      color: { argb: check.ok ? INK : "FFB4232A" },
      bold: !check.ok,
    };
    row.eachCell((cell) => {
      cell.alignment = topLeft;
      cell.border = border();
    });
  }

  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
}

/* ------------------------------------------------------------ sheet 2 --- */

const DOC_COLUMNS = [
  { header: "PBI Table", width: 26 },
  { header: "Table Definition", width: 52 },
  { header: "Source SQL", width: 62 },
  { header: "Measure", width: 30 },
  { header: "Measure Definition", width: 52 },
  { header: "DAX", width: 62 },
  { header: "Other Referenced Tables", width: 30 },
];

/**
 * The main sheet, laid out as documentation.
 *
 * Each table opens a banded section: a thick-topped title row, then its
 * definition and SQL as full-width blocks, then a compact header and one row
 * per measure. A reader scrolling this sees structure, not a grid.
 */
function documentationSheet(wb: Workbook, doc: DocumentModel): Map<string, number> {
  const ws = wb.addWorksheet(DOC_SHEET, { views: [{ showGridLines: false }] });
  const anchors = new Map<string, number>();
  const last = DOC_COLUMNS.length;

  ws.columns = DOC_COLUMNS.map((c) => ({ width: c.width }));

  const header = ws.addRow(DOC_COLUMNS.map((c) => c.header));
  header.height = 26;
  header.eachCell((cell) => {
    cell.font = { name: BODY_FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(INK);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = border();
  });

  const section = (title: string, subtitle: string) => {
    ws.addRow([]);
    const row = ws.addRow([title]);
    row.height = 28;
    ws.mergeCells(row.number, 1, row.number, last);
    const cell = row.getCell(1);
    cell.value = title;
    cell.font = { name: BODY_FONT, size: 13, bold: true, color: { argb: INK } };
    cell.fill = fill(ACCENT_SOFT);
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = border({ top: { style: "medium", color: { argb: ACCENT } } });

    if (subtitle) {
      const note = ws.addRow([subtitle]);
      ws.mergeCells(note.number, 1, note.number, last);
      note.getCell(1).font = { name: BODY_FONT, size: 10, italic: true, color: { argb: MUTED } };
      note.getCell(1).alignment = topLeft;
    }
    return row.number;
  };

  /** A full-width labelled block, used for a definition or a statement. */
  const block = (label: string, text: string, code: boolean) => {
    const labelRow = ws.addRow([label]);
    ws.mergeCells(labelRow.number, 1, labelRow.number, last);
    labelRow.getCell(1).font = {
      name: BODY_FONT,
      size: 10,
      bold: true,
      color: { argb: ACCENT },
    };
    labelRow.height = 18;

    const bodyRow = ws.addRow([text]);
    ws.mergeCells(bodyRow.number, 1, bodyRow.number, last);
    const cell = bodyRow.getCell(1);
    cell.font = code
      ? { name: CODE_FONT, size: 10, color: { argb: INK } }
      : { name: BODY_FONT, size: 11, color: { argb: INK } };
    cell.alignment = topLeft;
    cell.border = border();
    if (code) cell.fill = fill(CODE_BG);
    // The merged width is the sum of every column.
    bodyRow.height = heightFor([text], [DOC_COLUMNS.reduce((n, c) => n + c.width, 0)], 20);
  };

  const measureRows = (measures: MeasureDoc[]) => {
    if (measures.length === 0) return;

    const head = ws.addRow(["", "", "", "Measure", "Measure Definition", "DAX", "Other Referenced Tables"]);
    head.height = 20;
    for (let col = 4; col <= last; col++) {
      const cell = head.getCell(col);
      cell.font = { name: BODY_FONT, size: 10, bold: true, color: { argb: MUTED } };
      cell.fill = fill(BAND);
      cell.alignment = { vertical: "middle", horizontal: "left" };
      cell.border = border();
    }

    measures.forEach((measure, i) => {
      const others = measure.otherTables.length > 0 ? measure.otherTables.join(", ") : "None";
      const row = ws.addRow(["", "", "", measure.name, measure.definition, measure.dax, others]);
      row.height = heightFor(
        ["", "", "", measure.name, measure.definition, measure.dax, others],
        DOC_COLUMNS.map((c) => c.width),
        20
      );

      for (let col = 4; col <= last; col++) {
        const cell = row.getCell(col);
        cell.alignment = topLeft;
        cell.border = border();
        const isDax = col === 6;
        cell.font = isDax
          ? { name: CODE_FONT, size: 10, color: { argb: INK } }
          : { name: BODY_FONT, size: 11, bold: col === 4, color: { argb: INK } };
        if (isDax) cell.fill = fill(CODE_BG);
        else if (i % 2 === 1) cell.fill = fill(BAND);
      }
    });
  };

  for (const table of doc.tables) {
    const at = section(
      table.name.toUpperCase(),
      `${table.sourceType} · ${table.columnCount} columns · ${table.measures.length} measure(s) mapped by DAX`
    );
    anchors.set(table.name, at);

    block("Table Definition", table.definition, false);
    block(
      "Source SQL",
      table.nativeSql ?? table.sqlUnavailableReason ?? "Native SQL unavailable",
      Boolean(table.nativeSql)
    );
    measureRows(table.measures);
  }

  if (doc.multiTableMeasures.length > 0) {
    const at = section(
      "MULTI-TABLE MEASURES",
      "No single table dominates these measures' DAX, so none is filed under a primary table. Every table each one reads is listed."
    );
    anchors.set("__multi", at);
    measureRows(doc.multiTableMeasures);
  }

  if (doc.unmappedMeasures.length > 0) {
    const at = section(
      "UNMAPPED MEASURES",
      "The DAX of these measures references no table this build could resolve. They are listed so that nothing is missing from the document."
    );
    anchors.set("__unmapped", at);
    measureRows(doc.unmappedMeasures);
  }

  ws.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: last } };
  return anchors;
}

/* ------------------------------------------------------------ sheet 3 --- */

function measureCatalogue(wb: Workbook, doc: DocumentModel, anchors: Map<string, number>): void {
  const ws = wb.addWorksheet("Measure Catalogue", { views: [{ showGridLines: false }] });

  const columns = [
    { header: "Measure Name", width: 32 },
    { header: "Likely KPI Name", width: 28 },
    { header: "Primary PBI Table", width: 24 },
    { header: "Other Referenced Tables", width: 30 },
    { header: "Home Table", width: 22 },
    { header: "Measure Definition", width: 56 },
    { header: "DAX", width: 62 },
    { header: "Report Pages Used", width: 30 },
    { header: "Visuals Used", width: 14 },
  ];
  ws.columns = columns.map((c) => ({ width: c.width }));

  const header = ws.addRow(columns.map((c) => c.header));
  header.height = 26;
  header.eachCell((cell) => {
    cell.font = { name: BODY_FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(INK);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = border();
  });

  doc.allMeasures.forEach((measure, i) => {
    const primary =
      measure.primaryTable ??
      (measure.allTables.length > 1 ? "Multiple source tables" : NOT_DETECTED);
    const values = [
      measure.name,
      measure.kpiName ?? NOT_DETECTED,
      primary,
      measure.otherTables.length > 0 ? measure.otherTables.join(", ") : "None",
      measure.homeTable,
      measure.definition,
      measure.dax,
      measure.pages.length > 0 ? measure.pages.join(", ") : "Not used on any page",
      measure.visualCount,
    ];

    const row = ws.addRow(values);
    row.height = heightFor(
      values.map(String),
      columns.map((c) => c.width),
      20
    );

    row.eachCell((cell, col) => {
      cell.alignment = col === 9 ? { vertical: "top", horizontal: "center" } : topLeft;
      cell.border = border();
      const isDax = col === 7;
      cell.font = isDax
        ? { name: CODE_FONT, size: 10, color: { argb: INK } }
        : { name: BODY_FONT, size: 11, bold: col === 1, color: { argb: INK } };
      if (isDax) cell.fill = fill(CODE_BG);
      else if (i % 2 === 1) cell.fill = fill(BAND);
    });

    // Jump straight to the section documenting this measure's table.
    const target = measure.primaryTable
      ? anchors.get(measure.primaryTable)
      : anchors.get("__multi") ?? anchors.get("__unmapped");
    if (target) {
      const cell = row.getCell(3);
      cell.value = jumpTo(DOC_SHEET, target, primary);
      cell.font = { name: BODY_FONT, size: 11, color: { argb: ACCENT }, underline: true };
    }
  });

  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1, showGridLines: false }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

/* ------------------------------------------------------------ sheet 4 --- */

function tableCatalogue(wb: Workbook, doc: DocumentModel, anchors: Map<string, number>): void {
  const ws = wb.addWorksheet("Table Catalogue", { views: [{ showGridLines: false }] });

  const columns = [
    { header: "PBI Table", width: 26 },
    { header: "Definition", width: 58 },
    { header: "Source Type", width: 22 },
    { header: "Native SQL Available", width: 20 },
    { header: "Native SQL", width: 66 },
    { header: "Column Count", width: 14 },
    { header: "Measures Using Table", width: 18 },
    { header: "Referenced Tables / Dependencies", width: 34 },
  ];
  ws.columns = columns.map((c) => ({ width: c.width }));

  const header = ws.addRow(columns.map((c) => c.header));
  header.height = 26;
  header.eachCell((cell) => {
    cell.font = { name: BODY_FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(INK);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = border();
  });

  doc.tables.forEach((table: TableDoc, i) => {
    const values = [
      table.name,
      table.definition,
      table.sourceType,
      table.sqlAvailable ? "Yes" : "No",
      table.nativeSql ?? table.sqlUnavailableReason ?? "Native SQL unavailable",
      table.columnCount,
      table.measures.length,
      table.dependencies.length > 0 ? table.dependencies.join(", ") : "None",
    ];

    const row = ws.addRow(values);
    row.height = heightFor(
      values.map(String),
      columns.map((c) => c.width),
      20
    );

    row.eachCell((cell, col) => {
      cell.alignment =
        col === 4 || col === 6 || col === 7
          ? { vertical: "top", horizontal: "center" }
          : topLeft;
      cell.border = border();
      const isSql = col === 5;
      cell.font = isSql
        ? { name: CODE_FONT, size: 10, color: { argb: table.sqlAvailable ? INK : MUTED } }
        : { name: BODY_FONT, size: 11, bold: col === 1, color: { argb: INK } };
      if (isSql) cell.fill = fill(CODE_BG);
      else if (i % 2 === 1) cell.fill = fill(BAND);
    });

    const target = anchors.get(table.name);
    if (target) {
      const cell = row.getCell(1);
      cell.value = jumpTo(DOC_SHEET, target, table.name);
      cell.font = { name: BODY_FONT, size: 11, bold: true, color: { argb: ACCENT }, underline: true };
    }
  });

  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1, showGridLines: false }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

/* ------------------------------------------------------------------ api --- */

/**
 * An in-workbook jump, written as a HYPERLINK formula.
 *
 * ExcelJS's `{ text, hyperlink }` cell writes an *external* relationship whose
 * target is `#'Sheet'!A1`, and puts that same `#`-prefixed string in the
 * `location` attribute. Both are wrong for a jump inside the same file: Excel
 * expects a location of `'Sheet'!A1` with no relationship at all, and does not
 * reliably resolve the external form — the link renders but goes nowhere.
 *
 * A formula sidesteps the relationship machinery entirely and is what Excel
 * itself produces for this. `result` is set so the cell still shows its text
 * in readers that do not evaluate formulas.
 */
function jumpTo(sheet: string, row: number, text: string) {
  // Sheet names are single-quoted in a reference; a literal quote doubles.
  const target = `#'${sheet.replace(/'/g, "''")}'!A${row}`;
  const escaped = text.replace(/"/g, '""');
  return {
    formula: `HYPERLINK("${target}","${escaped}")`,
    result: text,
  };
}

const DOC_SHEET = "Table & Measure Docs";

/** `Sales Dashboard.pbit` becomes `Sales Dashboard - Power BI Documentation.xlsx`. */
export function documentationFileName(sourceFileName: string): string {
  const dot = sourceFileName.lastIndexOf(".");
  const stem = dot === -1 ? sourceFileName : sourceFileName.slice(0, dot);
  return `${stem} - Power BI Documentation.xlsx`;
}

/**
 * Build the workbook.
 *
 * `ExcelJSModule` is passed in rather than imported so the caller controls
 * when the library is fetched.
 */
export async function buildWorkbook(
  doc: DocumentModel,
  ExcelJS: typeof import("exceljs")
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PBI Quality Studio";
  wb.created = new Date(doc.exportedAt);
  wb.title = `${doc.fileName} — Power BI Documentation`;

  overviewSheet(wb, doc);
  const anchors = documentationSheet(wb, doc);
  measureCatalogue(wb, doc, anchors);
  tableCatalogue(wb, doc, anchors);

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** Hand the workbook to the browser as a download. */
export function downloadWorkbook(bytes: Uint8Array, fileName: string): void {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const url = URL.createObjectURL(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type { Worksheet };
