/**
 * The normalised notice model.
 *
 * `parseNotice` maps any of the three circulating eForms generations onto one
 * shape. Where the source genuinely lacks a value the field is `undefined`
 * rather than defaulted, and the reason is recorded in `diagnostics`, so a
 * caller can tell "absent in the data" apart from "we failed to read it".
 */

import { DOC_NS, NS, isNoticeKind, type NoticeKind } from "./namespaces.ts";
import { parseLegalBasis, type LegalBasis } from "./legal-basis.ts";
import { parseProfile, type Profile } from "./profile.ts";
import { noticeKey, tryParseVersion, type NoticeVersion } from "./version.ts";
import {
  attr,
  child,
  childText,
  descendants,
  parseXml,
  path,
  prefixesUsed,
  type XmlElement,
} from "./xml.ts";

export interface Organisation {
  /** Organisation identifier used for cross-references within the notice. */
  id: string | undefined;
  name: string | undefined;
  /** NUTS code of the registered address, where published. */
  nuts: string | undefined;
  countryCode: string | undefined;
  city: string | undefined;
}

export interface Lot {
  /** Lot identifier, e.g. `LOT-0001`. */
  id: string;
  title: string | undefined;
  /** Main CPV classification code for the lot. */
  cpv: string | undefined;
  /** Deadline for receipt of tenders, ISO 8601 where derivable. */
  tenderDeadline: string | undefined;
}

export type DiagnosticCode =
  | "missing-contract-folder-id"
  | "missing-customization-id"
  | "unknown-customization-id"
  | "missing-version"
  | "missing-notice-id"
  | "missing-legal-basis"
  | "unrecognised-legal-basis"
  | "unexpected-root-element";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
}

export interface Notice {
  /** `cbc:ID` of the notice. */
  noticeId: string | undefined;
  kind: NoticeKind;
  profile: Profile;
  version: NoticeVersion | undefined;
  /**
   * `cbc:ContractFolderID`, the key that links notices belonging to one
   * procedure. Absent on 38.3 % of German notices, and on 92.8 % of those
   * published under the minimal profile, so this is legitimately optional and
   * any lineage feature must handle its absence rather than assume it.
   */
  contractFolderId: string | undefined;
  issueDate: string | undefined;
  issueTime: string | undefined;
  legalBasis: LegalBasis | undefined;
  buyer: Organisation | undefined;
  lots: Lot[];
  /** Notes on what was absent or unrecognised. Never thrown, always reported. */
  diagnostics: Diagnostic[];
  /** The parsed tree, for callers that need fields this model does not cover. */
  root: XmlElement;
}

/**
 * A stable identity for the notice, immune to the version padding
 * inconsistency. `undefined` when the notice carries no id or no version.
 */
export function keyOf(notice: Notice): string | undefined {
  if (!notice.noticeId || !notice.version) return undefined;
  return noticeKey(notice.noticeId, notice.version);
}

/** Distinct XML prefixes the source document used. Diagnostics only. */
export function prefixesOf(notice: Notice): string[] {
  return [...prefixesUsed(notice.root)].sort();
}

export class NoticeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeParseError";
  }
}

function parseOrganisation(org: XmlElement | undefined): Organisation | undefined {
  if (!org) return undefined;
  const party = child(org, NS.EFAC, "Company") ?? org;
  const address = child(party, NS.CAC, "PostalAddress");
  return {
    id: childText(child(party, NS.CAC, "PartyIdentification"), NS.CBC, "ID"),
    name: childText(child(party, NS.CAC, "PartyName"), NS.CBC, "Name"),
    nuts: childText(address, NS.CBC, "CountrySubentityCode"),
    countryCode: childText(child(address, NS.CAC, "Country"), NS.CBC, "IdentificationCode"),
    city: childText(address, NS.CBC, "CityName"),
  };
}

function parseLots(root: XmlElement): Lot[] {
  const out: Lot[] = [];
  for (const lot of descendants(root, NS.CAC, "ProcurementProjectLot")) {
    const id = childText(lot, NS.CBC, "ID");
    if (!id) continue;
    const project = child(lot, NS.CAC, "ProcurementProject");
    const cpvNode = path(project, [NS.CAC, "MainCommodityClassification"]);
    const deadline = childText(
      path(lot, [NS.CAC, "TenderingProcess"], [NS.CAC, "TenderSubmissionDeadlinePeriod"]),
      NS.CBC,
      "EndDate",
    );
    out.push({
      id,
      title: childText(project, NS.CBC, "Name"),
      cpv: childText(cpvNode, NS.CBC, "ItemClassificationCode"),
      tenderDeadline: deadline,
    });
  }
  return out;
}

