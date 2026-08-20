/**
 * The tables workspace.
 *
 * A table is shown as four things a reviewer actually asks about: its columns,
 * the measures whose DAX reads it, the relationships it takes part in, and the
 * query that loads it.
 *
 * The measures list is derived from DAX references rather than home table, so a
 * measure parked in a `Measures` table still appears under the table it reads.
 * The query is whatever the file actually holds — native SQL, Power Query, or a
 * calculated-table expression — and nothing is invented when a table has none.
 */
import { useMemo, useState } from "react";

import type { Change } from "../lib/edit/session.ts";
import type { Column, Model, Partition, Table } from "../lib/powerbi/model.ts";
import { analyseMeasureSources } from "../lib/powerbi/sources.ts";
import { CodeEditor, type CodeLanguage } from "./CodeEditor.tsx";
import { ColumnEditor, PartitionEditor, TableEditor } from "./Editor.tsx";

export type Focus = { type: string; name: string; table?: string; page?: string } | null;

/** What language a partition's expression is written in. */
export function partitionLanguage(partition: Partition): CodeLanguage {
  if (partition.sourceType === "query") return "sql";
  if (partition.sourceType === "m") return "m";
  if (partition.sourceType === "calculated") return "dax";
  return "text";
}

export function partitionLabel(partition: Partition): string {
  if (partition.sourceType === "query") return "Native SQL query";
  if (partition.sourceType === "m") return "Power Query (M)";
  if (partition.sourceType === "calculated") return "Calculated table DAX";
  return `Source definition (${partition.sourceType})`;
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="groupCard" style={{ marginTop: 10 }}>
      <button className="groupHead" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▼" : "▶"}</span>
        <b>{title}</b>
        {count !== undefined && <em>{count}</em>}
      </button>
      {open && <div className="groupBody">{children}</div>}
    </div>
  );
}

