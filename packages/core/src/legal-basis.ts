/**
 * Procurement legal basis.
 *
 * Published under `cac:ProcurementLegislationDocumentReference/cbc:ID`. The
 * feed carries the same basis under more than one spelling — `VOB/A` beside
 * `vob-a`, `UVgO` beside `uvgo` — so the raw value cannot be grouped on
 * directly. It is absent entirely on a large minority of notices (9,299 of
 * 22,892 in August 2026), overwhelmingly those on the minimal profile.
 *
 * The threshold classification below reflects which German procurement
 * regulation applies, not a monetary test. It is a useful proxy for whether a
 * notice is an EU-wide procedure, and it is deliberately reported as
 * `"unknown"` rather than guessed when the basis is missing or unrecognised.
 */

export type ThresholdScope = "above" | "below" | "unknown";

export interface LegalBasis {
  /** The value exactly as published, e.g. `"VOB/A"`. */
  raw: string;
  /** Lower-cased, punctuation-folded code, e.g. `"vob-a"`. */
  code: string;
  scope: ThresholdScope;
}

/**
 * Regulations transposing the EU directives: these procedures are at or above
 * the EU thresholds.
 */
const ABOVE = new Set([
  "vgv", // Vergabeverordnung
  "sektvo", // Sektorenverordnung
  "konzvgv", // Konzessionsvergabeverordnung
  "vsvgv", // Vergabeverordnung Verteidigung und Sicherheit
  "vob-a-eu", // VOB/A EU
  "vob-a-vs", // VOB/A VS
]);

/** National regulations: these procedures are below the EU thresholds. */
const BELOW = new Set([
  "vob-a", // VOB/A (Abschnitt 1)
  "uvgo", // Unterschwellenvergabeordnung
  "vol-a", // VOL/A
  "haushaltsrecht",
]);

/**
 * Fold a published value to a comparable code.
 *
 * Lower-cases, converts `/` and whitespace and underscores to `-`, and
 * collapses repeated separators, so `VOB/A`, `vob-a` and `VOB_A` all yield
 * `vob-a`.
 */
export function normaliseLegalBasisCode(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s/_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseLegalBasis(raw: string | undefined): LegalBasis | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const code = normaliseLegalBasisCode(raw);
  const scope: ThresholdScope = ABOVE.has(code)
    ? "above"
    : BELOW.has(code)
      ? "below"
      : "unknown";
  return { raw, code, scope };
}
