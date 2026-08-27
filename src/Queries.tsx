/**
 * Every query in the file, on one screen.
 *
 * SQL editing already existed, but only at the end of a path — Tables, click a
 * row, open the drawer, find the SQL tab — which is not a place anyone finds by
 * looking. A query is a first-class thing a reviewer comes to the app to change,
 * so it gets a first-class screen: every table that loads from a database,
 * listed, searchable, editable in place.
 *
 * The three states a query can be in are kept strictly apart, because they are
 * not the same thing and conflating them is how a tool starts inventing SQL:
 *
 *   native  — a statement is written in the file, so it can be shown and edited
 *   folded  — Power Query builds the statement at refresh time, so the file
 *             holds no SQL at all and none may be shown
 *   none    — the table has no database source (a calculated table, say)
 *
 * A folded query is never guessed at. The M is offered instead, because that is
 * the thing that genuinely determines what runs.
 */
import { useDeferredValue, useMemo, useState } from "react";

import type { Change } from "../lib/edit/session.ts";
import { analyseSql, dialectFromConnector, type SqlFinding } from "../lib/optimize/sql.ts";
import type { Model, Partition } from "../lib/powerbi/model.ts";
import { replaceNativeQuery } from "../lib/powerbi/nativequery.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { Collapsible } from "./ui.tsx";

export type QueryKind = "native" | "folded" | "none";

export interface QueryEntry {
  table: string;
  partition: Partition;
  kind: QueryKind;
  sql?: string;
  connector?: string;
  reason?: string;
}

/** Every partition in the model, sorted so the editable ones come first. */
export function collectQueries(model: Model): QueryEntry[] {
  const entries: QueryEntry[] = [];

  for (const table of model.tables) {
    for (const partition of table.partitions) {
      const info = partition.nativeQuery;
      const kind: QueryKind =
        info?.kind === "native" ? "native" : partition.expression ? "folded" : "none";

      entries.push({
        table: table.name,
        partition,
        kind,
        sql: info?.sql,
        connector: info?.connector,
        reason:
          info?.reason ??
          (partition.sourceType === "calculated"
            ? "This is a calculated table. It is computed in the model from DAX, so it never issues a database query."
            : undefined),
      });
    }
  }

  const rank = { native: 0, folded: 1, none: 2 };
  return entries.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.table.localeCompare(b.table)
  );
}

let counter = 0;

/**
 * A SQL edit is stored as a change to the whole source expression.
 *
 * That is what the exporter writes back. `replaceNativeQuery` puts the edited
 * statement into the M at the exact offsets of the original string literal, so
 * every other character of the query — the connector call, the options record,
 * the steps around it — survives byte for byte.
 */
export function sqlChange(partition: Partition, sql: string): Change | null {
  const before = partition.expression ?? "";
  const after =
    partition.sourceType === "query" ? sql : replaceNativeQuery(before, sql);

  // Refusing is the right answer when the statement cannot be placed back
  // exactly. Writing it anywhere else would produce a file that still opens
  // and quietly queries something the reviewer never asked for.
  if (after === undefined || after === before) return null;

  return {
    id: `sql-${++counter}-${Math.random().toString(36).slice(2, 8)}`,
    target: { type: "partition", table: partition.table, name: partition.name },
    field: "expression",
    before,
    after,
    at: Date.now(),
  };
}

