/* eslint-disable jsx-a11y/no-autofocus */
import { useEffect, useMemo, useState } from "react";

import { ExtractionError, extractFile, type RawSources } from "../lib/powerbi/extract.ts";
import { listVersions, saveVersion } from "../lib/history.ts";
import type {
  Capability,
  CapabilityId,  Model,
  ObjectType,} from "../lib/powerbi/model.ts";
import { allColumns, allMeasures, allVisuals } from "../lib/powerbi/model.ts";
import {
  runQa,
  scoreLabel,
  SEVERITY_ORDER,
  topProblems,
  type Category,
  type Finding,
  type FindingTarget,
  type QaResult,
  type Severity,
} from "../lib/qa/engine.ts";
import {
  optimizationLabel,
  runOptimization,
  type OptimizationResult,
} from "../lib/optimize/engine.ts";
import {
  addChange,
  newSession,
  revertAll,
  revertChange,
  undoLast,
  workingModel,
  type Change,
  type EditSession,
} from "../lib/edit/session.ts";
import { Changes } from "./Changes.tsx";
import { Measures } from "./Measures.tsx";
import { Tables } from "./Tables.tsx";
import { useCollapsibleNav, useTheme } from "./theme.tsx";
import { Optimization } from "./Optimization.tsx";
import { Head, ScoreBars, ScoreRing } from "./ui.tsx";

type View =
  | "Overview"
  | "Tables"
  | "Measures"
  | "Quality Checks"
  | "Optimization"
  | "Changes"
  | "Issues"
  | "Team"
  | "Project Settings";

const NAV: View[] = [
  "Overview",
  "Measures",
  "Tables",
  "Quality Checks",
  "Issues",
  "Optimization",
  "Changes",
  "Team",
  "Project Settings",
];
const ICONS = ["◫", "ƒ", "▦", "✓", "!", "◎", "⎋", "♙", "⚙"];

/** Views that cannot render anything truthful without a semantic model. */
/*
 * Views that genuinely cannot render without a semantic model.
 *
 * Measures is deliberately absent: its By Report view is built from report
 * bindings, which a .pbix does expose, so blocking the whole screen hid
 * information the file actually contained.
 */
const NEEDS_MODEL: View[] = [];

const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  model: "Semantic model",
  report: "Report layout",
  powerQuery: "Power Query / source queries",
  runtime: "Query execution",
};

/** Severity mapped to the existing `.sev` badge modifiers. */
const SEVERITY_CLASS: Record<Severity, string> = {
  critical: "",
  high: "s1",
  medium: "s2",
  low: "s3",
};

type Focus = { type: ObjectType; name: string; table?: string; page?: string } | null;

