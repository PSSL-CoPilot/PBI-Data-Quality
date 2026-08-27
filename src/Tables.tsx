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
import { useDeferredValue, useMemo, useState } from "react";

import type { Change } from "../lib/edit/session.ts";
import type { Column, Model, Partition, Table } from "../lib/powerbi/model.ts";
import { replaceNativeQuery } from "../lib/powerbi/nativequery.ts";
import { analyseMeasureSources } from "../lib/powerbi/sources.ts";
import { CodeEditor, type CodeLanguage } from "./CodeEditor.tsx";
import { useDrawerPresence } from "./drawer.tsx";
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

let sqlCounter = 0;

/**
 * A SQL edit is stored as a change to the partition's whole source expression,
 * because that is what the exporter writes back. `replaceNativeQuery` puts the
 * edited statement into the M at the exact offsets of the original string
 * literal, so every other character of the query is preserved.
 */
function sqlChange(partition: Partition, sql: string): Change {
  const before = partition.expression ?? "";
  const after =
    partition.sourceType === "query" ? sql : (replaceNativeQuery(before, sql) ?? before);

  return {
    id: `sql-${++sqlCounter}-${Math.random().toString(36).slice(2, 8)}`,
    target: { type: "partition", table: partition.table, name: partition.name },
    field: "expression",
    before,
    after,
    at: Date.now(),
  };
}

/**
 * What loads a table, shown the way a report author expects to see it.
 *
 * When the file contains a real statement it is shown as SQL on its own and can
 * be edited. When Power Query folds its steps into a query at refresh time
 * there is no statement in the file to show, so that is stated plainly, with
 * the surrounding M available underneath for anyone who wants it.
 */
