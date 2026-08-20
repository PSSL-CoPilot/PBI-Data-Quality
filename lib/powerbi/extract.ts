/**
 * Format detection and extraction entry point.
 *
 * Detection is driven by the archive's parts, not the file extension, because
 * the extension does not tell you whether a model is readable. What each format
 * actually yields:
 *
 *   PBIT  - `DataModelSchema` is TMSL JSON. Full model + report. Round-trips.
 *   PBIP  - `model.bim` is the same TMSL. Full model + report. Round-trips.
 *   PBIX  - `DataModel` is a compressed Analysis Services backup that cannot be
 *           read without the Analysis Services engine. Report layer only.
 */
import type { Capability, CapabilityId, Model } from "./model.ts";
import { available, unavailable } from "./model.ts";
import { parseLayout } from "./layout.ts";
import { parseTmsl, type TmslParts } from "./tmsl.ts";
import { decodeUtf16, decodeUtf8, listZip, readZip, sha256, type ZipParts } from "./zip.ts";

export type SourceFormat = Model["source"]["format"];

/**
 * The untouched inputs, kept beside the normalized model. Edits are replayed
 * onto these original documents at export time so that fields we never modelled
 * survive the round trip instead of being dropped.
 */
export interface RawSources {
  parts: ZipParts;
  /**
   * The whole uploaded archive, retained only when the model is readable and
   * therefore exportable. Repacking needs every part, including the ones this
   * build never parses, and a report-only PBIX cannot be exported anyway, so
   * its bytes (often over 100 MB) are not held.
   */
  sourceBytes?: Uint8Array;
  modelSchemaPath?: string;
  modelSchema?: unknown;
  modelSchemaBom: boolean;
  modelSchemaEncoding: "utf-16le" | "utf-8";
  layoutPath?: string;
  layout?: unknown;
  layoutBom: boolean;
  layoutEncoding: "utf-16le" | "utf-8";
}

export interface Extraction {
  model: Model;
  raw: RawSources;
}

export class ExtractionError extends Error {
  detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ExtractionError";
    this.detail = detail;
  }
}

const PBIX_MODEL_REASON =
  "This .pbix stores its semantic model in the binary DataModel part (an Analysis Services backup), which only Power BI Desktop can open. Measures, DAX, columns, relationships and Power Query are unavailable. Export the file from Power BI Desktop as a .pbit (File > Export > Power BI template) or save it as a .pbip project to analyze and edit the model.";

const RUNTIME_REASON =
  "No query engine is connected, so nothing is executed against the model. Checks that need row counts, timings or refresh results are not run.";

function decodePart(
  bytes: Uint8Array
): { value: unknown; bom: boolean; encoding: "utf-16le" | "utf-8" } | undefined {
  // UTF-16LE text has a zero byte in every ASCII pair; UTF-8 JSON does not.
  const looksUtf16 = bytes.length > 1 && bytes[1] === 0x00;

  const attempt = (encoding: "utf-16le" | "utf-8") => {
    let text: string;
    let hadBom: boolean;
    if (encoding === "utf-16le") {
      ({ text, hadBom } = decodeUtf16(bytes));
    } else {
      const raw = decodeUtf8(bytes);
      hadBom = raw.charCodeAt(0) === 0xfeff;
      text = hadBom ? raw.slice(1) : raw;
    }
    try {
      return { value: JSON.parse(text) as unknown, bom: hadBom, encoding };
    } catch {
      return undefined;
    }
  };

  return looksUtf16
    ? attempt("utf-16le") ?? attempt("utf-8")
    : attempt("utf-8") ?? attempt("utf-16le");
}

interface Detected {
  format: SourceFormat;
  modelSchemaPath?: string;
  layoutPath?: string;
  /** Set when a model exists in the archive but this build cannot read it. */
  modelUnavailableReason?: string;
}

export function detectFormat(names: string[]): Detected | undefined {
  const has = (name: string) => names.includes(name);
  const find = (predicate: (n: string) => boolean) => names.find(predicate);

  if (has("DataModelSchema")) {
    return {
      format: "pbit",
      modelSchemaPath: "DataModelSchema",
      layoutPath: has("Report/Layout") ? "Report/Layout" : undefined,
    };
  }

  const bim = find((n) => n.endsWith(".SemanticModel/model.bim") || n === "model.bim");
  const tmdl = find((n) => n.includes(".SemanticModel/definition/") && n.endsWith(".tmdl"));
  const pbipReport =
    find((n) => n.endsWith(".Report/report.json")) ?? find((n) => n === "report.json");

  if (bim || tmdl || pbipReport) {
    return {
      format: "pbip",
      modelSchemaPath: bim,
      layoutPath: pbipReport,
      modelUnavailableReason:
        !bim && tmdl
          ? "This PBIP project stores its model as TMDL text files. TMDL parsing is not implemented yet; re-save the project with the model.bim (TMSL) format, or upload a .pbit."
          : undefined,
    };
  }

  if (has("DataModel")) {
    return {
      format: "pbix",
      layoutPath: has("Report/Layout") ? "Report/Layout" : undefined,
      modelUnavailableReason: PBIX_MODEL_REASON,
    };
  }

  return undefined;
}

