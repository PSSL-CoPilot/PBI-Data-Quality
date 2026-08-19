/**
 * Line diff for DAX, M and SQL, used by the before/after view.
 *
 * A plain longest-common-subsequence over lines. Text-level diffing inside a
 * line is deliberately not attempted: for code the reader wants to see whole
 * lines added and removed, and a character diff on reformatted DAX produces
 * noise rather than insight.
 */
export type DiffKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the original, when the line exists there. */
  beforeLine?: number;
  /** 1-based line number in the modified text, when it exists there. */
  afterLine?: number;
}

const splitLines = (value: string): string[] => value.replace(/\r\n/g, "\n").split("\n");

/** Length table of the longest common subsequence of two line arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const table = lcsTable(a, b);

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "removed", text: a[i], beforeLine: i + 1 });
      i++;
    } else {
      lines.push({ kind: "added", text: b[j], afterLine: j + 1 });
      j++;
    }
  }

  while (i < a.length) lines.push({ kind: "removed", text: a[i], beforeLine: ++i });
  while (j < b.length) lines.push({ kind: "added", text: b[j], afterLine: ++j });

  return lines;
}

export interface DiffSummary {
  added: number;
  removed: number;
  unchanged: number;
}

export function summariseDiff(lines: DiffLine[]): DiffSummary {
  return {
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
    unchanged: lines.filter((l) => l.kind === "same").length,
  };
}
