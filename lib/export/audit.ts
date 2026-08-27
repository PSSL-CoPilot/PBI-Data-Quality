/**
 * Proving an exported file is the file we meant to produce.
 *
 * The method is one comparison, not a list of hopes: build the model the edits
 * were supposed to produce, re-open the archive that was actually written, and
 * check the second against the first. Anything the writer dropped, mangled or
 * quietly failed to apply shows up as a difference, including in the parts this
 * build would otherwise never look at again.
 *
 * Every check answers "is what came out what we intended", never "does what
 * came out look reasonable". A file that fails any check is not offered for
 * download: a Power BI file that opens and shows wrong numbers is worse than
 * one that never arrives.
 *
 * Nothing here measures speed. No check in this module claims a query is
 * faster, because nothing in this build ever runs one.
 */
import { validateReferences } from "../edit/session.ts";
import { allMeasures, type Model } from "../powerbi/model.ts";
import type { Change } from "../edit/apply.ts";

export interface AuditCheck {
  /** What was checked, in the reviewer's language. */
  name: string;
  ok: boolean;
  /** What was found. Always populated, pass or fail. */
  detail: string;
}

export interface AuditReport {
  ok: boolean;
  checks: AuditCheck[];
  /** Failed checks only, as sentences, for the refusal message. */
  problems: string[];
}

const pass = (name: string, detail: string): AuditCheck => ({ name, ok: true, detail });
const fail = (name: string, detail: string): AuditCheck => ({ name, ok: false, detail });

