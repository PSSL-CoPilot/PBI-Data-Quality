/**
 * Inferring the name a reader knows a measure by.
 *
 * A measure called `M Unique Sales` may appear on a page under a heading that
 * simply reads `Unique Sales`. Nothing in the file links the two, so the link is
 * inferred from the report layout: the visual's own title when it has one,
 * otherwise the nearest caption placed above or to the left of it.
 *
 * This is a guess and is labelled as one everywhere it is shown. The evidence —
 * which visual, which caption, how far away — is returned alongside the label so
 * it can be judged rather than taken on trust.
 */
import { measureKey, type Model, type Page, type Visual } from "./model.ts";

/** Visual types that carry a caption rather than a data binding. */
const CAPTION_VISUALS = new Set(["textbox", "shape", "actionButton", "basicShape"]);

/** How far a caption can sit from a visual and still be taken as its label. */
const ADJACENT_GAP = 120;
const FALLBACK_RADIUS = 320;

export type KpiSource = "visual-title" | "caption-above" | "caption-left" | "caption-near";

export interface KpiGuess {
  label: string;
  source: KpiSource;
  confidence: "high" | "medium" | "low";
  page: string;
  pageDisplayName: string;
  visualId: string;
  visualType: string;
  /** Pixels between the caption and the visual; absent for a visual title. */
  distance?: number;
}

const right = (v: Visual) => v.x + v.width;
const bottom = (v: Visual) => v.y + v.height;
const centreX = (v: Visual) => v.x + v.width / 2;
const centreY = (v: Visual) => v.y + v.height / 2;

const overlapsHorizontally = (a: Visual, b: Visual) => a.x < right(b) && b.x < right(a);
const overlapsVertically = (a: Visual, b: Visual) => a.y < bottom(b) && b.y < bottom(a);

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A caption is only useful as a KPI name if it reads like one. Page headings and
 * sentences are excluded so a banner does not become every card's label.
 */
function usableCaption(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const value = clean(text);
  if (value.length === 0 || value.length > 60) return undefined;
  // A caption ending in a colon is a prefix like "Last Refreshed :".
  const trimmed = value.replace(/\s*:\s*$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function captionsOn(page: Page): Visual[] {
  return page.visuals.filter(
    (visual) => CAPTION_VISUALS.has(visual.type) && usableCaption(visual.text)
  );
}

/** The best caption for one visual, or nothing when none is close enough. */
function captionFor(visual: Visual, captions: Visual[]): { caption: Visual; source: KpiSource; distance: number } | undefined {
  const above = captions
    .filter((c) => overlapsHorizontally(c, visual) && bottom(c) <= visual.y + 8)
    .map((c) => ({ caption: c, distance: visual.y - bottom(c) }))
    .filter((c) => c.distance <= ADJACENT_GAP)
    .sort((a, b) => a.distance - b.distance)[0];
  if (above) return { caption: above.caption, source: "caption-above", distance: above.distance };

  const left = captions
    .filter((c) => overlapsVertically(c, visual) && right(c) <= visual.x + 8)
    .map((c) => ({ caption: c, distance: visual.x - right(c) }))
    .filter((c) => c.distance <= ADJACENT_GAP)
    .sort((a, b) => a.distance - b.distance)[0];
  if (left) return { caption: left.caption, source: "caption-left", distance: left.distance };

  const nearest = captions
    .map((c) => ({
      caption: c,
      distance: Math.hypot(centreX(c) - centreX(visual), centreY(c) - centreY(visual)),
    }))
    .filter((c) => c.distance <= FALLBACK_RADIUS)
    .sort((a, b) => a.distance - b.distance)[0];
  if (nearest) return { caption: nearest.caption, source: "caption-near", distance: nearest.distance };

  return undefined;
}

const CONFIDENCE: Record<KpiSource, KpiGuess["confidence"]> = {
  "visual-title": "high",
  "caption-above": "medium",
  "caption-left": "medium",
  "caption-near": "low",
};

/**
 * Every KPI-name guess for every measure, keyed by `measure:Table[Name]`.
 * Guesses are ordered best first.
 */
export function inferKpiNames(model: Model): Map<string, KpiGuess[]> {
  const guesses = new Map<string, KpiGuess[]>();
  const rank = { high: 0, medium: 1, low: 2 } as const;

  for (const page of model.pages) {
    const captions = captionsOn(page);

    for (const visual of page.visuals) {
      const measures = visual.refs.filter((ref) => ref.kind === "measure");
      if (measures.length === 0) continue;

      // A visual bound to several measures cannot attribute one caption to one
      // of them, so only its own title is trustworthy in that case.
      const title = usableCaption(visual.title);
      let guess: Omit<KpiGuess, "page" | "pageDisplayName" | "visualId" | "visualType"> | undefined;

      if (title) {
        guess = { label: title, source: "visual-title", confidence: "high" };
      } else if (measures.length === 1) {
        const found = captionFor(visual, captions);
        const label = found && usableCaption(found.caption.text);
        if (found && label) {
          guess = {
            label,
            source: found.source,
            confidence: CONFIDENCE[found.source],
            distance: Math.round(found.distance),
          };
        }
      }

      if (!guess) continue;

      for (const ref of measures) {
        const key = measureKey({ table: ref.table ?? "", name: ref.field });
        const entry: KpiGuess = {
          ...guess,
          page: page.name,
          pageDisplayName: page.displayName,
          visualId: visual.id,
          visualType: visual.type,
        };
        guesses.set(key, [...(guesses.get(key) ?? []), entry]);
      }
    }
  }

  for (const [key, list] of guesses) {
    list.sort(
      (a, b) => rank[a.confidence] - rank[b.confidence] || (a.distance ?? 0) - (b.distance ?? 0)
    );
    guesses.set(key, list);
  }

  return guesses;
}

/** The single best guess for a measure, if there is one. */
export function bestKpiName(guesses: Map<string, KpiGuess[]>, table: string, name: string) {
  return guesses.get(measureKey({ table, name }))?.[0];
}
