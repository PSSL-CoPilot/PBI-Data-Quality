/**
 * Finding and rewriting object references inside DAX.
 *
 * Positions are found on comment- and string-blanked text, which preserves
 * offsets, and the splice is applied to the original string. That way a
 * reference mentioned in a comment or inside a string literal is never
 * rewritten, and formatting elsewhere is untouched.
 *
 * Anything that cannot be rewritten unambiguously is *reported*, never guessed.
 * A rename that quietly leaves a dangling reference is the failure mode this
 * whole module exists to prevent.
 */
import { stripComments } from "../qa/dax.ts";

export interface DaxReference {
  /** Offset into the original expression. */
  start: number;
  /** Characters to replace, starting at `start`. */
  length: number;
  kind: "measure" | "column";
  /** Present for column references; the table qualifier as written. */
  table?: string;
  /** True when the qualifier was written as 'Quoted Name'. */
  quoted?: boolean;
  name: string;
}

/** `Table[Column]` or `'Table Name'[Column]`. */
const QUALIFIED = /(?:'([^'\r\n]+)'|([A-Za-z_][\w]*))\[([^\]\r\n]+)\]/g;
/** `[Measure]` with no table qualifier in front. */
const UNQUALIFIED = /(^|[^\w'\]])\[([^\]\r\n]+)\]/g;

/** Every measure and column reference, with offsets into `expression`. */
export function findReferences(expression: string): DaxReference[] {
  const masked = stripComments(expression);
  const refs: DaxReference[] = [];

  for (const match of masked.matchAll(QUALIFIED)) {
    const quotedTable = match[1];
    const plainTable = match[2];
    refs.push({
      start: match.index ?? 0,
      length: match[0].length,
      kind: "column",
      table: quotedTable ?? plainTable,
      quoted: Boolean(quotedTable),
      name: match[3],
    });
  }

  for (const match of masked.matchAll(UNQUALIFIED)) {
    refs.push({
      start: (match.index ?? 0) + match[1].length,
      length: match[0].length - match[1].length,
      kind: "measure",
      name: match[2],
    });
  }

  return refs.sort((a, b) => a.start - b.start);
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply replacements back to front so earlier offsets stay valid. */
function spliceAll(source: string, edits: Splice[]): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** A table name needs quoting in DAX when it is not a bare identifier. */
export function quoteTable(name: string, wasQuoted = false): string {
  return wasQuoted || !/^[A-Za-z_]\w*$/.test(name) ? `'${name}'` : name;
}

export interface RewriteOutcome {
  expression: string;
  /** How many references were rewritten. */
  replaced: number;
  /**
   * Things this rewrite deliberately did not touch and a human must check.
   * Never empty just because the rewrite "probably" covered everything.
   */
  unresolved: string[];
}

export function renameMeasureInDax(
  expression: string,
  oldName: string,
  newName: string
): RewriteOutcome {
  const edits = findReferences(expression)
    .filter((ref) => ref.kind === "measure" && ref.name === oldName)
    .map((ref) => ({ start: ref.start, end: ref.start + ref.length, text: `[${newName}]` }));

  return { expression: spliceAll(expression, edits), replaced: edits.length, unresolved: [] };
}

export function renameColumnInDax(
  expression: string,
  table: string,
  oldName: string,
  newName: string
): RewriteOutcome {
  const edits = findReferences(expression)
    .filter((ref) => ref.kind === "column" && ref.table === table && ref.name === oldName)
    .map((ref) => ({
      start: ref.start,
      end: ref.start + ref.length,
      text: `${quoteTable(table, ref.quoted)}[${newName}]`,
    }));

  return { expression: spliceAll(expression, edits), replaced: edits.length, unresolved: [] };
}

/**
 * Rename a table inside DAX.
 *
 * Qualified references (`Sales[Amount]`, `'Sales'[Amount]`) are rewritten
 * because they are unambiguous. A bare `Sales` — as passed to FILTER, ALL or
 * SUMMARIZE — is *not* rewritten, because the same token could be a variable
 * name. Those occurrences are reported so the edit can flag them rather than
 * silently corrupting or silently missing them.
 */
export function renameTableInDax(
  expression: string,
  oldName: string,
  newName: string
): RewriteOutcome {
  const refs = findReferences(expression);
  const edits = refs
    .filter((ref) => ref.kind === "column" && ref.table === oldName)
    .map((ref) => ({
      start: ref.start,
      end: ref.start + ref.length,
      text: `${quoteTable(newName, ref.quoted)}[${ref.name}]`,
    }));

  const rewritten = spliceAll(expression, edits);

  // Look for the old name still standing alone after the qualified rewrites.
  const leftovers = countUnqualifiedTableRefs(stripComments(rewritten), oldName);

  return {
    expression: rewritten,
    replaced: edits.length,
    unresolved: leftovers
      ? [
          `${leftovers} unqualified reference(s) to "${oldName}" remain, for example a table passed to FILTER or ALL. Check them by hand: the same word can also be a variable name.`,
        ]
      : [],
  };
}

/**
 * Occurrences of a table name that are not a `Table[Column]` qualifier.
 *
 * Tokenised rather than matched with a regular expression, because a quoted
 * identifier has to be treated as one unit: renaming `Sales` to `Fact Sales`
 * produces `'Fact Sales'[Amt]`, and a naive word match would report the
 * `Sales` inside the new name as a leftover.
 */
function countUnqualifiedTableRefs(text: string, tableName: string): number {
  const followedByColumn = (rest: string) => /^\s*\[/.test(rest);
  let count = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) break;
      const content = text.slice(i + 1, end);
      if (content === tableName && !followedByColumn(text.slice(end + 1))) count++;
      i = end + 1;
      continue;
    }

    const identifier = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (identifier) {
      const token = identifier[0];
      if (token === tableName && !followedByColumn(text.slice(i + token.length))) count++;
      i += token.length;
      continue;
    }

    i++;
  }

  return count;
}
