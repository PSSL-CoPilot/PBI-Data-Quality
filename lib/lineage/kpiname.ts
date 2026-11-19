/**
 * What a KPI is called.
 *
 * A measure is shown by several visuals, each titled a little differently —
 * "Churn Percentage", "Churn Percentage monthly view", "Churn Percentage daily
 * view". Picking the highest-ranked single title, which is what the caption
 * inference does, lands on a variant as often as on the name, so the KPI ends
 * up called "Churn Percentage daily view". The name is the part they share.
 *
 * Two sources, in order of authority:
 *
 *   glossary  a page in the report that lists the KPIs by name. When the
 *             report states the name, nothing needs inferring.
 *   titles    the longest run of whole words common to every title that shows
 *             the measure. Deterministic, and it degrades to the single title
 *             when there is only one visual.
 *
 * Neither invents anything: the glossary is read from the report, and the
 * common prefix is text the report already repeats on every visual. Where
 * neither yields anything usable the measure's own name is used, which is at
 * least true.
 */
import type { Model } from "../powerbi/model.ts";

export type KpiNameSource = "glossary" | "titles" | "measure";

export interface KpiName {
  name: string;
  source: KpiNameSource;
  /** How the name was arrived at, for the reader. */
  reason: string;
}

/* ------------------------------------------------------------- glossary --- */

/** A page that exists to list what the KPIs mean. */
const GLOSSARY_PAGE =
  /\b(glossar|definition|dictionar|data\s*dict|kpi\s*list|metric\s*definition|terminolog)/i;

export function isGlossaryPage(displayName: string): boolean {
  return GLOSSARY_PAGE.test(displayName);
}

/** Compare names ignoring case, spacing and punctuation. */
export const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Terms listed on a glossary page.
 *
 * Two shapes cover almost every glossary anyone builds in Power BI: one text
 * box per term, and a block of "Term: definition" lines. Anything that reads
 * like a sentence rather than a name is skipped, because a definition is not
 * a term and treating one as a KPI name would be worse than having no
 * glossary at all.
 */
export function readGlossary(model: Model): Map<string, string> {
  const terms = new Map<string, string>();

  const offer = (candidate: string) => {
    const term = candidate.replace(/\s+/g, " ").trim().replace(/[.:;,–—-]+$/, "").trim();
    if (term.length < 2 || term.length > 60) return;
    // A term is a name, not a sentence.
    if (/[.!?]\s/.test(term)) return;
    if (term.split(/\s+/).length > 8) return;
    if (!/[a-z]/i.test(term)) return;
    const key = normalise(term);
    if (key && !terms.has(key)) terms.set(key, term);
  };

  for (const page of model.pages) {
    if (!isGlossaryPage(page.displayName)) continue;

    for (const visual of page.visuals) {
      const text = visual.text ?? visual.title;
      if (!text) continue;

      // "Term: definition" / "Term – definition", one per line.
      let matchedAny = false;
      for (const line of text.split(/[\n\r]+/)) {
        const pair = /^\s*([^:–—]{2,60}?)\s*[:–—]\s+\S/.exec(line);
        if (pair) {
          offer(pair[1]);
          matchedAny = true;
        }
      }

      // Otherwise the whole box is the term, which is the one-box-per-term
      // layout. Only when it is short enough to be a name.
      if (!matchedAny && text.length <= 60) offer(text);
    }
  }

  return terms;
}

/* --------------------------------------------------------------- titles --- */

const STOP_AT_END = /\s*[-–—:(|]\s*$/;

/**
 * The longest run of whole words every title begins with.
 *
 * Word-aligned deliberately: a character-wise prefix of "Churn Percentage" and
 * "Churn Pct" is "Churn P", which is not a name.
 */
export function commonTitle(titles: string[]): string | undefined {
  const cleaned = titles.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return undefined;
  if (cleaned.length === 1) return cleaned[0];

  const words = cleaned.map((t) => t.split(" "));
  const shortest = Math.min(...words.map((w) => w.length));

  let shared = 0;
  while (shared < shortest) {
    const word = words[0][shared].toLowerCase();
    if (!words.every((w) => w[shared].toLowerCase() === word)) break;
    shared++;
  }

  if (shared === 0) return undefined;
  const prefix = words[0].slice(0, shared).join(" ").replace(STOP_AT_END, "").trim();
  // A one-letter or punctuation-only prefix is not a name.
  return /[a-z0-9]{2}/i.test(prefix) ? prefix : undefined;
}

/* ------------------------------------------------------------------ api --- */

/**
 * Name the KPI behind a measure.
 *
 * `titles` is every visual title that displays it, `measureName` the fallback.
 */
export function nameKpi(
  titles: string[],
  measureName: string,
  glossary: Map<string, string>
): KpiName {
  const shared = commonTitle(titles);

  // The glossary wins, matched against the shared title first and then the
  // measure, so a report that states its own names is always obeyed.
  for (const candidate of [shared, measureName]) {
    if (!candidate) continue;
    const listed = glossary.get(normalise(candidate));
    if (listed) {
      return {
        name: listed,
        source: "glossary",
        reason: `"${listed}" is listed on the report's glossary page.`,
      };
    }
  }

  if (shared) {
    return {
      name: shared,
      source: "titles",
      reason:
        titles.length > 1
          ? `Every visual showing this measure is titled "${shared}…", so that is the KPI; the rest of each title says which view it is.`
          : `Taken from the title of the only visual that shows this measure.`,
    };
  }

  return {
    name: measureName,
    source: "measure",
    reason:
      titles.length > 1
        ? "The visuals showing this measure share no common title, so the measure's own name is used."
        : "No visual title was available, so the measure's own name is used.",
  };
}
