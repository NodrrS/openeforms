/**
 * Namespace URIs used by eForms notices.
 *
 * Everything in this library addresses elements by `(namespaceUri, localName)`.
 * It never matches on a prefix. Production data from the German notice service
 * carries the same root elements under at least seven different prefixes
 * (`ns7:`, `ns8:`, `ns9:`, `cn:`, `can:`, `pin:`, and no prefix at all), so
 * prefix matching fails silently on a large share of real notices.
 */

export const NS = {
  /** UBL Common Basic Components 2 — where most leaf values live. */
  CBC: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  /** UBL Common Aggregate Components 2 — where most structures live. */
  CAC: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  /** UBL Extension Content, the wrapper for eForms extensions. */
  EXT: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
  /** eForms extension namespace (efext). */
  EFEXT: "http://data.europa.eu/p27/eforms-ubl-extensions/1",
  /** eForms extension aggregate components (efac). */
  EFAC: "http://data.europa.eu/p27/eforms-ubl-extension-aggregate-components/1",
  /** eForms extension basic components (efbc). */
  EFBC: "http://data.europa.eu/p27/eforms-ubl-extension-basic-components/1",
} as const;

/** Document namespaces, one per notice document type. */
export const DOC_NS = {
  ContractNotice:
    "urn:oasis:names:specification:ubl:schema:xsd:ContractNotice-2",
  ContractAwardNotice:
    "urn:oasis:names:specification:ubl:schema:xsd:ContractAwardNotice-2",
  PriorInformationNotice:
    "urn:oasis:names:specification:ubl:schema:xsd:PriorInformationNotice-2",
  BriefNotice: "urn:oasis:names:specification:ubl:schema:xsd:BriefNotice-2",
} as const;

/** The four document element local names eForms uses. */
export type NoticeKind = keyof typeof DOC_NS;

export const NOTICE_KINDS = Object.keys(DOC_NS) as NoticeKind[];

export function isNoticeKind(local: string): local is NoticeKind {
  return (NOTICE_KINDS as string[]).includes(local);
}
