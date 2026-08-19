/**
 * Text-level DAX analysis.
 *
 * This is deliberately not a full DAX parser. Every scan first removes comments
 * and string literals, because the alternative — matching raw text — reports a
 * division bug for `-- 50/50 split` in a comment, and a finding that is not real
 * is worse than a finding that is missing.
 */

/** Remove `//`, `--` and block comments. */
export function stripComments(expression: string): string {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < expression.length) {
    const two = expression.slice(i, i + 2);

    if (inString) {
      if (expression[i] === '"') {
        // `""` is an escaped quote inside a DAX string, not a terminator.
        if (expression[i + 1] === '"') {
          out += '  ';
          i += 2;
          continue;
        }
        inString = false;
      }
      out += expression[i] === "\n" ? "\n" : " ";
      i++;
      continue;
    }

    if (expression[i] === '"') {
      inString = true;
      out += " ";
      i++;
      continue;
    }

    if (two === "//" || two === "--") {
      while (i < expression.length && expression[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (two === "/*") {
      while (i < expression.length && expression.slice(i, i + 2) !== "*/") {
        out += expression[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }

    out += expression[i];
    i++;
  }

  return out;
}

/**
 * Comments, string literals and quoted table identifiers blanked out, so that
 * operator and function scans cannot match inside them. Blanking preserves
 * offsets and line numbers rather than shifting them.
 */
export function stripNoise(expression: string): string {
  const withoutComments = stripComments(expression);
  let out = "";
  let inQuoted = false;

  for (let i = 0; i < withoutComments.length; i++) {
    const char = withoutComments[i];
    if (char === "'") {
      inQuoted = !inQuoted;
      out += " ";
      continue;
    }
    out += inQuoted && char !== "\n" ? " " : char;
  }

  return out;
}

const callPattern = (fn: string) => new RegExp(`\\b${fn}\\s*\\(`, "gi");

/** Number of times a function is called. */
export function countCalls(expression: string, fn: string): number {
  return (stripNoise(expression).match(callPattern(fn)) ?? []).length;
}

/**
 * Deepest nesting of a function inside itself. `IF(IF(...))` is 2, and a flat
 * sequence of sibling `IF(...)` calls stays 1.
 */
export function maxNesting(expression: string, fn: string): number {
  const text = stripNoise(expression);
  const opensCall = new RegExp(`\\b${fn}\\s*$`, "i");

  let depth = 0;
  let deepest = 0;
  const openedByFn: number[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") {
      if (opensCall.test(text.slice(Math.max(0, i - fn.length - 4), i))) {
        openedByFn.push(depth);
      }
      depth++;
      deepest = Math.max(deepest, openedByFn.length);
    } else if (text[i] === ")") {
      depth--;
      while (openedByFn.length > 0 && openedByFn[openedByFn.length - 1] >= depth) {
        openedByFn.pop();
      }
    }
  }

  return deepest;
}

/**
 * True when the `/` division operator is used. DIVIDE is the safe form because
 * `/` returns an error or infinity when the denominator is blank or zero.
 */
export function usesDivisionOperator(expression: string): boolean {
  return /(^|[^/*])\/(?![/*])/.test(stripNoise(expression));
}

/** Measure references: `[Name]` not preceded by a table qualifier. */
export function referencedMeasures(expression: string): string[] {
  const text = stripComments(expression);
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[^\w'\]])\[([^\]\r\n]+)\]/g)) {
    found.add(match[2]);
  }
  return [...found];
}

/** Column references: `Table[Column]` or `'Table Name'[Column]`. */
export function referencedColumns(expression: string): Array<{ table: string; column: string }> {
  const text = stripComments(expression);
  const found = new Map<string, { table: string; column: string }>();
  for (const match of text.matchAll(/(?:'([^']+)'|(\w+))\[([^\]\r\n]+)\]/g)) {
    const table = match[1] ?? match[2];
    const column = match[3];
    found.set(`${table}[${column}]`, { table, column });
  }
  return [...found.values()];
}

const TIME_INTELLIGENCE = [
  "SAMEPERIODLASTYEAR",
  "DATEADD",
  "DATESYTD",
  "DATESQTD",
  "DATESMTD",
  "TOTALYTD",
  "TOTALQTD",
  "TOTALMTD",
  "PARALLELPERIOD",
  "PREVIOUSMONTH",
  "PREVIOUSQUARTER",
  "PREVIOUSYEAR",
  "NEXTMONTH",
  "NEXTQUARTER",
  "NEXTYEAR",
  "DATESBETWEEN",
  "DATESINPERIOD",
];

/** Time-intelligence functions require a table marked as a date table. */
export function timeIntelligenceUsed(expression: string): string[] {
  const text = stripNoise(expression);
  return TIME_INTELLIGENCE.filter((fn) => callPattern(fn).test(text));
}

export const lineCount = (expression: string): number => expression.split(/\r?\n/).length;
