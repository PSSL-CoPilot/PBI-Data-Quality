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

### Version history

A summary of each analysis (file name, hash, format, score, finding count) is
kept in `localStorage`. It is per-browser and not shared, which is the
trade-off for needing no server or account. The uploaded file and the extracted
model are never stored.

## Fonts

The UI is set in **Gotham**, a licensed Hoefler&Co typeface that cannot be
redistributed here. It is used when installed on the machine; otherwise the
stack falls back to Montserrat, the closest freely available geometric sans. To
self-host Gotham, add your own `@font-face` rules in `src/globals.css`.

## Not built yet

Optimization analysis and score, object editing, dependency-aware renames,
change tracking, validation and export. Those views say so rather than showing
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