export default function App() {
  const [active, setActive] = useState<View>("Overview");
  const [session, setSession] = useState<EditSession | null>(null);
  // The original archive and its parsed documents, needed to write an export.
  const [raw, setRaw] = useState<RawSources | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [search, setSearch] = useState(false);
  const [upload, setUpload] = useState(false);
  const [notice, setNotice] = useState("");
  const theme = useTheme();
  const rail = useCollapsibleNav();

  // The working model is derived by replaying the change list over the
  // untouched original, so every view reflects pending edits immediately.
  const working = useMemo(() => (session ? workingModel(session) : null), [session]);
  const model = working?.model ?? null;

  // QA and optimization are pure functions of the model, so neither needs a
  // separate "run" state; both recompute when the working model changes.
  const qa = useMemo(() => (model ? runQa(model) : null), [model]);
  const opt = useMemo(() => (model ? runOptimization(model) : null), [model]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);
      }
      if (e.key === "Escape") setSearch(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const analyzed = (next: Model, sources: RawSources, message: string) => {
    setSession(newSession(next));
    setRaw(sources);
    setFocus(null);
    setUpload(false);
    setActive("Overview");
    setNotice(message);
    setTimeout(() => setNotice(""), 5000);
  };

  /** Jump from a finding straight to the object it is about. */
  const goTo = (target: FindingTarget) => {
    if (target.type === "measure") setActive("Measures");
    else if (target.type === "table" || target.type === "column") setActive("Tables");
    else if (target.type === "relationship") setActive("Tables");
    else setActive("Measures");

    setFocus(
      target.type === "column" && target.table
        ? { type: "table", name: target.table }
        : { type: target.type, name: target.name, table: target.table, page: target.page }
    );
  };

  const goToView = (view: View) => {
    setActive(view);
    setFocus(null);
  };

  const subtitle = model
    ? `${model.source.fileName} · ${model.source.format.toUpperCase()} · ${(
        model.source.sizeBytes / 1048576
      ).toFixed(1)} MB`
    : "No file analyzed yet";

  return (
    <main className={rail.collapsed ? "shell railClosed" : "shell"}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">P</span>
          <span>
            PBI Quality <b>Studio</b>
          </span>
        </div>
        <button
          className="railToggle"
          onClick={rail.toggle}
          aria-label={rail.collapsed ? "Expand navigation" : "Collapse navigation"}
          title={rail.collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {rail.collapsed ? "»" : "«"} <span className="railLabel">&nbsp;Collapse</span>
        </button>
        <button className="workspace">
          <span className="workspaceIcon">N</span>
          <span>
            <small>Workspace</small>
            {model ? model.source.fileName : "No model loaded"}
          </span>
          <span>⌄</span>
        </button>
        <nav>
          {NAV.map((view, i) => (
            <button
              className={active === view ? "active" : ""}
              onClick={() => goToView(view)}
              key={view}
              title={view}
            >
              <span>{ICONS[i]}</span>
              <span className="navLabel">{view}</span>
              {view === "Quality Checks" && qa && qa.findings.length > 0 && (
                <em>{qa.findings.length}</em>
              )}
              {view === "Optimization" && opt && opt.opportunities.length > 0 && (
                <em>{opt.opportunities.length}</em>
              )}
              {view === "Changes" && session && session.changes.length > 0 && (
                <em>{session.changes.length}</em>
              )}
            </button>
          ))}
        </nav>
        {qa && (
          <div className="health">
            <div>{qa.overall ?? "—"}</div>
            <span>
              <b>Quality score</b>
              <small>{scoreLabel(qa.overall)}</small>
            </span>
          </div>
        )}
        {opt && (
          <div className="health" style={{ marginTop: 8 }}>
            <div>{opt.overall ?? "—"}</div>
            <span>
              <b>Optimization</b>
              <small>{optimizationLabel(opt.overall)}</small>
            </span>
          </div>
        )}
      </aside>

      <section className="main">
        <header>
          <div>
            <small>Projects / {model ? model.source.fileName : "—"}</small>
            <h1>
              PBI Quality <i>Studio</i>
            </h1>
            <p>{subtitle}</p>
          </div>
          <div className="actions">
            <button className="search" onClick={() => setSearch(true)}>
              ⌕ <span>Search anything...</span>
              <kbd>⌘ K</kbd>
            </button>
            <button className="primary" onClick={() => setUpload(true)}>
              ↑ Upload Power BI file
            </button>
            <button
              className="iconBtn"
              onClick={theme.toggle}
              title={`Switch to ${theme.resolved === "dark" ? "light" : "dark"} mode`}
              aria-label={`Switch to ${theme.resolved === "dark" ? "light" : "dark"} mode`}
            >
              {theme.resolved === "dark" ? "☀" : "☾"}
            </button>
            <div className="avatar">SP</div>
          </div>
        </header>

        <div className="content">
          <div className="title">
            <div>
              <h2>{active}</h2>
              <p>
                {model
                  ? "Extracted from your file. Nothing on this screen is sample data."
                  : "Upload a .pbit, .pbip or .pbix file to begin."}
              </p>
            </div>
          </div>

          {model && <ModelUnavailableBanner model={model} />}

          {!model || !qa || !opt || !session || !working ? (
            <EmptyState onUpload={() => setUpload(true)} />
          ) : (
            <Views
              view={active}
              model={model}
              qa={qa}
              opt={opt}
              session={session}
              working={working}
              raw={raw}
              focus={focus}
              goTo={goTo}
              onApply={(changes) => {
                setSession((current) =>
                  current ? changes.reduce(addChange, current) : current
                );
                setNotice(
                  `${changes.length} change${changes.length === 1 ? "" : "s"} applied — review them in Changes`
                );
                setTimeout(() => setNotice(""), 5000);
              }}
              onUndo={() => setSession((c) => (c ? undoLast(c) : c))}
              onRevert={(id) => setSession((c) => (c ? revertChange(c, id) : c))}
              onRevertAll={() => setSession((c) => (c ? revertAll(c) : c))}
            />
          )}
        </div>
      </section>

      {search && <Search close={() => setSearch(false)} model={model} />}
      {upload && <Upload close={() => setUpload(false)} onAnalyzed={analyzed} />}
      {notice && <div className="toast">✓ {notice}</div>}
    </main>
  );
}

/** Dismiss only when the backdrop itself is clicked, not the dialog inside it. */
const onBackdrop = (close: () => void) => (event: React.MouseEvent<HTMLDivElement>) => {
  if (event.target === event.currentTarget) close();
};

/** Modal dialogs must be dismissible from the keyboard, not just by clicking. */
function useEscape(close: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close]);
}

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <article className="card placeholder">
      <span>◫</span>
      <h2>No Power BI file analyzed</h2>
      <p>
        Upload a .pbit template or .pbip project for full model analysis, or a .pbix for report-layer
        analysis. Files are read in your browser and never uploaded.
      </p>
      <button className="primarySmall" onClick={onUpload}>
        ↑ Upload Power BI file
      </button>
    </article>
  );
}