function findLegalBasis(root: XmlElement): string | undefined {
  for (const ref of descendants(root, NS.CAC, "ProcurementLegislationDocumentReference")) {
    const id = childText(ref, NS.CBC, "ID");
    if (id) return id;
  }
  return undefined;
}

function findBuyer(root: XmlElement): XmlElement | undefined {
  // eForms places organisations in an extension block; older and minimal
  // profiles fall back to cac:ContractingParty/cac:Party.
  const orgs = descendants(root, NS.EFAC, "Organization");
  if (orgs.length > 0) return orgs[0];
  return path(root, [NS.CAC, "ContractingParty"], [NS.CAC, "Party"]);
}

/**
 * Parse one eForms notice document.
 *
 * @throws {NoticeParseError} if the document root is not a notice element.
 * @throws {XmlParseError} if the document is not well-formed XML.
 */
export function parseNotice(source: string | Uint8Array): Notice {
  const root = parseXml(source);
  const diagnostics: Diagnostic[] = [];

  if (!isNoticeKind(root.local)) {
    throw new NoticeParseError(
      `Root element <${root.local}> is not an eForms notice. Expected one of ${Object.keys(DOC_NS).join(", ")}.`,
    );
  }
  const kind: NoticeKind = root.local;
  if (root.uri !== DOC_NS[kind]) {
    diagnostics.push({
      code: "unexpected-root-element",
      message: `Root <${kind}> is in namespace ${root.uri || "(none)"}, expected ${DOC_NS[kind]}.`,
    });
  }

  const customizationId = childText(root, NS.CBC, "CustomizationID");
  const profile = parseProfile(customizationId);
  if (customizationId === undefined) {
    diagnostics.push({
      code: "missing-customization-id",
      message: "No cbc:CustomizationID; the applicable rule set is unknown.",
    });
  } else if (profile.family === "unknown") {
    diagnostics.push({
      code: "unknown-customization-id",
      message: `Unrecognised cbc:CustomizationID ${JSON.stringify(customizationId)}.`,
    });
  }

  const noticeId = childText(root, NS.CBC, "ID");
  if (!noticeId) {
    diagnostics.push({ code: "missing-notice-id", message: "No cbc:ID on the notice." });
  }

  const version = tryParseVersion(childText(root, NS.CBC, "VersionID"));
  if (!version) {
    diagnostics.push({
      code: "missing-version",
      message: "No usable cbc:VersionID; the notice cannot be keyed by version.",
    });
  }

  const contractFolderId = childText(root, NS.CBC, "ContractFolderID");
  if (!contractFolderId) {
    diagnostics.push({
      code: "missing-contract-folder-id",
      message: profile.minimal
        ? "No cbc:ContractFolderID. Expected on the minimal profile, where it is absent on roughly 93 % of notices; this notice cannot be linked to its procedure."
        : "No cbc:ContractFolderID; this notice cannot be linked to its procedure.",
    });
  }

  const rawBasis = findLegalBasis(root);
  const legalBasis = parseLegalBasis(rawBasis);
  if (!legalBasis) {
    diagnostics.push({
      code: "missing-legal-basis",
      message: "No procurement legal basis published.",
    });
  } else if (legalBasis.scope === "unknown") {
    diagnostics.push({
      code: "unrecognised-legal-basis",
      message: `Legal basis ${JSON.stringify(legalBasis.raw)} (code ${legalBasis.code}) is not in the known set; threshold scope left unknown rather than guessed.`,
    });
  }

  return {
    noticeId,
    kind,
    profile,
    version,
    contractFolderId,
    issueDate: childText(root, NS.CBC, "IssueDate"),
    issueTime: childText(root, NS.CBC, "IssueTime"),
    legalBasis,
    buyer: parseOrganisation(findBuyer(root)),
    lots: parseLots(root),
    diagnostics,
    root,
  };
}

/** Like {@link parseNotice} but returns a result instead of throwing. */
export type ParseResult =
  | { ok: true; notice: Notice }
  | { ok: false; error: Error };

export function tryParseNotice(source: string | Uint8Array): ParseResult {
  try {
    return { ok: true, notice: parseNotice(source) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** Re-exported so callers can read `attr` without a second import. */
export { attr };
