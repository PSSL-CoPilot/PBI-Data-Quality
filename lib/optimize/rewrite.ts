/**
 * Safe DAX rewrites: Current DAX -> Suggested DAX.
 *
 * A rewrite is only produced when it can be generated mechanically and then
 * validated. Anything subtler is reported as advice with no suggested code,
 * because a plausible-looking rewrite that silently changes results is worse
 * than no rewrite at all.
 *
 * Nothing here is executed or timed, so `impact` describes what structurally
 * changes and never claims the result is faster.
 */
import { stripComments, stripNoise } from "../qa/dax.ts";

export interface Rewrite {
  original: string;
  suggested: string;
  reason: string;
  recommendation: string;
  /** What changes structurally. Never a performance claim. */
  impact: string;
  /** How confident we are the rewrite means the same thing. */
  confidence: "high" | "medium" | "low";
  /** Always false: this build never executes or benchmarks DAX. */
  benchmarked: false;
  /** Set when results can differ, not just the code shape. */
  behaviourChange?: string;
}

/** Offsets of every character at parenthesis depth zero. */
function topLevelPositions(text: string, predicate: (index: number) => boolean): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && predicate(i)) found.push(i);
  }
  return found;
}

/** Index just past a top-level `RETURN`, or 0 when the expression has none. */
function bodyStart(masked: string): number {
  const match = [...masked.matchAll(/\bRETURN\b/gi)].find((m) => {
    let depth = 0;
    for (let i = 0; i < (m.index ?? 0); i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") depth--;
    }
    return depth === 0;
  });
  return match ? (match.index ?? 0) + match[0].length : 0;
}

function balanced(text: string): boolean {
  const masked = stripNoise(text);
  let parens = 0;
  let brackets = 0;
  for (const char of masked) {
    if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    if (parens < 0 || brackets < 0) return false;
  }
  return parens === 0 && brackets === 0;
}

/** Binary operators that bind less tightly than, or as tightly as, division. */
const COMPETING_OPERATORS = new Set(["+", "-", "*", "&", "=", "<", ">", "^"]);

/**
 * `a / b` -> `DIVIDE ( a, b )`.
 *
 * Only when `/` is unambiguously the root operator: exactly one top-level `/`
 * and no other top-level binary operator. Without that second condition the
 * rewrite silently changes the result, because `a - b / c` means `a - (b / c)`
 * but splitting on the slash would produce `DIVIDE ( a - b, c )`.
 */
export function rewriteDivision(expression: string): Rewrite | undefined {
  const masked = stripNoise(expression);
  const start = bodyStart(masked);
  const body = masked.slice(start);

  const slashes = topLevelPositions(
    body,
    (i) => body[i] === "/" && body[i - 1] !== "/" && body[i + 1] !== "/"
  );
  if (slashes.length !== 1) return undefined;

  // Any other top-level operator means the slash is not the root of the
  // expression, so splitting on it would re-associate the operands.
  if (topLevelPositions(body, (i) => COMPETING_OPERATORS.has(body[i])).length > 0) {
    return undefined;
  }

  const at = start + slashes[0];
  const numerator = expression.slice(start, at).trim();
  const denominator = expression.slice(at + 1).trim();
  if (!numerator || !denominator) return undefined;

  const prefix = expression.slice(0, start);
  const suggested = `${prefix}${start ? "\n    " : ""}DIVIDE ( ${numerator}, ${denominator} )`;
  if (!balanced(suggested)) return undefined;

  return {
    original: expression,
    suggested,
    reason:
      "The `/` operator raises an error or returns infinity when the denominator is zero or blank.",
    recommendation: "Use DIVIDE, which handles the zero and blank cases explicitly.",
    impact: "Removes the division-by-zero failure path. Structure is otherwise unchanged.",
    confidence: "high",
    benchmarked: false,
    behaviourChange:
      "DIVIDE returns BLANK where `/` errored. Pass a third argument if a different alternate result is wanted.",
  };
}

/** Matches a measure reference, excluding `Table[Column]` and `'Table'[Column]`. */
const MEASURE_REF = /(^|[^\w'\]])\[([^\]\r\n]+)\]/g;

/**
 * A measure referenced more than once is evaluated more than once. Hoisting it
 * into a VAR states the intent that it is one value.
 *
 * Only applied when the expression has no VAR of its own, so the rewrite cannot
 * collide with an existing variable name or reorder an existing RETURN.
 */
export function rewriteRepeatedMeasure(expression: string): Rewrite | undefined {
  if (/\bVAR\b/i.test(stripNoise(expression))) return undefined;
  const masked = stripComments(expression);

  const positions = new Map<string, number[]>();
  for (const match of masked.matchAll(MEASURE_REF)) {
    const name = match[2];
    const at = (match.index ?? 0) + match[1].length;
    positions.set(name, [...(positions.get(name) ?? []), at]);
  }

  const repeated = [...positions.entries()]
    .filter(([, hits]) => hits.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (!repeated) return undefined;

  const [name, hits] = repeated;
  const variable = `__${name.replace(/[^A-Za-z0-9]/g, "")}`;
  if (variable === "__") return undefined;

  // Splice from the end so earlier offsets stay valid.
  let body = expression;
  for (const at of [...hits].sort((a, b) => b - a)) {
    body = body.slice(0, at) + variable + body.slice(at + name.length + 2);
  }

  const suggested = `VAR ${variable} = [${name}]\nRETURN\n    ${body.trim()}`;
  if (!balanced(suggested)) return undefined;

  // Every repeated reference must have been replaced; the only `[name]` left is
  // the one in the VAR assignment.
  const remaining = [...stripComments(suggested).matchAll(MEASURE_REF)].filter(
    (m) => m[2] === name
  );
  if (remaining.length !== 1) return undefined;

  return {
    original: expression,
    suggested,
    reason: `[${name}] is referenced ${hits.length} times in the same expression.`,
    recommendation: "Assign it to a variable once and reuse the variable.",
    impact:
      "States that the repeated references are one value, and gives it a name. Results are unchanged.",
    confidence: "medium",
    benchmarked: false,
  };
}

/** Every rewrite available for an expression. */
export function suggestRewrites(expression: string): Rewrite[] {
  return [rewriteDivision(expression), rewriteRepeatedMeasure(expression)].filter(
    (r): r is Rewrite => Boolean(r)
  );
}