/**
 * The single most common confusion: a .pbix hides its model, so measures, DAX,
 * columns, relationships and SQL are all simply absent. Users hit this and
 * conclude the feature is broken, so the banner leads with what is missing and
 * the exact steps to fix it, in plain words, with no file-format vocabulary
 * before the reader needs it.
 */
function ModelUnavailableBanner({ model }: { model: Model }) {
  if (model.capabilities.model.available) return null;

  return (
    <div className="limitBanner">
      <span className="limitIcon">!</span>
      <div>
        <h3>Only half of this file could be read</h3>
        <p>
          Power BI keeps the <b>data model</b> of a <code>.pbix</code> in a sealed section that
          only Power BI Desktop can open. Nothing here can unlock it, so this file gives you the
          report but not the model behind it.
        </p>

        <div className="haveWant">
          <div>
            <small>AVAILABLE NOW</small>
            <ul>
              <li>Report pages and visuals</li>
              <li>Which fields each visual uses</li>
              <li>Likely KPI names</li>
              <li>Report and page quality checks</li>
            </ul>
          </div>
          <div>
            <small>NEEDS THE FULL FILE</small>
            <ul>
              <li>Measures and their DAX</li>
              <li>Tables, columns and relationships</li>
              <li>SQL and Power Query source queries</li>
              <li>Editing, optimizing and exporting</li>
            </ul>
          </div>
        </div>

        <b className="fixTitle">To unlock everything — about 20 seconds</b>
        <ol>
          <li>Open this file in Power BI Desktop.</li>
          <li>
            Click <b>File</b> → <b>Export</b> → <b>Power BI template</b>.
          </li>
          <li>Save it, then upload that file here instead.</li>
        </ol>
        <p className="fixNote">
          A template holds the same model but in a readable form. It contains no data rows, only
          the structure, so it is also much smaller.
        </p>
      </div>
    </div>
  );
}

function CapabilityNotice({ capability, label }: { capability: Capability; label: string }) {
  if (capability.available) return null;
  return (
    <div className="unavailable">
      <b>{label} unavailable</b>
      <p>{capability.reason}</p>
    </div>
  );
}

interface ViewProps {
  model: Model;
  qa: QaResult;
  opt: OptimizationResult;
  session: EditSession;
  working: ReturnType<typeof workingModel>;
  raw: RawSources | null;
  focus: Focus;
  goTo: (target: FindingTarget) => void;
  onApply: (changes: Change[]) => void;
  onUndo: () => void;
  onRevert: (changeId: string) => void;
  onRevertAll: () => void;
}

function Views({ view, ...props }: ViewProps & { view: View }) {
  const { model } = props;

  if (NEEDS_MODEL.includes(view) && !model.capabilities.model.available) {
    return (
      <article className="card">
        <Head over={view.toUpperCase()} title="Requires the semantic model" />
        <CapabilityNotice capability={model.capabilities.model} label={CAPABILITY_LABELS.model} />
      </article>
    );
  }

  switch (view) {
    case "Overview":
      return <Overview {...props} />;
    case "Quality Checks":
      return <QualityChecks {...props} />;
    case "Optimization":
      return <Optimization opt={props.opt} goTo={props.goTo} onApply={props.onApply} />;
    case "Changes":
      return (
        <Changes
          session={props.session}
          working={props.working}
          raw={props.raw}
          onUndo={props.onUndo}
          onRevert={props.onRevert}
          onRevertAll={props.onRevertAll}
        />
      );
    case "Tables":
      return (
        <Tables
          key={focusKey(props.focus)}
          model={model}
          focus={props.focus}
          onApply={props.onApply}
        />
      );
    case "Measures":
      return (
        <Measures
          key={focusKey(props.focus)}
          model={model}
          focus={props.focus}
          opt={props.opt}
          onApply={props.onApply}
        />
      );
    default:
      return (
        <article className="card placeholder">
          <span>{ICONS[NAV.indexOf(view)]}</span>
          <h2>{view}</h2>
          <p>
            Optimization, editing, validation and export are the next stages of this build and are
            not implemented yet, so nothing is shown here rather than placeholder data.
          </p>
        </article>
      );
  }
}

