/**
 * eForms customisation profiles.
 *
 * `cbc:CustomizationID` says which rule set a notice was published against.
 * Three generations circulate simultaneously in German production data.
 * Measured over August 2026 (22,892 notices):
 *
 * | CustomizationID  | Share  | Profile                                   |
 * | ---------------- | -----: | ----------------------------------------- |
 * | `eforms-de-2.1`  | 59.2 % | full German profile, above threshold      |
 * | `eforms-sdk-0.1` | 40.6 % | minimal profile, mostly below threshold   |
 * | `eforms-sdk-1.0` |  0.2 % | EU profile                                |
 *
 * A reader that targets only the current German profile silently drops two
 * fifths of the feed, so the parser accepts all of them and records which one
 * it saw.
 */

export type ProfileFamily = "eforms-de" | "eforms-sdk" | "unknown";

export interface Profile {
  /** `cbc:CustomizationID` exactly as published, or `undefined` if absent. */
  raw: string | undefined;
  family: ProfileFamily;
  /** Profile version as published, e.g. `"2.1"` or `"0.1"`. */
  version: string | undefined;
  /**
   * True for `eforms-sdk-0.1`, the minimal profile. These notices routinely
   * omit fields the full profile guarantees, most importantly
   * `cbc:ContractFolderID`: 8,627 of 9,293 such notices in August 2026 had
   * none, which is what bounds lineage reconstruction.
   */
  minimal: boolean;
}

const RE = /^eforms-(?<family>de|sdk)-(?<version>\d+(?:\.\d+)*)$/;

export function parseProfile(raw: string | undefined): Profile {
  if (raw === undefined || raw.trim() === "") {
    return { raw, family: "unknown", version: undefined, minimal: false };
  }
  const value = raw.trim();
  const m = RE.exec(value);
  if (!m?.groups) {
    return { raw, family: "unknown", version: undefined, minimal: false };
  }
  const family = m.groups["family"] === "de" ? "eforms-de" : "eforms-sdk";
  const version = m.groups["version"] as string;
  return {
    raw,
    family,
    version,
    minimal: family === "eforms-sdk" && version === "0.1",
  };
}
