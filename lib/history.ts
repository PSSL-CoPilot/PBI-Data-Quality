/**
 * Version history in the browser.
 *
 * The app has no server: extraction and QA run client-side, so history is kept
 * in localStorage rather than a database. That makes it per-browser and not
 * shared, which is the trade-off for needing no account or backend at all.
 *
 * Only the summary is stored, never the uploaded file and never the full
 * model, so a long history cannot fill the storage quota.
 */
const KEY = "pbi-quality-studio.versions";
const LIMIT = 25;

export interface VersionRecord {
  id: string;
  fileName: string;
  sha256: string;
  format: string;
  /** What the file exposed, e.g. "model+report" or "report-only". */
  status: string;
  overall: number | null;
  findings: number;
  createdAt: number;
}

function read(): VersionRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as VersionRecord[]) : [];
  } catch {
    // Corrupt or unavailable storage must not break analysis.
    return [];
  }
}

export function listVersions(): VersionRecord[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Record a version. Returns false when storage is unavailable (private mode,
 * quota exhausted) so the caller can say so instead of pretending it saved.
 */
export function saveVersion(entry: Omit<VersionRecord, "id" | "createdAt">): boolean {
  const record: VersionRecord = {
    ...entry,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };

  // Re-analysing the same file replaces its entry rather than duplicating it.
  const kept = read().filter((v) => v.sha256 !== record.sha256);
  const next = [record, ...kept]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, LIMIT);

  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function clearVersions(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: storage is unavailable, so there is nothing stored.
  }
}
