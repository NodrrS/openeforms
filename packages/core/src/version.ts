/**
 * Notice version tokens.
 *
 * The German notice service publishes version tokens in two incompatible
 * styles within the same monthly export: zero-padded (`01`..`09`) under the
 * full eForms-DE profile, and unpadded (`1`..`10`) under the minimal
 * `eforms-sdk-0.1` profile. Measured over August 2026, both styles are present
 * and five pairs collide: `01`/`1`, `02`/`2`, `03`/`3`, `04`/`4`, `05`/`5`.
 *
 * They denote the same version and compare unequal as strings, so any
 * composite key of `(noticeId, version)` built on the raw token will treat one
 * notice as two. Normalise before keying.
 */

export interface NoticeVersion {
  /** The token exactly as published, e.g. `"01"` or `"1"`. */
  raw: string;
  /** The numeric version, e.g. `1`. Use this for comparison and keying. */
  number: number;
  /** True when the published token carried a leading zero. */
  zeroPadded: boolean;
}

export class VersionParseError extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(`Not a valid notice version token: ${JSON.stringify(raw)}`);
    this.name = "VersionParseError";
    this.raw = raw;
  }
}

/**
 * Normalise a published version token.
 *
 * @throws {VersionParseError} if the token is not a run of digits.
 */
export function parseVersion(raw: string): NoticeVersion {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new VersionParseError(raw);
  return {
    raw,
    number: Number.parseInt(trimmed, 10),
    zeroPadded: trimmed.length > 1 && trimmed.startsWith("0"),
  };
}

/** Like {@link parseVersion} but returns `undefined` instead of throwing. */
export function tryParseVersion(raw: string | undefined): NoticeVersion | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseVersion(raw);
  } catch {
    return undefined;
  }
}

/**
 * A stable key for a notice, immune to the padding inconsistency.
 *
 * `noticeKey("abc", "01")` and `noticeKey("abc", "1")` both yield `"abc@1"`.
 */
export function noticeKey(noticeId: string, version: string | NoticeVersion): string {
  const n = typeof version === "string" ? parseVersion(version).number : version.number;
  return `${noticeId}@${n}`;
}

/**
 * Recover `(id, version)` from an export filename such as
 * `52abdce9-6fb0-4b35-a30e-fd99bed7bd4d-10.xml` or `1234567-1.xml`.
 *
 * The identifier itself may contain hyphens, so the split is anchored on the
 * final hyphen-delimited digit run before the extension.
 */
export function parseExportFilename(
  filename: string,
): { id: string; version: NoticeVersion } | undefined {
  const m = /^(?<id>.+)-(?<ver>\d+)\.xml$/.exec(filename.replace(/^.*\//, ""));
  if (!m?.groups) return undefined;
  const version = tryParseVersion(m.groups["ver"]);
  if (!version) return undefined;
  return { id: m.groups["id"] as string, version };
}
