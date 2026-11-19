import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");

const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
const references = [...css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)].map((m) => ({
  name: m[1],
  hasFallback: Boolean(m[2]),
  at: css.slice(0, m.index).split("\n").length,
}));

/**
 * The bug this exists to stop.
 *
 * `var(--text-1)` was written eleven times across several sessions. That token
 * was never defined — the real one is `--text` — and an invalid `var()` with no
 * fallback invalidates the whole declaration at computed-value time. For
 * `color` that inherits and usually looks plausible, which is why it survived
 * so long. For `fill` on SVG text it falls back to black, which on the dark
 * canvas made the lineage diagram's labels nearly invisible. The same mistake
 * had also been made with `--radius` (really `--r`, so corners silently went
 * square) and `--mono` (really `--mono-font`, so code lost its monospace face).
 *
 * None of it produced a build error, a lint error or a failing test.
 */
test("every custom property referenced without a fallback is defined", () => {
  const broken = references
    .filter((r) => !r.hasFallback && !defined.has(r.name))
    .map((r) => `${r.name} (line ${r.at})`);

  assert.deepEqual(
    [...new Set(broken)],
    [],
    "an undefined var() with no fallback silently drops the whole declaration"
  );
});

test("a fallback never hides a token the theme should own", () => {
  // A fallback is fine for a genuinely optional token, but if a name is used
  // with a fallback everywhere and defined nowhere, it is almost always a
  // typo that happens to degrade quietly rather than a deliberate default.
  const suspicious = [...new Set(references.filter((r) => r.hasFallback).map((r) => r.name))]
    .filter((name) => !defined.has(name))
    .filter((name) => name.startsWith("--sev") || name.startsWith("--text") || name.startsWith("--surface"));

  assert.deepEqual(suspicious, [], "these look like palette tokens that were never defined");
});

test("both themes define the same token names", () => {
  const block = (selector) => {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `${selector} not found`);
    const end = css.indexOf("\n}", start);
    return new Set([...css.slice(start, end).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
  };

  const light = block(":root {");
  const dark = block('[data-theme="dark"] {');

  // Dark overrides a subset; anything it defines must exist in light too, or
  // the light theme has a hole that only shows up when someone toggles.
  const onlyInDark = [...dark].filter((t) => !light.has(t));
  assert.deepEqual(onlyInDark, [], "defined for dark mode but missing from the light palette");
});

test("the severity ramp resolves to real colours in both themes", () => {
  for (const token of ["--sev-critical", "--sev-high", "--sev-medium", "--sev-low"]) {
    assert.ok(defined.has(token), `${token} is not defined`);
  }
});