function PartitionSource({
  partition,
  onEdit,
  onEditSql,
}: {
  partition: Partition;
  onEdit: () => void;
  onEditSql: (sql: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showM, setShowM] = useState(false);
  const info = partition.nativeQuery;

  if (!partition.expression) {
    return (
      <p className="emptyNote">
        Partition &quot;{partition.name}&quot; ({partition.sourceType}) carries no readable
        definition in this file.
      </p>
    );
  }

  // A calculated table is DAX, not a database query.
  if (partition.sourceType === "calculated") {
    return (
      <div className="sourceBlock">
        <CodeEditor
          value={partition.expression}
          language="dax"
          label="Calculated table DAX"
          readOnly
        />
        <div className="measureActions">
          <button className="go" onClick={onEdit}>
            Edit DAX
          </button>
        </div>
      </div>
    );
  }

  const startEdit = () => {
    setDraft(info?.sql ?? "");
    setEditing(true);
  };

  return (
    <div className="sourceBlock">
      {info?.kind === "native" ? (
        <>
          <div className="sqlHead">
            <b>Native SQL</b>
            <span className="srcTag">via {info.connector}</span>
            {partition.mode && <span className="srcTag">{partition.mode}</span>}
          </div>
          <CodeEditor
            value={editing ? draft : (info.sql ?? "")}
            language="sql"
            label="Native SQL"
            readOnly={!editing}
            onChange={editing ? setDraft : undefined}
            minHeight={160}
          />
          <div className="measureActions">
            {editing ? (
              <>
                <button
                  className="go"
                  disabled={draft === info.sql}
                  onClick={() => {
                    onEditSql(draft);
                    setEditing(false);
                  }}
                >
                  Save SQL change
                </button>
                <button onClick={() => setEditing(false)}>Cancel</button>
              </>
            ) : (
              <button className="go" onClick={startEdit}>
                Edit SQL
              </button>
            )}
            {partition.sourceType === "m" && (
              <button onClick={() => setShowM((v) => !v)}>
                {showM ? "Hide Power Query" : "Show full Power Query"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="sqlHead">
            <b>Native SQL unavailable for this table</b>
          </div>
          <p className="emptyNote">{info?.reason}</p>
          <div className="measureActions">
            <button onClick={() => setShowM((v) => !v)}>
              {showM ? "Hide Power Query" : "Show Power Query"}
            </button>
            <button className="go" onClick={onEdit}>
              Edit Power Query
            </button>
          </div>
        </>
      )}

      {showM && (
        <div style={{ marginTop: 10 }}>
          <CodeEditor
            value={partition.expression}
            language={partitionLanguage(partition)}
            label="Power Query (M)"
            readOnly
            minHeight={140}
          />
        </div>
      )}
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
  /*
   * The box stays controlled by `query`, so a keystroke always shows
   * immediately. Filtering reads the deferred copy instead, which React may
   * render late and abandon when the next keystroke arrives — without it every
   * character re-filtered the whole model and cost about 90ms, which is five
   * dropped frames per letter.
   */
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [selected, setSelected] = useState<Table | null>(() =>
    focus?.type === "table" ? (model.tables.find((t) => t.name === focus.name) ?? null) : null
  );

  const sources = useMemo(() => analyseMeasureSources(model), [model]);

  const filtered = model.tables.filter((table) =>
    `${table.name} ${table.kind}`.toLowerCase().includes(search.trim().toLowerCase())
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

type DrawerTab = "Overview" | "Columns" | "Measures" | "SQL";
const DRAWER_TABS: DrawerTab[] = ["Overview", "Columns", "Measures", "SQL"];

/**
 * The table detail panel.
 *
 * Four tabs rather than one long accordion, and a fixed four-row frame: header,
 * tabs, body, footer. Only the body scrolls. The previous version stacked
 * collapsible sections inside a scrolling panel, so the title and the actions
 * scrolled away with the content and a long SQL block pushed the buttons out of
 * reach entirely.
 */
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
  // Tells the shell to make room, so the table beside this stays readable.
  useDrawerPresence();
  const [tab, setTab] = useState<DrawerTab>("Overview");
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

  const editor =
    editing?.kind === "table" ? (
      <TableEditor model={model} table={table} onApply={onApply} onCancel={() => setEditing(null)} />
    ) : column ? (
      <ColumnEditor model={model} column={column} onApply={onApply} onCancel={() => setEditing(null)} />
    ) : partition ? (
      <PartitionEditor
        model={model}
        partition={partition}
        onApply={onApply}
        onCancel={() => setEditing(null)}
      />
    ) : null;

  return (
    <div className="drawer">
      <div className="drawerHead">
        <div>
          <small>TABLE</small>
          <h2>{table.name}</h2>
        </div>
        <button onClick={close} aria-label="Close">
          ×
        </button>
      </div>

      <div className="drawerTabs">
        {DRAWER_TABS.map((name) => (
          <button
            key={name}
            className={tab === name && !editor ? "on" : ""}
            onClick={() => {
              setEditing(null);
              setTab(name);
            }}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="drawerBody">
        {editor ?? (
          <>
            {tab === "Overview" && (
              <>
                <div className="meta">
                  <span>
                    <small>KIND</small>
                    {table.kind === "calculated" ? "Calculated table" : "Table"}
                  </span>
                  <span>
                    <small>COLUMNS</small>
                    {table.columns.length}
                  </span>
                  <span>
                    <small>MEASURES USING IT</small>
                    {usingThisTable.length}
                  </span>
                  <span>
                    <small>SOURCE</small>
                    {table.partitions.map((p) => partitionLabel(p)).join(", ") || "None"}
                  </span>
                  <span>
                    <small>HIDDEN</small>
                    {table.isHidden ? "Yes" : "No"}
                  </span>
                </div>

                {table.description && <p className="drawerNote">{table.description}</p>}

                <h3 className="drawerSection">Relationships</h3>
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
                        {!rel.isActive && <span className="kpiTag low">inactive</span>}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {tab === "Columns" &&
              (table.columns.length === 0 ? (
                <p className="emptyNote">This table exposes no columns.</p>
              ) : (
                table.columns.map((entry) => (
                  <div className="measureRow" key={entry.name}>
                    <div className="measureTop">
                      <b>{entry.name}</b>
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
              ))}

            {tab === "Measures" &&
              (usingThisTable.length === 0 ? (
                <p className="emptyNote">No measure reads this table in its DAX.</p>
              ) : (
                usingThisTable.map((entry) => (
                  <div className="measureRow" key={`${entry.homeTable}.${entry.measure}`}>
                    <div className="measureTop">
                      <b>{entry.measure}</b>
                      {entry.primary === table.name && <span className="kpiTag">main source</span>}
                      <span className="srcTag">stored in {entry.homeTable}</span>
                    </div>
                    <div className="measureMeta">{entry.reason}</div>
                  </div>
                ))
              ))}

            {tab === "SQL" &&
              (table.partitions.length === 0 ? (
                <p className="emptyNote">This table exposes no source definition.</p>
              ) : (
                table.partitions.map((entry) => (
                  <PartitionSource
                    key={entry.name}
                    partition={entry}
                    onEdit={() => setEditing({ kind: "partition", name: entry.name })}
                    onEditSql={(sql) => onApply([sqlChange(entry, sql)])}
                  />
                ))
              ))}
          </>
        )}
      </div>

      <div className="drawerFoot">
        {!editor && tab !== "SQL" && (
          <button onClick={() => setEditing({ kind: "table" })}>Edit table</button>
        )}
        <button className="primarySmall" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}