/** Changing this remounts an explorer, which reopens it on the focused object. */
const focusKey = (focus: Focus) => (focus ? `${focus.type}:${focus.table ?? ""}:${focus.name}` : "none");

function FindingRow({ finding, goTo }: { finding: Finding; goTo: (t: FindingTarget) => void }) {
  const open = () => goTo(finding.target);
  return (
    <div
      className="finding findingRow"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <i className={`sev ${SEVERITY_CLASS[finding.severity]}`}>{finding.severity}</i>
      <div>
        <b>
          {finding.target.table
            ? `${finding.target.table}[${finding.target.name}]`
            : finding.target.name}
        </b>
        <p>{finding.detail}</p>
        <small>
          {finding.category} · {finding.ruleId} · {finding.recommendation}
        </small>
      </div>
      <span aria-hidden="true">›</span>
    </div>
  );
}

function Overview({ model, qa, goTo }: ViewProps) {
  const hasModel = model.capabilities.model.available;
  const dash = "—";

  const stats: Array<[string, string, string]> = [
    ["Tables", hasModel ? String(model.tables.length) : dash, hasModel ? "" : "needs model"],
    ["Columns", hasModel ? String(allColumns(model).length) : dash, hasModel ? "" : "needs model"],
    ["Measures", hasModel ? String(allMeasures(model).length) : dash, hasModel ? "" : "needs model"],
    [
      "Relationships",
      hasModel ? String(model.relationships.length) : dash,
      hasModel ? "" : "needs model",
    ],
    [
      "Report pages",
      String(model.pages.length),
      `${model.pages.filter((p) => p.isHidden).length} hidden`,
    ],
    ["Visuals", String(allVisuals(model).length), `across ${model.pages.length} pages`],
  ];

  const top = topProblems(qa);

  return (
    <>
      <div className="stats">
        {stats.map(([label, value, note], i) => (
          <article key={label}>
            <span className={`stat c${i}`}>{["▦", "▥", "ƒ", "⌁", "▤", "◈"][i]}</span>
            <div>
              <small>{label}</small>
              <strong>{value}</strong>
              <em>{note}</em>
            </div>
          </article>
        ))}
      </div>

      <div className="grid">
        <article className="card quality">
          <Head over="OVERALL QUALITY" title="Quality score" />
          <div className="qualityTop">
            <ScoreRing score={qa.overall} />
            <div>
              <i>
                {scoreLabel(qa.overall)}
                {qa.skipped.length > 0 && " · partial"}
              </i>
              <h3>
                {qa.findings.length} finding{qa.findings.length === 1 ? "" : "s"}
              </h3>
              <p>
                {qa.rulesRun} rule{qa.rulesRun === 1 ? "" : "s"} evaluated
                {qa.skipped.length > 0 &&
                  `, ${qa.skipped.length} skipped because this file did not expose what they need`}
                .
              </p>
            </div>
          </div>
          <ScoreBars
          bars={qa.categories.map((c) => ({
            label: c.category,
            score: c.score,
            reason: c.reason,
          }))}
        />
        </article>

        <article className="card">
          <Head over="PRIORITY QUEUE" title="Needs attention" />
          {top.length === 0 ? (
            <p>No findings. Every rule that could run passed.</p>
          ) : (
            top.map((finding) => <FindingRow key={finding.id} finding={finding} goTo={goTo} />)
          )}
        </article>
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <article className="card">
          <Head over="EXTRACTION" title="What this file exposed" />
          {(Object.keys(CAPABILITY_LABELS) as CapabilityId[]).map((id) => (
            <div className="finding" key={id}>
              <i className={`sev ${model.capabilities[id].available ? "s2" : ""}`}>
                {model.capabilities[id].available ? "ok" : "none"}
              </i>
              <div>
                <b>{CAPABILITY_LABELS[id]}</b>
                <p>
                  {model.capabilities[id].available
                    ? "Read directly from the uploaded file."
                    : (model.capabilities[id] as { reason: string }).reason}
                </p>
              </div>
            </div>
          ))}
        </article>

        <article className="card">
          <Head over="EXTRACTION NOTES" title={`${model.warnings.length} warning(s)`} />
          {model.warnings.length === 0 ? (
            <p>No extraction warnings. Every part this build understands was parsed.</p>
          ) : (
            model.warnings.map((warning) => (
              <div className="finding" key={warning}>
                <i className="sev s2">note</i>
                <div>
                  <p>{warning}</p>
                </div>
              </div>
            ))
          )}
        </article>
      </div>
    </>
  );
}