function Findings({ findings }: { findings: SqlFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="sqlFindings">
      {findings.map((finding) => (
        <li key={finding.ruleId} className={finding.impact}>
          <b>{finding.title}</b>
          <span>{finding.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One query, closed until asked for.
 *
 * A model with thirty tables produces thirty of these. Rendering every editor
 * up front costs a CodeMirror instance each and makes the screen unusable, so
 * the body is not mounted at all until the row is opened.
 */
function QueryCard({
  entry,
  columns,
  onApply,
}: {
  entry: QueryEntry;
  /** The columns the model actually loaded for this table. */
  columns: string[];
  onApply: (changes: Change[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const findings = useMemo(
    () =>
      entry.kind === "native" && entry.sql
        ? analyseSql(entry.sql, {
            dialect: dialectFromConnector(entry.connector ?? ""),
            columns,
            mode: entry.partition.mode,
          })
        : [],
    [entry.kind, entry.sql, entry.connector, entry.partition.mode, columns]
  );

  const startEdit = () => {
    setDraft(entry.sql ?? "");
    setError("");
    setEditing(true);
  };

  const save = () => {
    const change = sqlChange(entry.partition, draft);
    if (!change) {
      setError(
        "The edited statement could not be written back into this partition's Power Query without disturbing the rest of it, so nothing was changed. Edit the full Power Query instead."
      );
      return;
    }
    onApply([change]);
    setEditing(false);
  };

  const summary = (
    <>
      <b>{entry.table}</b>
      {entry.kind === "native" && <span className="kpiTag">SQL</span>}
      {entry.kind === "folded" && <span className="srcTag">folded at refresh</span>}
      {entry.kind === "none" && <span className="srcTag">no database query</span>}
      {entry.connector && <span className="srcTag">{entry.connector}</span>}
      {entry.partition.mode && <span className="srcTag">{entry.partition.mode}</span>}
      {findings.length > 0 && (
        <span className="kpiTag low">
          {findings.length} note{findings.length === 1 ? "" : "s"}
        </span>
      )}
    </>
  );

  return (
    <Collapsible className="queryCard" summary={summary}>
      {entry.kind === "native" ? (
        <>
          <CodeEditor
            value={editing ? draft : (entry.sql ?? "")}
            language="sql"
            label={"SQL · " + entry.table}
            readOnly={!editing}
            onChange={editing ? setDraft : undefined}
            minHeight={200}
          />

          {error && <p className="advisory">{error}</p>}

          <div className="measureActions">
            {editing ? (
              <>
                <button className="go" disabled={draft === entry.sql} onClick={save}>
                  Save SQL change
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button className="go" onClick={startEdit}>
                ✎ Edit SQL
              </button>
            )}
          </div>

          <Findings findings={findings} />

          {entry.partition.sourceType === "m" && (
            <Collapsible className="nested" summary={<span>Full Power Query (M)</span>}>
              <CodeEditor
                value={entry.partition.expression ?? ""}
                language="m"
                label="Power Query (M)"
                readOnly
                minHeight={160}
              />
            </Collapsible>
          )}
        </>
      ) : (
        <>
          <p className="emptyNote">
            {entry.reason ??
              "Power Query assembles this table's statement when the report refreshes, so no SQL text exists in the file to show or edit."}
          </p>
          {entry.partition.expression && (
            <>
              <CodeEditor
                value={entry.partition.expression}
                language={entry.partition.sourceType === "calculated" ? "dax" : "m"}
                label={
                  entry.partition.sourceType === "calculated"
                    ? "Calculated table DAX"
                    : "Power Query (M)"
                }
                readOnly
                minHeight={160}
              />
              <p className="scoreNote">
                This is what the file actually contains. Editing it is done from the table&rsquo;s
                own panel, where the change can be checked against everything that reads the table.
              </p>
            </>
          )}
        </>
      )}
    </Collapsible>
  );
}

export function Queries({
  model,
  onApply,
}: {
  model: Model;
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
  const [only, setOnly] = useState(true);

  const all = useMemo(() => collectQueries(model), [model]);
  const columnsByTable = useMemo(
    () => new Map(model.tables.map((t) => [t.name, t.columns.map((c) => c.name)])),
    [model]
  );
  const needle = search.trim().toLowerCase();

  const shown = all.filter((entry) => {
    if (only && entry.kind !== "native") return false;
    if (!needle) return true;
    return `${entry.table} ${entry.sql ?? ""} ${entry.connector ?? ""}`
      .toLowerCase()
      .includes(needle);
  });

  const editable = all.filter((e) => e.kind === "native").length;

  if (!model.capabilities.model.available) {
    return (
      <article className="card placeholder">
        <span>⌗</span>
        <h2>Queries need the semantic model</h2>
        <p>
          A .pbix keeps its model in a compressed Analysis Services part that cannot be read in a
          browser, so there is no query text to show. Save the report as .pbit from Power BI
          Desktop and upload that instead.
        </p>
      </article>
    );
  }

  return (
    <article className="card explorer checksWide">
      <div className="toolbar">
        <div className="filter">
          ⌕{" "}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tables and SQL..."
          />
        </div>
        <button className={only ? "on" : ""} onClick={() => setOnly((v) => !v)}>
          {only ? "Editable SQL only" : "All sources"}
        </button>
        <button>
          {shown.length} of {only ? editable : all.length}
        </button>
      </div>

      <p className="scoreNote">
        {editable === 0
          ? "No table in this model carries a SQL statement in the file. Every source here is either folded by Power Query at refresh time or is not a database query at all — in both cases there is no statement to edit, and one will not be invented."
          : `${editable} of ${all.length} sources hold a SQL statement that can be edited here. The rest are folded by Power Query at refresh time, so the file contains no statement to show.`}
      </p>

      {shown.length === 0 ? (
        <p className="emptyNote">Nothing matches this filter.</p>
      ) : (
        shown.map((entry) => (
          <QueryCard
            key={`${entry.table}/${entry.partition.name}`}
            entry={entry}
            columns={columnsByTable.get(entry.table) ?? []}
            onApply={onApply}
          />
        ))
      )}
    </article>
  );
}
