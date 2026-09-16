/**
 * Ingest from the Datenservice Öffentlicher Einkauf bulk export.
 *
 * The published OpenAPI document declares one path, `/api/notice-exports`,
 * with three parameters: `pubDay`, `pubMonth`, `format`. There is no search,
 * filter, subscription or webhook facility, and no `Access-Control-*` headers
 * are returned, so this runs server-side.
 *
 * ## The conditional-request hazard
 *
 * The export returns one `ETag` per format — `"version-0"` for eForms,
 * `"version-6"` for OCDS — identical for every day and month requested. It
 * does not identify the resource. Presenting a validator harvested from one
 * day while requesting a different day that has never been fetched returns
 * `304 Not Modified` with an empty body, while the same request without the
 * header returns the full archive.
 *
 * A client that caches by `ETag`, or any shared HTTP cache in front of it,
 * therefore reports success and yields nothing. {@link fetchExport} never
 * sends a conditional header and sets `cache: "no-store"` for that reason. If
 * a `304` is nevertheless observed it is raised as an error rather than
 * surfaced as an empty result, so the failure can never pass for "no notices
 * that day".
 */

export type ExportFormat = "eforms.zip" | "ocds.zip" | "csv.zip";

export const EXPORT_ENDPOINT = "https://oeffentlichevergabe.de/api/notice-exports";

export interface FetchExportOptions {
  /** A single day, `YYYY-MM-DD`. Mutually exclusive with `month`. */
  day?: string;
  /** A whole month, `YYYY-MM`. Mutually exclusive with `day`. */
  month?: string;
  format?: ExportFormat;
  endpoint?: string;
  signal?: AbortSignal;
  /** Injectable for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ExportArchive {
  bytes: Uint8Array;
  format: ExportFormat;
  /** The resource requested, e.g. `pubDay=2026-09-09`. */
  resource: string;
  /**
   * The validator the server sent. Recorded for diagnostics only — it is not
   * resource-specific and must never be replayed as `If-None-Match`.
   */
  etag: string | undefined;
}

export class ExportError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function exportUrl(options: FetchExportOptions): string {
  const { day, month, format = "eforms.zip", endpoint = EXPORT_ENDPOINT } = options;
  if ((day === undefined) === (month === undefined)) {
    throw new ExportError("Provide exactly one of `day` or `month`.");
  }
  if (day !== undefined && !DAY_RE.test(day)) {
    throw new ExportError(`\`day\` must be YYYY-MM-DD, received ${JSON.stringify(day)}.`);
  }
  if (month !== undefined && !MONTH_RE.test(month)) {
    throw new ExportError(`\`month\` must be YYYY-MM, received ${JSON.stringify(month)}.`);
  }
  const key = day !== undefined ? "pubDay" : "pubMonth";
  const value = day ?? (month as string);
  return `${endpoint}?${key}=${value}&format=${format}`;
}

/**
 * Download one export archive.
 *
 * Sends no conditional headers, by design. See the note above.
 */
export async function fetchExport(options: FetchExportOptions): Promise<ExportArchive> {
  const { format = "eforms.zip", signal, fetchImpl = fetch } = options;
  const url = exportUrl(options);
  const resource = url.slice(url.indexOf("?") + 1).replace(`&format=${format}`, "");

  const response = await fetchImpl(url, {
    // No If-None-Match, no If-Modified-Since: the server's validator is not
    // resource-specific and replaying it silently suppresses real data.
    cache: "no-store",
    redirect: "follow",
    ...(signal ? { signal } : {}),
    headers: { Accept: "application/zip" },
  });

  if (response.status === 304) {
    throw new ExportError(
      "Server returned 304 Not Modified for a request that carried no validator. " +
        "An intermediary cache is replaying the endpoint's non-resource-specific ETag; " +
        "the response body would be empty. Bypass the cache rather than treating this as no data.",
      304,
    );
  }
  if (!response.ok) {
    throw new ExportError(
      `Export request for ${resource} failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ExportError(`Export for ${resource} returned an empty body.`);
  }
  return {
    bytes,
    format,
    resource,
    etag: response.headers.get("etag") ?? undefined,
  };
}