function QualityChecks({ qa, goTo }: ViewProps) {
  const [category, setCategory] = useState<Category | "All">("All");
  const [severity, setSeverity] = useState<Severity | "All">("All");

  const shown = qa.findings.filter(
    (f) =>
      (category === "All" || f.category === category) &&
      (severity === "All" || f.severity === severity)
  );

  return (
    <div className="checks">
      <article className="card ruleSummary">
        <Head
          over="AUTOMATED QA"
          title={`${qa.rulesRun} rules evaluated · ${qa.findings.length} finding${
            qa.findings.length === 1 ? "" : "s"
          }`}
        />
        <div className="qualityTop">
          <ScoreRing score={qa.overall} />
          <div>
            <i>
              {scoreLabel(qa.overall)}
              {qa.categories.some((c) => c.score === null) && " · partial"}
            </i>
            <p>
              The mean of the categories that could be assessed. A category whose rules could not
              run scores nothing at all, rather than defaulting to a pass.
            </p>
          </div>
        </div>
        <ScoreBars
          bars={qa.categories.map((c) => ({
            label: c.category,
            score: c.score,
            reason: c.reason,
          }))}
        />

        <div className="counts">
          {SEVERITY_ORDER.map((level) => (
            <div key={level}>
              <b>{qa.counts[level]}</b>
              <small>{level}</small>
            </div>
          ))}
        </div>

        <p className="scoreNote">
          Each score is the share of that category&rsquo;s objects with no problem, weighted by the
          worst problem on each: a critical finding writes an object off entirely, high counts 0.6,
          medium 0.3, low 0.1. Totalling penalties instead sent every large report to zero
          regardless of how good it was.
        </p>
      </article>

      <article className="card explorer checksWide">
        <div className="toolbar">
          <div className="filter">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category | "All")}
            >
              <option value="All">All categories</option>
              {qa.categories.map((c) => (
                <option key={c.category} value={c.category}>
                  {c.category}
                </option>
              ))}
            </select>
          </div>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "All")}>
            <option value="All">All severities</option>
            {SEVERITY_ORDER.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <button>
            {shown.length} of {qa.findings.length}
          </button>
        </div>

        {shown.length === 0 ? (
          <p>No findings match this filter.</p>
        ) : (
          shown.map((finding) => <FindingRow key={finding.id} finding={finding} goTo={goTo} />)
        )}
      </article>

      {qa.skipped.length > 0 && (
        <article className="card checksWide">
          <Head over="NOT RUN" title={`${qa.skipped.length} rules skipped`} />
          <div className="unavailable">
            <b>These rules could not run on this file</b>
            <p>{qa.skipped[0].reason}</p>
          </div>
          <ul className="notAssessed">
            {qa.skipped.map((rule) => (
              <li key={rule.ruleId}>
                {rule.category} · {rule.ruleId} — {rule.title}
              </li>
            ))}
          </ul>
        </article>
      )}

      <article className="card checksWide">
        <Head over="OUT OF SCOPE" title="Not assessed by any rule" />
        <ul className="notAssessed">
          {qa.notAssessed.map((item) => (
            <li key={item.check}>
              {item.category} · {item.check}
            </li>
          ))}
        </ul>
        <p className="scoreNote">
          These need a live query engine. Nothing is executed against the model in this build, so
          they are neither checked nor scored.
        </p>
      </article>
    </div>
  );
}