export function Tables({
  model,
  focus,
  onApply,
}: {
  model: Model;
  focus: Focus;
  onApply: (changes: Change[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Table | null>(() =>
    focus?.type === "table" ? (model.tables.find((t) => t.name === focus.name) ?? null) : null
  );

  const sources = useMemo(() => analyseMeasureSources(model), [model]);

  const filtered = model.tables.filter((table) =>
    `${table.name} ${table.kind}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <>
      <article className="card explorer">
        <div className="toolbar">
          <div className="filter">
            ⌕{" "}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tables..."
            />
          </div>
          <button>
            {filtered.length} of {model.tables.length}
          </button>
        </div>
        <table>
          <thead>
            <tr>
              {["Table name", "Kind", "Columns", "Measures", "Source", "Hidden"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((table) => {
              const usedBy = [...sources.values()].filter((s) => s.all.includes(table.name));
              return (
                <tr
                  key={table.name}
                  className={focus?.type === "table" && focus.name === table.name ? "hit" : ""}
                  onClick={() => setSelected(table)}
                >
                  <td>
                    <b>▦ {table.name}</b>
                  </td>
                  <td>{table.kind === "calculated" ? "Calculated" : "Table"}</td>
                  <td>{table.columns.length}</td>
                  <td>{usedBy.length}</td>
                  <td>
                    {table.partitions.map((p) => partitionLabel(p)).join(", ") || "—"}
                  </td>
                  <td>{table.isHidden ? "Yes" : "No"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </article>

      {selected && (
        <TableDrawer
          model={model}
          table={selected}
          close={() => setSelected(null)}
          onApply={(changes) => {
            onApply(changes);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

type EditTargetState =
  | { kind: "table" }
  | { kind: "column"; name: string }
  | { kind: "partition"; name: string }
  | null;

function TableDrawer({
  model,
  table,
  close,
  onApply,
}: {
  model: Model;
  table: Table;
  close: () => void;
  onApply: (changes: Change[]) => void;
}) {
  const [editing, setEditing] = useState<EditTargetState>(null);
  const sources = useMemo(() => analyseMeasureSources(model), [model]);

  const column: Column | undefined =
    editing?.kind === "column" ? table.columns.find((c) => c.name === editing.name) : undefined;
  const partition: Partition | undefined =
    editing?.kind === "partition"
      ? table.partitions.find((p) => p.name === editing.name)
      : undefined;

  // Measures whose DAX reads this table, wherever they physically live.
  const usingThisTable = [...sources.values()]
    .filter((s) => s.all.includes(table.name))
    .sort((a, b) => a.measure.localeCompare(b.measure));

  const relationships = model.relationships.filter(
    (r) => r.fromTable === table.name || r.toTable === table.name
  );

  return (
    <div className="drawer">
      <div className="drawerHead">
        <div>
          <small>TABLE</small>
          <h2>{table.name}</h2>
        </div>
        <button onClick={close}>×</button>
      </div>

      <div className="tabs">
        <button className={editing === null ? "on" : ""} onClick={() => setEditing(null)}>
          Overview
        </button>
        <button
          className={editing?.kind === "table" ? "on" : ""}
          onClick={() => setEditing({ kind: "table" })}
        >
          Edit table
        </button>
      </div>

      {editing?.kind === "table" && (
        <TableEditor model={model} table={table} onApply={onApply} onCancel={() => setEditing(null)} />
      )}
      {column && (
        <ColumnEditor
          model={model}
          column={column}
          onApply={onApply}
          onCancel={() => setEditing(null)}
        />
      )}
      {partition && (
        <PartitionEditor
          model={model}
          partition={partition}
          onApply={onApply}
          onCancel={() => setEditing(null)}
        />
      )}

      {editing === null && (
        <>
          <Section title="Columns" count={table.columns.length}>
            {table.columns.length === 0 ? (
              <p className="emptyNote">This table exposes no columns.</p>
            ) : (
              table.columns.map((entry) => (
                <div className="measureRow" key={entry.name}>
                  <div className="measureTop">
                    <b>◇ {entry.name}</b>
                    <span className="srcTag">{entry.dataType}</span>
                    {entry.kind === "calculated" && <span className="kpiTag low">calculated</span>}
                    {entry.isHidden && <span className="srcTag">hidden</span>}
                  </div>
                  {entry.description && <div className="measureMeta">{entry.description}</div>}
                  <div className="measureActions">
                    <button onClick={() => setEditing({ kind: "column", name: entry.name })}>
                      Edit column
                    </button>
                  </div>
                </div>
              ))
            )}
          </Section>

          <Section title="Measures using this table" count={usingThisTable.length}>
            {usingThisTable.length === 0 ? (
              <p className="emptyNote">
                No measure references this table in its DAX.
              </p>
            ) : (
              usingThisTable.map((entry) => (
                <div className="measureRow" key={`${entry.homeTable}.${entry.measure}`}>
                  <div className="measureTop">
                    <b>ƒ {entry.measure}</b>
                    {entry.primary === table.name && <span className="kpiTag">primary source</span>}
                    <span className="srcTag">Home: {entry.homeTable}</span>
                  </div>
                  <div className="measureMeta">{entry.reason}</div>
                </div>
              ))
            )}
          </Section>

          <Section title="Relationships" count={relationships.length}>
            {relationships.length === 0 ? (
              <p className="emptyNote">
                This table has no relationships, so it cannot filter or be filtered.
              </p>
            ) : (
              relationships.map((rel) => (
                <div className="measureRow" key={rel.name}>
                  <div className="measureTop">
                    <b>
                      {rel.fromTable}[{rel.fromColumn}] → {rel.toTable}[{rel.toColumn}]
                    </b>
                    <span className="srcTag">
                      {rel.fromCardinality} → {rel.toCardinality}
                    </span>
                    <span className="srcTag">{rel.crossFilteringBehavior}</span>
                    {!rel.isActive && <span className="kpiTag low">inactive</span>}
                  </div>
                </div>
              ))
            )}
          </Section>

          <Section title="Source query" count={table.partitions.length}>
            {table.partitions.length === 0 ? (
              <p className="emptyNote">
                This table exposes no partition or source definition.
              </p>
            ) : (
              table.partitions.map((entry) => (
                <div key={entry.name} style={{ marginBottom: 12 }}>
                  {entry.expression ? (
                    <>
                      <CodeEditor
                        value={entry.expression}
                        language={partitionLanguage(entry)}
                        label={`${partitionLabel(entry)}${entry.mode ? ` · ${entry.mode}` : ""}`}
                        readOnly
                      />
                      <div className="measureActions">
                        <button
                          className="go"
                          onClick={() => setEditing({ kind: "partition", name: entry.name })}
                        >
                          Edit query
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="emptyNote">
                      Partition &quot;{entry.name}&quot; ({entry.sourceType}) carries no readable
                      expression in this file. Nothing is shown rather than guessing at SQL the
                      model does not contain.
                    </p>
                  )}
                </div>
              ))
            )}
          </Section>
        </>
      )}

      <div className="drawerFoot">
        <button onClick={close}>Done</button>
      </div>
    </div>
  );
}