export async function extract(fileName: string, bytes: Uint8Array): Promise<Extraction> {
  let names: string[];
  try {
    names = listZip(bytes);
  } catch (error) {
    throw new ExtractionError(
      "The file could not be opened as a Power BI archive.",
      error instanceof Error ? error.message : undefined
    );
  }

  const detected = detectFormat(names);
  if (!detected) {
    throw new ExtractionError(
      "Unrecognized Power BI file.",
      "Expected a .pbit, .pbix or zipped .pbip project. The archive contained: " +
        names.slice(0, 12).join(", ")
    );
  }

  const wanted = [detected.modelSchemaPath, detected.layoutPath].filter(
    (n): n is string => Boolean(n)
  );
  const parts = wanted.length ? readZip(bytes, wanted) : {};

  const warnings: string[] = [];
  const raw: RawSources = {
    parts,
    modelSchemaBom: false,
    modelSchemaEncoding: "utf-16le",
    layoutBom: false,
    layoutEncoding: "utf-16le",
  };

  let tmsl: TmslParts = { tables: [], relationships: [], expressions: [], warnings: [] };
  let modelCapability: Capability = unavailable(
    detected.modelUnavailableReason ?? "No semantic model was found in this file."
  );

  const schemaPath = detected.modelSchemaPath;
  if (schemaPath && parts[schemaPath]) {
    const decoded = decodePart(parts[schemaPath]);
    if (decoded) {
      tmsl = parseTmsl(decoded.value);
      raw.modelSchemaPath = schemaPath;
      raw.modelSchema = decoded.value;
      raw.modelSchemaBom = decoded.bom;
      raw.modelSchemaEncoding = decoded.encoding;
      modelCapability = available();
    } else {
      modelCapability = unavailable(
        "The model schema part (" + schemaPath + ") could not be parsed as JSON."
      );
    }
  }

  let pages: Model["pages"] = [];
  let reportCapability: Capability = unavailable("This file contains no report layout part.");

  const layoutPath = detected.layoutPath;
  if (layoutPath && parts[layoutPath]) {
    const decoded = decodePart(parts[layoutPath]);
    if (decoded) {
      const parsed = parseLayout(decoded.value);
      pages = parsed.pages;
      warnings.push(...parsed.warnings);
      raw.layoutPath = layoutPath;
      raw.layout = decoded.value;
      raw.layoutBom = decoded.bom;
      raw.layoutEncoding = decoded.encoding;
      reportCapability = available();
    } else {
      reportCapability = unavailable(
        "The report layout part (" + layoutPath + ") could not be parsed as JSON."
      );
    }
  }

  const hasQueries =
    tmsl.tables.some((t) =>
      t.partitions.some((p) => p.sourceType === "m" || p.sourceType === "query")
    ) || tmsl.expressions.length > 0;

  const capabilities: Record<CapabilityId, Capability> = {
    model: modelCapability,
    report: reportCapability,
    powerQuery:
      modelCapability.available && hasQueries
        ? available()
        : unavailable(
            modelCapability.available
              ? "This model exposes no Power Query or native query partitions."
              : (modelCapability as { available: false; reason: string }).reason
          ),
    runtime: unavailable(RUNTIME_REASON),
  };

  if (modelCapability.available) raw.sourceBytes = bytes;

  return {
    model: {
      source: {
        fileName,
        format: detected.format,
        sizeBytes: bytes.byteLength,
        extractedAt: new Date().toISOString(),
      },
      capabilities,
      tables: tmsl.tables,
      relationships: tmsl.relationships,
      expressions: tmsl.expressions,
      pages,
      warnings: [...tmsl.warnings, ...warnings],
    },
    raw,
  };
}

/** Browser entry point: hash for version identity, then extract. */
export async function extractFile(file: File): Promise<Extraction & { sha256: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [result, digest] = await Promise.all([extract(file.name, bytes), sha256(bytes)]);
  return { ...result, sha256: digest };
}
