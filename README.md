# PBI Quality Studio

Power BI model quality, DAX review, report usage, dependency analysis and
automated QA. It is a **static site with no backend**: your file is read in the
browser and never uploaded anywhere.

## Run locally

1. Install Node.js 22+ and run `npm install`.
2. Run `npm run dev` and open the displayed URL.

## What works today

Upload a Power BI file and it is parsed in your browser. You get real tables,
columns, measures with their DAX, relationships, Power Query/M and native SQL
partitions, report pages, visuals, and which pages, visuals and measures
reference a given measure.

Which of those you get depends on the format:

- **`.pbit` / `.pbip`** — full semantic model and report.
- **`.pbix`** — report layer only. A `.pbix` keeps its model in a binary
  Analysis Services part that only Power BI Desktop can open, so the model is
  reported as unavailable with the reason. To analyze the model, export from
  Power BI Desktop with **File → Export → Power BI template**.

Nothing on screen is sample data. Where a value could not be read, the UI shows
why instead of a number.

### Measures

Three views of the same set:

- **All** — every measure, with its likely KPI name and source tables.
- **By Report** — grouped under the report page whose visuals bind them,
  collapsible, including a group for measures no page uses and a list of
  bindings that point at measures missing from the model.
- **By PBI Table** — grouped under the table the DAX actually reads, not the
  home table, so measures parked in a shared `Measures` table still appear
  under `Orders` or `Customer`. A primary table is only claimed when one
  clearly dominates.

**Likely KPI names** are inferred from report layout: a visual title where there
is one, otherwise the nearest caption above or beside the visual. Always shown
as *Likely*, with the evidence (which page, which source, how many pixels away)
on hover, because nothing in the file states the link.

### Automated QA and the quality score

23 rules across DAX, Model, Relationship, Report and Data quality produce a
score per category plus an overall score, with critical/high/medium/low counts
and a priority queue. Every finding names the object it is about, and clicking
it opens that measure, table, relationship or page.

A rule that cannot run is reported as **skipped with a reason**, and its
category scores nothing rather than defaulting to a pass — so a report-only
PBIX shows "—" for DAX, not 100. Checks that would need a live query engine
(row counts, cardinality, render timings) are listed as out of scope rather
than silently omitted.

### Optimization

20 rules across DAX, Model, Relationship and Visual optimization produce an
optimization score per category, opportunities ranked by impact, and a **page
complexity score** whose contributions are all shown so the number can be
argued with.

Where a rewrite can be generated mechanically and then validated, the
opportunity carries **Current DAX → Suggested DAX** with its reason,
recommendation, impact and confidence. Everything else stays advice without
generated code.

Nothing is ever executed or timed, so no rewrite claims to be faster and
performance hotspots are reported as *not assessed* rather than estimated.

### Optimization actions

Recommendations carrying a validated rewrite get a one-click **Optimize** that
applies the DAX to the working model, revalidates, and lands in Changes where it
can be undone. **Select all safe optimizations** and **Optimize selected** apply
several at once and report what was applied and what was skipped.

Advisory findings have no Optimize button at all, so an uncertain suggestion
cannot be written into the model by a stray click.

### Editing and the change workspace

Measures, tables, columns and Power Query/native queries can be edited in place:
rename, change DAX, description, format string, or move a measure to another
home table.

A rename is **dependency-aware**. Before it can be applied the UI shows exactly
what it touches — report pages, visuals, dependent measures, relationships and
queries — along with anything the rewrite cannot resolve automatically. Applying
it rewrites dependent DAX, relationship keys and report bindings together.

The uploaded model is never modified. Changes are held as a list and the working
model is derived by replaying them, so Undo, Revert and Revert-all are exact.
The **Changes** view shows each edit with an Original/Modified diff, the
quality and optimization scores before and after, and any broken references the
edits introduced.

### Export

Changes can be written back into an updated `.pbit` / `.pbip`. The original
archive is repacked with only the two changed documents replaced, so annotations,
lineage tags, diagram layout, themes and static resources all survive untouched.

The exported file is then **re-opened and re-validated before it is offered**.
If a renamed object is missing, or the round trip introduced a broken reference,
you get the reason instead of a download. The export is named
`<original> (edited).pbit` so it can never overwrite your file.

Open the result in Power BI Desktop and save as `.pbix` from there. Writing a
`.pbix` directly is not possible for the same reason reading one is not: its
model is a binary Analysis Services part.

### Version history

A summary of each analysis (file name, hash, format, score, finding count) is
kept in `localStorage`. It is per-browser and not shared, which is the
trade-off for needing no server or account. The uploaded file and the extracted
model are never stored.

## Code editing

DAX, Power Query (M) and native SQL open in a CodeMirror editor with syntax
highlighting, line numbers, search (Ctrl+F), copy, word-wrap toggle and full
screen. DAX and M have no published grammar, so both use a tokenizer written
here rather than a full parser.

## Interface

- **Light and dark themes.** Follows the operating system by default; the header
  toggle overrides it and the choice is remembered. Every colour is a token
  defined once per theme, so nothing is hardcoded. All text meets WCAG AA
  contrast in both themes.
- **Collapsible navigation.** The rail switches between labelled (244px) and
  icon-only (68px), remembered across reloads, and collapses automatically
  below 900px.
- **Code editing.** DAX, Power Query (M) and SQL get Sublime-style syntax
  colouring — a saturated Monokai palette in dark, a matched light one — with
  line numbers, search, copy, word wrap and full screen.

## Fonts

The UI is set in **Gotham**, a licensed Hoefler&Co typeface that cannot be
redistributed here. It is used when installed on the machine; otherwise the
stack falls back to Montserrat, the closest freely available geometric sans. To
self-host Gotham, add your own `@font-face` rules in `src/globals.css`.

## Known limits

- `.pbix` files are analyzed at the report layer only and cannot be edited or
  exported, because their model is not readable outside Power BI Desktop.
- A rename updates structural identifiers, not captions. If a visual title was
  typed as "Cross Sales", it stays that way after renaming the measure, exactly
  as Power BI Desktop leaves custom titles alone.
- A table passed unqualified to FILTER or ALL is flagged for manual review
  rather than rewritten, because the same token can be a variable name.
- PBIP projects using TMDL (`definition/*.tmdl`) are detected and refused;
  only `model.bim` projects are supported. Those views say so rather than showing
placeholder content. See `docs/ARCHITECTURE.md`.

## Deploying

`.github/workflows/deploy.yml` lints, tests and builds on every push to `main`,
then publishes to GitHub Pages. **No secrets and no third-party accounts are
required.** The workflow enables Pages on first run.

To host it anywhere else, `npm run build` produces a plain static `dist/`.
Set `VITE_BASE=/` when serving from a domain root:

```
VITE_BASE=/ npm run build
```

## Repository map

- `index.html`, `src/`: the app shell and UI
- `lib/powerbi/`: extraction, normalized model, usage analysis
- `lib/qa/`: DAX analysis, rule catalogue, scoring
- `docs/ARCHITECTURE.md`: formats, capabilities and design
- `tests/`: extraction, QA and product-surface checks (`npm test`)

Never commit environment files or corporate PBIX files.
