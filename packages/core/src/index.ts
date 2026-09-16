/**
 * @openeforms/core
 *
 * A namespace-aware parser and normaliser for eForms procurement notices,
 * including the German eForms-DE profile.
 *
 * Three design decisions, each forced by what the published data actually
 * contains rather than by what the specification says it should:
 *
 * 1. Elements are addressed by `(namespaceUri, localName)`, never by prefix.
 *    Seven distinct prefixes carry the same root elements in production.
 * 2. All three circulating customisation generations parse. Targeting only the
 *    current German profile drops two fifths of the feed.
 * 3. Absent values stay `undefined` and are reported in `diagnostics`. The
 *    procedure identifier is missing on 38 % of notices, so a model that
 *    assumes it is present is wrong about the real world.
 *
 * Measurements: https://github.com/NodrrS/openeforms-probe
 */

export { NS, DOC_NS, NOTICE_KINDS, isNoticeKind, type NoticeKind } from "./namespaces.ts";

export {
  parseVersion,
  tryParseVersion,
  noticeKey,
  parseExportFilename,
  VersionParseError,
  type NoticeVersion,
} from "./version.ts";

export { parseProfile, type Profile, type ProfileFamily } from "./profile.ts";

export {
  parseLegalBasis,
  normaliseLegalBasisCode,
  type LegalBasis,
  type ThresholdScope,
} from "./legal-basis.ts";

export {
  parseXml,
  child,
  children,
  childText,
  descendant,
  descendants,
  path,
  walk,
  attr,
  prefixesUsed,
  XmlParseError,
  type XmlElement,
} from "./xml.ts";

export {
  parseNotice,
  tryParseNotice,
  keyOf,
  prefixesOf,
  NoticeParseError,
  type Notice,
  type Lot,
  type Organisation,
  type Diagnostic,
  type DiagnosticCode,
  type ParseResult,
} from "./notice.ts";

export {
  fetchExport,
  exportUrl,
  ExportError,
  EXPORT_ENDPOINT,
  type ExportArchive,
  type ExportFormat,
  type FetchExportOptions,
} from "./export.ts";
