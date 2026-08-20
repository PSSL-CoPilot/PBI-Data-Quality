/**
 * Editing forms for measures, tables and columns.
 *
 * A rename cannot be applied straight from the form. It goes through a preview
 * that lists every page, visual, measure and relationship the change touches,
 * plus anything the rewrite could not resolve. That is the "detect, preview,
 * apply, validate, flag" sequence, made unskippable by the UI rather than left
 * to the user to remember.
 */
import { useMemo, useState } from "react";

import { previewRename, type Change, type EditTarget } from "../lib/edit/session.ts";
import { CodeEditor, type CodeLanguage } from "./CodeEditor.tsx";
import type { Column, Measure, Model, Partition, Table } from "../lib/powerbi/model.ts";

interface FieldSpec {
  field: Change["field"];
  label: string;
  value: string;
  kind?: "text" | "code" | "select";
  /** Which highlighter a code field gets. */
  language?: CodeLanguage;
  options?: string[];
  /** Renames need the dependency preview; other fields do not. */
  isRename?: boolean;
}

let counter = 0;
const nextId = () => `chg-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

function PreviewPanel({
  model,
  target,
  newName,
}: {
  model: Model;
  target: EditTarget;
  newName: string;
}) {
  const preview = useMemo(
    () => previewRename(model, target, newName),
    [model, target, newName]
  );
  const blocked = preview.blockers.length > 0;

  return (
    <div className={blocked ? "preview blocker" : "preview"}>
      <h4>{blocked ? "This rename cannot be applied" : `Used in`}</h4>

      {blocked ? (
        <ul>
          {preview.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : (
        <>
          <div className="usedIn">
            <div>
              <b>{preview.pages.length}</b>
              <small>report pages</small>
            </div>
            <div>
              <b>{preview.visuals}</b>
              <small>visuals</small>
            </div>
            <div>
              <b>{preview.measures.length}</b>
              <small>measures</small>
            </div>
            <div>
              <b>{preview.relationships}</b>
              <small>relationships</small>
            </div>
            <div>
              <b>{preview.partitions.length}</b>
              <small>queries</small>
            </div>
          </div>

          {preview.pages.length > 0 && (
            <ul>
              {preview.pages.map((page) => (
                <li key={page}>Page: {page}</li>
              ))}
            </ul>
          )}
          {preview.measures.length > 0 && (
            <ul>
              {preview.measures.map((measure) => (
                <li key={measure}>Measure: {measure}</li>
              ))}
            </ul>
          )}

          {preview.warnings.length > 0 ? (
            <ul>
              {preview.warnings.map((warning) => (
                <li key={warning} style={{ color: "#a97037" }}>
                  <b>Cannot update automatically.</b> {warning}
                </li>
              ))}
            </ul>
          ) : (
            <p className="scoreNote" style={{ margin: "8px 0 0" }}>
              Every reference above can be updated automatically.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function EditForm({
  model,
  target,
  specs,
  onApply,
  onCancel,
}: {
  model: Model;
  target: EditTarget;
  specs: FieldSpec[];
  onApply: (changes: Change[]) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(specs.map((s) => [s.field, s.value]))
  );
  const [reviewing, setReviewing] = useState(false);

  const dirty = specs.filter((s) => values[s.field] !== s.value);
  const rename = dirty.find((s) => s.isRename);
  const blocked =
    rename !== undefined &&
    previewRename(model, target, values[rename.field]).blockers.length > 0;

  const apply = () => {
    onApply(
      dirty.map((spec) => ({
        id: nextId(),
        target,
        field: spec.field,
        before: spec.value,
        after: values[spec.field],
        at: Date.now(),
      }))
    );
  };

  return (
    <div className="editForm">
      {specs.map((spec) => (
        <div key={spec.field} className={values[spec.field] !== spec.value ? "dirty" : ""}>
          <label htmlFor={`edit-${spec.field}`}>{spec.label.toUpperCase()}</label>
          {spec.kind === "code" ? (
            <CodeEditor
              value={values[spec.field]}
              language={spec.language ?? "dax"}
              label={spec.label}
              onChange={(next) => setValues((current) => ({ ...current, [spec.field]: next }))}
            />
          ) : spec.kind === "select" ? (
            <select
              id={`edit-${spec.field}`}
              value={values[spec.field]}
              onChange={(e) => setValues({ ...values, [spec.field]: e.target.value })}
            >
              {(spec.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`edit-${spec.field}`}
              value={values[spec.field]}
              onChange={(e) => setValues({ ...values, [spec.field]: e.target.value })}
            />
          )}
        </div>
      ))}

      {reviewing && rename && (
        <PreviewPanel model={model} target={target} newName={values[rename.field]} />
      )}

      <div className="editActions">
        {rename && !reviewing ? (
          <button className="go" onClick={() => setReviewing(true)}>
            Review dependencies
          </button>
        ) : (
          <button className="go" disabled={dirty.length === 0 || blocked} onClick={apply}>
            Apply {dirty.length} change{dirty.length === 1 ? "" : "s"}
          </button>
        )}
        <button onClick={onCancel}>Cancel</button>
        <span className="spacer">
          {dirty.length === 0
            ? "Nothing changed yet"
            : `${dirty.length} field${dirty.length === 1 ? "" : "s"} modified`}
        </span>
      </div>
    </div>
  );
}

export function MeasureEditor({
  model,
  measure,
  onApply,
  onCancel,
}: {
  model: Model;
  measure: Measure;
  onApply: (changes: Change[]) => void;
  onCancel: () => void;
}) {
  return (
    <EditForm
      model={model}
      target={{ type: "measure", table: measure.table, name: measure.name }}
      specs={[
        { field: "name", label: "Measure name", value: measure.name, isRename: true },
        {
          field: "expression",
          label: "DAX expression",
          value: measure.expression,
          kind: "code",
          language: "dax",
        },
        { field: "formatString", label: "Format string", value: measure.formatString ?? "" },
        { field: "description", label: "Description", value: measure.description ?? "" },
        {
          field: "homeTable",
          label: "Home table",
          value: measure.table,
          kind: "select",
          options: model.tables.map((t) => t.name),
        },
      ]}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}

export function TableEditor({
  model,
  table,
  onApply,
  onCancel,
}: {
  model: Model;
  table: Table;
  onApply: (changes: Change[]) => void;
  onCancel: () => void;
}) {
  const specs: FieldSpec[] = [
    { field: "name", label: "Table name", value: table.name, isRename: true },
    { field: "description", label: "Description", value: table.description ?? "" },
  ];
  if (table.kind === "calculated") {
    specs.splice(1, 0, {
      field: "expression",
      label: "Calculated table DAX",
      value: table.expression ?? "",
      kind: "code",
      language: "dax",
    });
  }

  return (
    <EditForm
      model={model}
      target={{ type: "table", name: table.name }}
      specs={specs}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}

export function ColumnEditor({
  model,
  column,
  onApply,
  onCancel,
}: {
  model: Model;
  column: Column;
  onApply: (changes: Change[]) => void;
  onCancel: () => void;
}) {
  const specs: FieldSpec[] = [
    { field: "name", label: "Column name", value: column.name, isRename: true },
    { field: "formatString", label: "Format string", value: column.formatString ?? "" },
    { field: "description", label: "Description", value: column.description ?? "" },
  ];
  if (column.kind === "calculated") {
    specs.splice(1, 0, {
      field: "expression",
      label: "Calculated column DAX",
      value: column.expression ?? "",
      kind: "code",
      language: "dax",
    });
  }

  return (
    <EditForm
      model={model}
      target={{ type: "column", table: column.table, name: column.name }}
      specs={specs}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}

export function PartitionEditor({
  model,
  partition,
  onApply,
  onCancel,
}: {
  model: Model;
  partition: Partition;
  onApply: (changes: Change[]) => void;
  onCancel: () => void;
}) {
  const label =
    partition.sourceType === "m"
      ? "Power Query (M)"
      : partition.sourceType === "query"
        ? "Native query"
        : "Partition expression";

  return (
    <EditForm
      model={model}
      target={{ type: "partition", table: partition.table, name: partition.name }}
      specs={[
        {
          field: "expression",
          label,
          value: partition.expression ?? "",
          kind: "code",
          // Native queries are SQL; everything else in a partition is M.
          language: partition.sourceType === "query" ? "sql" : "m",
        },
      ]}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}