const measureKey = (m: { table: string; name: string }) => `${m.table}[${m.name}]`;
const columnKey = (c: { table: string; name: string }) => `${c.table}.${c.name}`;
const relKey = (r: {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;

const allColumnsOf = (model: Model) => model.tables.flatMap((t) => t.columns);
const allPartitionsOf = (model: Model) => model.tables.flatMap((t) => t.partitions);

/** `n item(s)`, without the parenthesis. */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "All 3 measures are" but "The 1 measure is" — a count of one reads badly. */
const all = (n: number, word: string) => (n === 1 ? `The ${count(n, word)}` : `All ${count(n, word)}`);
const verb = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);

/** At most `limit` names, with a tail count when there are more. */
function list(names: string[], limit = 4): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

/** Names present in `expected` but not in `actual`. */
function missing<T>(expected: Map<string, T>, actual: Map<string, T>): string[] {
  return [...expected.keys()].filter((key) => !actual.has(key));
}

function tablesCheck(expected: Model, actual: Model): AuditCheck {
  const want = new Map(expected.tables.map((t) => [t.name, t]));
  const got = new Map(actual.tables.map((t) => [t.name, t]));
  const gone = missing(want, got);
  // An extra table means the writer failed to remove one a consolidation
  // dropped, which leaves the duplicate in the file it was meant to leave.
  const extra = missing(got, want);

  if (gone.length === 0 && extra.length === 0) {
    return pass("Tables", `${all(want.size, "table")} ${verb(want.size, "is", "are")} present, and no others.`);
  }
  return fail(
    "Tables",
    [
      gone.length ? `Missing from the exported file: ${list(gone)}.` : "",
      extra.length ? `Present but not expected: ${list(extra)}.` : "",
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function columnsCheck(expected: Model, actual: Model): AuditCheck {
  const want = new Map(allColumnsOf(expected).map((c) => [columnKey(c), c]));
  const got = new Map(allColumnsOf(actual).map((c) => [columnKey(c), c]));
  const gone = missing(want, got);

  if (gone.length > 0) {
    return fail("Columns", `Missing from the exported file: ${list(gone)}.`);
  }

  // A data type that changed on the way out would silently change every
  // aggregation reading it.
  const retyped = [...want.entries()]
    .filter(([key, column]) => got.get(key)!.dataType !== column.dataType)
    .map(([key]) => key);

  if (retyped.length > 0) {
    return fail("Columns", `The data type changed on export for: ${list(retyped)}.`);
  }
  return pass("Columns", `${all(want.size, "column")} ${verb(want.size, "is", "are")} present with the expected data type.`);
}

function measuresCheck(expected: Model, actual: Model): AuditCheck {
  const want = new Map(allMeasures(expected).map((m) => [measureKey(m), m]));
  const got = new Map(allMeasures(actual).map((m) => [measureKey(m), m]));
  const gone = missing(want, got);

  if (gone.length > 0) {
    return fail("Measures", `Missing from the exported file: ${list(gone)}.`);
  }
  return pass("Measures", `${all(want.size, "measure")} ${verb(want.size, "is", "are")} present.`);
}

/**
 * DAX is compared with whitespace collapsed.
 *
 * Serialising TMSL can re-wrap an expression across lines without changing what
 * it computes, and failing an export over a line break would make the check
 * useless. Anything that survives that normalisation is a real difference.
 */
const normaliseDax = (dax: string) => dax.replace(/\s+/g, " ").trim();

function daxCheck(expected: Model, actual: Model): AuditCheck {
  const got = new Map(allMeasures(actual).map((m) => [measureKey(m), m]));
  const wrong = allMeasures(expected)
    .filter((m) => {
      const other = got.get(measureKey(m));
      return other && normaliseDax(other.expression) !== normaliseDax(m.expression);
    })
    .map(measureKey);

  if (wrong.length > 0) {
    return fail("Measure DAX", `The expression written out does not match the edit for: ${list(wrong)}.`);
  }
  return pass("Measure DAX", "Every expression in the file matches the edited version.");
}

/**
 * Calculated tables and calculated columns.
 *
 * These carry DAX that the model recomputes at refresh, so a mangled
 * expression here does not break the file — it changes the data in it.
 */
function calculatedCheck(expected: Model, actual: Model): AuditCheck {
  const gotTables = new Map(actual.tables.map((t) => [t.name, t]));
  const gotColumns = new Map(allColumnsOf(actual).map((c) => [columnKey(c), c]));

  const wrongTables = expected.tables
    .filter((t) => t.kind === "calculated" && t.expression)
    .filter((t) => {
      const other = gotTables.get(t.name);
      return !other || normaliseDax(other.expression ?? "") !== normaliseDax(t.expression!);
    })
    .map((t) => t.name);

  const wrongColumns = allColumnsOf(expected)
    .filter((c) => c.kind === "calculated" && c.expression)
    .filter((c) => {
      const other = gotColumns.get(columnKey(c));
      return !other || normaliseDax(other.expression ?? "") !== normaliseDax(c.expression!);
    })
    .map(columnKey);

  const total =
    expected.tables.filter((t) => t.kind === "calculated").length +
    allColumnsOf(expected).filter((c) => c.kind === "calculated").length;

  if (wrongTables.length || wrongColumns.length) {
    return fail(
      "Calculated tables and columns",
      [
        wrongTables.length ? `Calculated table DAX differs for: ${list(wrongTables)}.` : "",
        wrongColumns.length ? `Calculated column DAX differs for: ${list(wrongColumns)}.` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
  return total === 0
    ? pass("Calculated tables and columns", "This model has none.")
    : pass(
        "Calculated tables and columns",
        `${all(total, "calculated object")} kept ${verb(total, "its", "their")} expression.`
      );
}

function relationshipsCheck(expected: Model, actual: Model): AuditCheck {
  const want = new Map(expected.relationships.map((r) => [relKey(r), r]));
  const got = new Map(actual.relationships.map((r) => [relKey(r), r]));
  const gone = missing(want, got);

  if (gone.length > 0) {
    return fail("Relationships", `Missing from the exported file: ${list(gone)}.`);
  }

  // Direction and activity decide what a measure sees; a flipped flag is a
  // silent change to every number downstream of it.
  const altered = [...want.entries()]
    .filter(([key, rel]) => {
      const other = got.get(key)!;
      return (
        other.isActive !== rel.isActive ||
        other.crossFilteringBehavior !== rel.crossFilteringBehavior ||
        other.fromCardinality !== rel.fromCardinality ||
        other.toCardinality !== rel.toCardinality
      );
    })
    .map(([key]) => key);

  if (altered.length > 0) {
    return fail("Relationships", `Cardinality, direction or active state changed for: ${list(altered)}.`);
  }
  return pass(
    "Relationships",
    want.size === 0
      ? "This model has none."
      : `${all(want.size, "relationship")} kept ${verb(want.size, "its", "their")} endpoints, cardinality and direction.`
  );
}

/**
 * The SQL that actually reaches the database.
 *
 * An M partition holds its statement inside a connector call, so a rewrite has
 * to land at exactly the right offsets inside the surrounding script. This
 * check reads the statement back out of the exported file the same way the
 * parser does, so a rewrite that landed in the wrong place fails here rather
 * than at the customer's next refresh.
 */
function nativeSqlCheck(expected: Model, actual: Model): AuditCheck {
  const key = (p: { table: string; name: string }) => `${p.table}/${p.name}`;
  const got = new Map(allPartitionsOf(actual).map((p) => [key(p), p]));

  const withSql = allPartitionsOf(expected).filter((p) => p.nativeQuery?.kind === "native");
  const wrong = withSql
    .filter((p) => {
      const other = got.get(key(p));
      if (!other) return true;
      if (other.nativeQuery?.kind !== "native") return true;
      return normaliseDax(other.nativeQuery.sql ?? "") !== normaliseDax(p.nativeQuery!.sql ?? "");
    })
    .map((p) => `${p.table} (${p.name})`);

  if (wrong.length > 0) {
    return fail(
      "Native SQL",
      `The statement read back from the exported file does not match the edit for: ${list(wrong)}.`
    );
  }
  return withSql.length === 0
    ? pass("Native SQL", "No partition in this model carries a native statement.")
    : pass(
        "Native SQL",
        `${all(withSql.length, "native statement")} ${verb(withSql.length, "was", "were")} written back exactly as edited.`
      );
}

/**
 * Every field a visual binds still resolves in the model.
 *
 * A rename that updates the model but not the report leaves a visual pointing
 * at a name that no longer exists. Power BI does not refuse to open that file —
 * it drops the field, and the page renders with a figure quietly missing.
 */
function reportBindingsCheck(actual: Model): AuditCheck {
  const measures = new Set(allMeasures(actual).map((m) => m.name));
  const columns = new Set(allColumnsOf(actual).map((c) => c.name));
  const tables = new Set(actual.tables.map((t) => t.name));

  const dangling: string[] = [];
  for (const page of actual.pages) {
    for (const visual of page.visuals) {
      for (const ref of visual.refs) {
        if (ref.table && !tables.has(ref.table)) {
          dangling.push(`${page.displayName}: ${ref.table}[${ref.field}] — no such table`);
          continue;
        }
        if (ref.kind === "measure" && !measures.has(ref.field)) {
          dangling.push(`${page.displayName}: [${ref.field}] — no such measure`);
        } else if (ref.kind === "column" && !columns.has(ref.field)) {
          dangling.push(`${page.displayName}: [${ref.field}] — no such column`);
        }
      }
    }
  }

  const total = actual.pages.reduce(
    (sum, page) => sum + page.visuals.reduce((n, v) => n + v.refs.length, 0),
    0
  );

  if (dangling.length > 0) {
    return fail("Report bindings", `${list([...new Set(dangling)], 3)}.`);
  }
  return pass(
    "Report bindings",
    total === 0
      ? "No visual in this report binds a field."
      : `${all(total, "field binding")} across ${count(actual.pages.length, "page")} ${verb(total, "resolves", "resolve")}.`
  );
}

/**
 * Objects a rename should have produced, and the names it should have retired.
 *
 * Checking only that the new name exists would pass a file that contains both,
 * which is exactly what a half-applied rename looks like.
 */
function renamesCheck(actual: Model, expected: Model, changes: Change[]): AuditCheck {
  const renames = changes.filter((c) => c.field === "name" && c.before !== c.after);
  if (renames.length === 0) return pass("Renamed objects", "No object was renamed.");

  const names = (type: string) =>
    type === "measure"
      ? new Set(allMeasures(actual).map((m) => m.name))
      : type === "table"
        ? new Set(actual.tables.map((t) => t.name))
        : new Set(allColumnsOf(actual).map((c) => c.name));

  const problems: string[] = [];
  for (const change of renames) {
    const present = names(change.target.type);
    if (!present.has(change.after)) {
      problems.push(`"${change.after}" is not in the exported file`);
      continue;
    }
    // The old name may legitimately survive on a different object; only a
    // leftover the edited model does not expect is a failure.
    const stillExpected =
      change.target.type === "measure"
        ? allMeasures(expected).some((m) => m.name === change.before)
        : change.target.type === "table"
          ? expected.tables.some((t) => t.name === change.before)
          : allColumnsOf(expected).some((c) => c.name === change.before);

    if (present.has(change.before) && !stillExpected) {
      problems.push(`"${change.before}" is still in the exported file alongside "${change.after}"`);
    }
  }

  if (problems.length > 0) return fail("Renamed objects", `${list(problems, 3)}.`);
  return pass(
    "Renamed objects",
    `${all(renames.length, "rename")} ${verb(renames.length, "is", "are")} present under the new name, with the old name retired.`
  );
}

/**
 * Measures that referenced a renamed object.
 *
 * A rename that updates the definition but not its callers produces DAX that
 * calls something no longer there — the measure errors in every visual using
 * it, and the report author is told nothing until they open the file.
 */
function dependentsCheck(actual: Model, changes: Change[]): AuditCheck {
  const renamedMeasures = changes
    .filter((c) => c.field === "name" && c.target.type === "measure" && c.before !== c.after)
    .map((c) => c.before);

  if (renamedMeasures.length === 0) {
    return pass("Dependent measures", "No measure was renamed, so nothing depended on a change.");
  }

  const stale: string[] = [];
  for (const measure of allMeasures(actual)) {
    for (const old of renamedMeasures) {
      // `[Name]` as DAX writes it — a bare word would match a column too.
      if (measure.expression.includes(`[${old}]`)) {
        stale.push(`${measureKey(measure)} still calls [${old}]`);
      }
    }
  }

  if (stale.length > 0) return fail("Dependent measures", `${list(stale, 3)}.`);
  return pass(
    "Dependent measures",
    `No measure still calls ${verb(renamedMeasures.length, "the old name", `any of the ${count(renamedMeasures.length, "old name")}`)}.`
  );
}

/**
 * A consolidation that was applied this session.
 *
 * Consolidation redirects DAX at the table the merge keeps; it does not delete
 * the duplicates, because a deletion that turns out to be wrong cannot be
 * undone from inside the exported file. So the thing to verify is the
 * redirection: the canonical table is there, and nothing that was redirected
 * still points at a table the merge moved away from.
 *
 * The duplicates deliberately remain in the file. That is not a failure, and
 * saying so here stops the check reading as a half-finished job.
 */
function consolidationCheck(actual: Model, changes: Change[]): AuditCheck {
  const intents = changes.map((c) => c.intent).filter((i) => i?.kind === "consolidation");
  if (intents.length === 0) {
    return pass("Consolidated tables", "No table was consolidated in this session.");
  }

  const canonicals = [...new Set(intents.map((i) => i!.canonical))];
  const replaced = [...new Set(intents.flatMap((i) => i!.replaced))];
  const present = new Set(actual.tables.map((t) => t.name));

  const lost = canonicals.filter((name) => !present.has(name));
  if (lost.length > 0) {
    return fail(
      "Consolidated tables",
      `The table the merge kept is missing from the exported file: ${list(lost)}.`
    );
  }

  // A qualified reference to a replaced table means a redirect did not land.
  const stale: string[] = [];
  const expressions = [
    ...allMeasures(actual).map((m) => [measureKey(m), m.expression] as const),
    ...allColumnsOf(actual)
      .filter((c) => c.kind === "calculated" && c.expression)
      .map((c) => [columnKey(c), c.expression!] as const),
  ];

  for (const [key, expression] of expressions) {
    for (const table of replaced) {
      if (expression.includes(`'${table}'[`) || expression.includes(`${table}[`)) {
        stale.push(`${key} still reads ${table}`);
      }
    }
  }

  if (stale.length > 0) return fail("Consolidated tables", `${list(stale, 3)}.`);

  return pass(
    "Consolidated tables",
    `Every reference now reads ${list(canonicals)}. ${count(
      replaced.length,
      "duplicate table"
    )} ${verb(replaced.length, "is", "are")} left in the file on purpose, so the merge can be undone there.`
  );
}

/**
 * References that were fine before and are broken now.
 *
 * A file can arrive with problems of its own. Failing an export over one the
 * user did not cause would make the export unusable and teach them to ignore
 * the message, so only newly introduced breakage counts.
 */
function newBreakageCheck(original: Model, actual: Model): AuditCheck {
  const before = new Set(validateReferences(original).problems.map((p) => p.id));
  const introduced = validateReferences(actual).problems.filter((p) => !before.has(p.id));

  if (introduced.length > 0) {
    return fail(
      "Broken references",
      list(
        introduced.map(
          (p) =>
            `${p.target.table ? `${p.target.table}[${p.target.name}]` : p.target.name} — ${p.detail}`
        ),
        3
      )
    );
  }
  return pass(
    "Broken references",
    before.size > 0
      ? `No new broken reference. ${count(before.size, "problem")} already in the uploaded file ${verb(before.size, "was", "were")} left as ${verb(before.size, "it", "they")} ${verb(before.size, "was", "were")}.`
      : "No broken reference anywhere in the exported file."
  );
}

/**
 * The full audit of an exported file.
 *
 * `original` is the uploaded model, `expected` is that model with every change
 * applied, and `actual` is what was parsed back out of the archive that was
 * just written.
 */
export function auditExport(
  original: Model,
  expected: Model,
  actual: Model,
  changes: Change[]
): AuditReport {
  const checks: AuditCheck[] = [
    tablesCheck(expected, actual),
    columnsCheck(expected, actual),
    measuresCheck(expected, actual),
    daxCheck(expected, actual),
    calculatedCheck(expected, actual),
    relationshipsCheck(expected, actual),
    nativeSqlCheck(expected, actual),
    reportBindingsCheck(actual),
    renamesCheck(actual, expected, changes),
    dependentsCheck(actual, changes),
    consolidationCheck(actual, changes),
    newBreakageCheck(original, actual),
  ];

  const problems = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return { ok: problems.length === 0, checks, problems };
}