function Search({ close, model }: { close: () => void; model: Model | null }) {
  const [query, setQuery] = useState("");
  useEscape(close);

  const results = useMemo(() => {
    if (!model) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const items = [
      ...model.tables.map((t) => ["▦", t.name, "Table"] as const),
      ...allMeasures(model).map((m) => ["ƒ", m.name, `Measure · ${m.table}`] as const),
      ...model.pages.map((p) => ["▤", p.displayName, "Report page"] as const),
    ];
    return items.filter(([, label]) => label.toLowerCase().includes(needle)).slice(0, 12);
  }, [model, query]);

  return (
    <div className="overlay" role="presentation" onMouseDown={onBackdrop(close)}>
      <div className="command" role="dialog" aria-modal="true" aria-label="Search the model">
        <div className="commandInput">
          ⌕
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tables, measures and pages..."
          />
          <kbd>ESC</kbd>
        </div>
        <small>{model ? "RESULTS" : "UPLOAD A FILE FIRST"}</small>
        {results.map(([icon, label, kind]) => (
          <button key={`${kind}-${label}`}>
            <i>{icon}</i>
            <b>{label}</b>
            <span>{kind}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Upload({
  close,
  onAnalyzed,
}: {
  close: () => void;
  onAnalyzed: (model: Model, raw: RawSources, message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [history] = useState(() => listVersions());
  useEscape(close);

  const analyze = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { model, raw, sha256 } = await extractFile(file);
      const qa = runQa(model);

      // Storage can be unavailable in private mode, which must not lose the
      // analysis; it is already complete in memory either way.
      const stored = saveVersion({
        fileName: model.source.fileName,
        sha256,
        format: model.source.format,
        status: model.capabilities.model.available ? "model+report" : "report-only",
        overall: qa.overall,
        findings: qa.findings.length,
      });

      const scope = model.capabilities.model.available
        ? "model and report"
        : "report layer only, model not readable";
      onAnalyzed(
        model,
        raw,
        `Analyzed ${model.source.fileName} — ${scope}${
          stored ? "" : " (history not saved)"
        }`
      );
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "Analysis failed.",
        detail: err instanceof ExtractionError ? err.detail : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={onBackdrop(close)}>
      <div
        className="modal uploadModal"
        role="dialog"
        aria-modal="true"
        aria-label="Analyze a Power BI file"
      >
        <div className="modalHead">
          <div>
            <small>NEW MODEL VERSION</small>
            <h2>Analyze a Power BI file</h2>
          </div>
          <button onClick={close}>×</button>
        </div>

        {busy ? (
          <div className="analyzing">
            <div className="spinner" />
            <h3>Reading {file?.name}…</h3>
            <p>Parsing the archive in your browser. The file is not uploaded.</p>
            <div>
              <i />
            </div>
          </div>
        ) : error ? (
          <div className="analysisError">
            <span>!</span>
            <h3>{error.message}</h3>
            {error.detail && <p>{error.detail}</p>}
            <button onClick={() => setError(null)}>Try again</button>
            <button className="primarySmall" onClick={close}>
              Close
            </button>
          </div>
        ) : (
          <>
            <label className="drop">
              <input
                type="file"
                accept=".pbit,.pbix,.pbip,.zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span>↑</span>
              <h3>{file ? file.name : "Drop your .pbit, .pbip or .pbix here"}</h3>
              <p>
                {file
                  ? `${(file.size / 1048576).toFixed(1)} MB ready to analyze`
                  : "or click to choose a file"}
              </p>
            </label>

            <div className="extractorNote">
              <b>.pbit and .pbip give the full model</b>
              <p>
                A .pbix keeps its semantic model in a binary Analysis Services part that only Power
                BI Desktop can open, so a .pbix is analyzed at the report layer only. Export as a
                template (File → Export → Power BI template) for measures, DAX and relationships.
              </p>
            </div>

            {history.length > 0 && (
              <div className="objectList">
                <h3>Previously analyzed on this browser</h3>
                {history.slice(0, 4).map((version) => (
                  <div key={version.id}>
                    ◇ {version.fileName} · {version.format.toUpperCase()} · score{" "}
                    {version.overall ?? "—"} · {version.findings} findings
                  </div>
                ))}
              </div>
            )}

            <div className="modalFoot">
              <button onClick={close}>Cancel</button>
              <button className="primarySmall" disabled={!file} onClick={analyze}>
                Analyze file
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
