import assert from "node:assert/strict";
import { test } from "node:test";

import { missingImpact, RULE_IMPACT } from "../lib/qa/impact.ts";
import { ALL_RULES } from "../lib/qa/rules.ts";

test("every rule explains why it matters", () => {
  assert.deepEqual(missingImpact(ALL_RULES), []);
});

test("no impact sentence is written for a rule that no longer exists", () => {
  const ids = new Set(ALL_RULES.map((rule) => rule.id));
  const orphans = Object.keys(RULE_IMPACT).filter((id) => !ids.has(id));
  assert.deepEqual(orphans, []);
});

test("no impact sentence claims a measured improvement", () => {
  // Nothing in this build times a query, so nothing may promise a number.
  const forbidden = /\b\d+\s*(x|%|times)\s*(faster|quicker|smaller)\b|\bwill be faster\b/i;
  const liars = Object.entries(RULE_IMPACT).filter(([, text]) => forbidden.test(text));
  assert.deepEqual(liars, []);
});
