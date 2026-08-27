/**
 * What each finding costs the business, in one sentence.
 *
 * The rules themselves say what is wrong and what to do about it. A functional
 * reviewer needs a third thing before they will act: why it is worth their
 * afternoon. That is a judgement about consequences, not a property of the
 * check, so it lives here rather than in the rule catalogue.
 *
 * Every sentence describes a consequence that follows from the rule firing.
 * None of them claims a measured speed-up — nothing in this build times a
 * query, so nothing here says how much faster anything would be.
 */
import type { Rule } from "./rules.ts";

export const RULE_IMPACT: Record<string, string> = {
  "DAX-DIVISION":
    "When the denominator is zero or blank the visual shows Infinity or an error instead of a number, and readers usually take that as a data problem rather than a formula problem.",
  "DAX-NESTED-IF":
    "Deeply nested conditions are hard to read, so a wrong branch can sit in production for months without anyone noticing the number is off.",
  "DAX-IF-CHAIN":
    "A long chain of IFs is easy to get out of order, and adding one more case usually means re-reading all of them to be sure nothing was shadowed.",
  "DAX-NESTED-CALCULATE":
    "Nested CALCULATE makes the effective filter context hard to predict, which is the most common cause of a measure that is right on one page and wrong on another.",
  "DAX-FILTER-WHOLE-TABLE":
    "Filtering an entire table forces the engine to work row by row over every row, so the visual gets slower as the table grows.",
  "DAX-COMPLEX-MEASURE":
    "A very long expression is expensive to review and to change safely, so it tends to be copied rather than corrected.",
  "DAX-NO-FORMAT":
    "Without an explicit format each visual chooses its own, so the same figure can appear with different decimals or currency on different pages.",
  "MOD-NO-DESCRIPTION":
    "Nobody outside the author can tell what the measure is supposed to mean, so it gets rebuilt under a new name instead of reused.",
  "MOD-TABLE-NO-DESCRIPTION":
    "Report authors cannot tell what one row of the table represents, which is how the same figure ends up counted at two different grains.",
  "MOD-AUTO-DATE-TABLES":
    "Each hidden date table is stored in full and cannot be shared, so the file is larger than it needs to be and time intelligence cannot be made consistent across tables.",
  "MOD-NAME-COLLISION":
    "When two objects share a name, a DAX or field reference can silently resolve to the wrong one, and the error surfaces as a wrong number rather than a broken report.",
  "REL-MANY-TO-MANY":
    "A many-to-many relationship can multiply rows on both sides, so totals can come out higher than the underlying data supports.",
  "REL-BIDIRECTIONAL":
    "Filters travelling in both directions can create ambiguous paths, which change what a measure sees depending on which slicer is touched first.",
  "REL-INACTIVE":
    "An inactive relationship only applies where a measure explicitly invokes it, so a report author who assumes it is live will get unfiltered results.",
  "REL-ORPHAN-TABLE":
    "A table with no relationship cannot be filtered by any slicer, so its visuals ignore the page filters everyone assumes are applied.",
  "REP-BROKEN-FIELD":
    "The visual references something the model no longer contains, so it fails to render or silently drops the field when the report is opened.",
  "REP-PAGE-TOO-MANY-VISUALS":
    "Every visual issues its own queries when the page opens, so a crowded page is slow to load and hard for a reader to take in.",
  "REP-PAGE-TOO-MANY-SLICERS":
    "Many slicers on one page make the applied filter state hard to see, and readers routinely misread a filtered figure as a total.",
  "REP-EMPTY-PAGE":
    "An empty page is either unfinished work that shipped or a leftover, and either way it undermines confidence in the rest of the report.",
  "DQ-RELATIONSHIP-TYPE-MISMATCH":
    "Joining columns of different types forces a conversion on every row and can drop rows that do not convert, so figures come out lower than they should.",
  "DQ-NO-DATE-TABLE":
    "Without a marked date table, time intelligence cannot be relied on, and period-over-period figures may quietly exclude dates that have no rows.",
  "DQ-DUPLICATE-MEASURE-NAME":
    "Two measures with the same name in different tables are indistinguishable in the field list, so report authors pick the wrong one.",
  "DQ-MEASURE-MISSING-DEPENDENCY":
    "The measure calls something that does not exist, so every visual using it shows an error rather than a value.",
};

/** Rule ids with no impact sentence written for them. */
export function missingImpact(rules: Rule[]): string[] {
  return rules.filter((rule) => !RULE_IMPACT[rule.id]).map((rule) => rule.id);
}
