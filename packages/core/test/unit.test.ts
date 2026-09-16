import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DOC_NS,
  NS,
  child,
  childText,
  descendants,
  keyOf,
  noticeKey,
  normaliseLegalBasisCode,
  parseExportFilename,
  parseLegalBasis,
  parseNotice,
  parseProfile,
  parseVersion,
  parseXml,
  prefixesOf,
  tryParseNotice,
  exportUrl,
  ExportError,
  fetchExport,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Version tokens: the 01 / 1 collision the export actually publishes.
// ---------------------------------------------------------------------------

describe("version tokens", () => {
  it("normalises zero-padded and unpadded tokens to the same number", () => {
    assert.equal(parseVersion("01").number, 1);
    assert.equal(parseVersion("1").number, 1);
    assert.equal(parseVersion("10").number, 10);
  });

  it("records whether the published token was padded", () => {
    assert.equal(parseVersion("01").zeroPadded, true);
    assert.equal(parseVersion("1").zeroPadded, false);
    // "0" alone is not padding, it is the number zero.
    assert.equal(parseVersion("0").zeroPadded, false);
  });

  it("preserves the raw token for round-tripping", () => {
    assert.equal(parseVersion("03").raw, "03");
  });

  it("produces one key for both spellings of the same version", () => {
    assert.equal(noticeKey("abc", "01"), noticeKey("abc", "1"));
    assert.equal(noticeKey("abc", "01"), "abc@1");
  });

  it("rejects tokens that are not digit runs", () => {
    assert.throws(() => parseVersion("1a"), /Not a valid notice version token/);
    assert.throws(() => parseVersion(""), /Not a valid notice version token/);
  });

  it("splits export filenames on the final digit run", () => {
    assert.deepEqual(
      parseExportFilename("52abdce9-6fb0-4b35-a30e-fd99bed7bd4d-10.xml"),
      {
        id: "52abdce9-6fb0-4b35-a30e-fd99bed7bd4d",
        version: { raw: "10", number: 10, zeroPadded: false },
      },
    );
    assert.equal(parseExportFilename("1234567-1.xml")?.id, "1234567");
    assert.equal(parseExportFilename("not-a-notice.txt"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Profiles: three generations circulate at once.
// ---------------------------------------------------------------------------

describe("customisation profiles", () => {
  it("classifies the three generations seen in production", () => {
    const de = parseProfile("eforms-de-2.1");
    assert.equal(de.family, "eforms-de");
    assert.equal(de.version, "2.1");
    assert.equal(de.minimal, false);

    const minimal = parseProfile("eforms-sdk-0.1");
    assert.equal(minimal.family, "eforms-sdk");
    assert.equal(minimal.minimal, true);

    const eu = parseProfile("eforms-sdk-1.0");
    assert.equal(eu.family, "eforms-sdk");
    assert.equal(eu.minimal, false);
  });

  it("does not guess at unknown or absent identifiers", () => {
    assert.equal(parseProfile(undefined).family, "unknown");
    assert.equal(parseProfile("something-else").family, "unknown");
    assert.equal(parseProfile("").family, "unknown");
  });
});

// ---------------------------------------------------------------------------
// Legal basis: the VOB/A vs vob-a spelling split.
// ---------------------------------------------------------------------------

describe("legal basis", () => {
  it("folds the spelling variants the feed publishes", () => {
    assert.equal(normaliseLegalBasisCode("VOB/A"), "vob-a");
    assert.equal(normaliseLegalBasisCode("vob-a"), "vob-a");
    assert.equal(normaliseLegalBasisCode("UVgO"), "uvgo");
    assert.equal(normaliseLegalBasisCode("uvgo"), "uvgo");
  });

  it("gives both spellings the same classification", () => {
    assert.equal(parseLegalBasis("VOB/A")?.scope, "below");
    assert.equal(parseLegalBasis("vob-a")?.scope, "below");
    assert.equal(parseLegalBasis("vob-a-eu")?.scope, "above");
    assert.equal(parseLegalBasis("vgv")?.scope, "above");
  });

  it("reports unknown rather than guessing", () => {
    assert.equal(parseLegalBasis("CrossBorderLaw")?.scope, "unknown");
    assert.equal(parseLegalBasis(undefined), undefined);
  });

  it("keeps the raw value", () => {
    assert.equal(parseLegalBasis("VOB/A")?.raw, "VOB/A");
  });
});

// ---------------------------------------------------------------------------
// The central claim: identical documents under different prefixes parse alike.
// ---------------------------------------------------------------------------

const BODY = `
  <cbc:CustomizationID>eforms-de-2.1</cbc:CustomizationID>
  <cbc:ID>11111111-2222-3333-4444-555555555555</cbc:ID>
  <cbc:ContractFolderID>FOLDER-1</cbc:ContractFolderID>
  <cbc:IssueDate>2026-08-03</cbc:IssueDate>
  <cbc:VersionID>01</cbc:VersionID>
  <cac:ProcurementLegislationDocumentReference>
    <cbc:ID>VOB/A</cbc:ID>
  </cac:ProcurementLegislationDocumentReference>
  <cac:ProcurementProjectLot>
    <cbc:ID schemeName="Lot">LOT-0001</cbc:ID>
    <cac:ProcurementProject>
      <cbc:Name>Dachsanierung Grundschule</cbc:Name>
      <cac:MainCommodityClassification>
        <cbc:ItemClassificationCode>45261910</cbc:ItemClassificationCode>
      </cac:MainCommodityClassification>
    </cac:ProcurementProject>
  </cac:ProcurementProjectLot>
`;

function doc(prefix: string | null): string {
  const p = prefix ? `${prefix}:` : "";
  const decl = prefix
    ? `xmlns:${prefix}="${DOC_NS.ContractNotice}"`
    : `xmlns="${DOC_NS.ContractNotice}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<${p}ContractNotice ${decl} xmlns:cbc="${NS.CBC}" xmlns:cac="${NS.CAC}">
${BODY}
</${p}ContractNotice>`;
}

describe("namespace-aware parsing", () => {
  // Every prefix the probe observed on real root elements.
  const prefixes = [null, "ns7", "ns8", "ns9", "cn", "can", "pin"];

  it("yields an identical model regardless of the root prefix", () => {
    const models = prefixes.map((p) => {
      const n = parseNotice(doc(p));
      return {
        kind: n.kind,
        noticeId: n.noticeId,
        contractFolderId: n.contractFolderId,
        version: n.version?.number,
        profile: n.profile.family,
        basis: n.legalBasis?.code,
        scope: n.legalBasis?.scope,
        lots: n.lots.map((l) => `${l.id}:${l.cpv}`),
      };
    });
    const [first, ...rest] = models;
    for (const m of rest) assert.deepEqual(m, first);
    assert.equal(first?.noticeId, "11111111-2222-3333-4444-555555555555");
    assert.equal(first?.version, 1);
    assert.equal(first?.basis, "vob-a");
    assert.deepEqual(first?.lots, ["LOT-0001:45261910"]);
  });

  it("reports the prefix actually used, without dispatching on it", () => {
    assert.ok(prefixesOf(parseNotice(doc("ns9"))).includes("ns9"));
    assert.ok(prefixesOf(parseNotice(doc(null))).includes(""));
  });

  it("does not confuse identical local names in different namespaces", () => {
    // cbc:ID and the lot's cbc:ID are both "ID"; a prefix-blind or
    // namespace-blind reader would collapse them.
    const n = parseNotice(doc(null));
    assert.equal(n.noticeId, "11111111-2222-3333-4444-555555555555");
    assert.equal(n.lots[0]?.id, "LOT-0001");
  });

  it("reads attributes by namespace", () => {
    const root = parseXml(doc(null));
    const lot = child(root, NS.CAC, "ProcurementProjectLot");
    const id = child(lot, NS.CBC, "ID");
    assert.equal(id?.attrs.get("|schemeName"), "Lot");
  });
});

// ---------------------------------------------------------------------------
// Absence is data, not failure.
// ---------------------------------------------------------------------------

describe("missing fields", () => {
  const minimal = `<?xml version="1.0" encoding="UTF-8"?>
<ContractNotice xmlns="${DOC_NS.ContractNotice}" xmlns:cbc="${NS.CBC}">
  <cbc:CustomizationID>eforms-sdk-0.1</cbc:CustomizationID>
  <cbc:ID>abc</cbc:ID>
  <cbc:VersionID>1</cbc:VersionID>
</ContractNotice>`;

  it("leaves an absent procedure identifier undefined and says so", () => {
    const n = parseNotice(minimal);
    assert.equal(n.contractFolderId, undefined);
    const codes = n.diagnostics.map((d) => d.code);
    assert.ok(codes.includes("missing-contract-folder-id"));
    assert.ok(codes.includes("missing-legal-basis"));
  });

  it("explains that absence is expected on the minimal profile", () => {
    const n = parseNotice(minimal);
    const d = n.diagnostics.find((x) => x.code === "missing-contract-folder-id");
    assert.match(d!.message, /minimal profile/);
  });

  it("still keys a notice that has an id and version", () => {
    assert.equal(keyOf(parseNotice(minimal)), "abc@1");
  });

  it("rejects a document that is not a notice", () => {
    const r = tryParseNotice(
      `<?xml version="1.0"?><Invoice xmlns="urn:example"/>`,
    );
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: Error }).error.message, /not an eForms notice/);
  });

  it("reports malformed XML as a parse error, not a silent empty model", () => {
    const r = tryParseNotice("<ContractNotice><unclosed>");
    assert.equal(r.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Ingest: never replay the endpoint's non-resource-specific validator.
// ---------------------------------------------------------------------------

describe("export ingest", () => {
  it("builds the documented URL shape", () => {
    assert.equal(
      exportUrl({ day: "2026-09-09" }),
      "https://oeffentlichevergabe.de/api/notice-exports?pubDay=2026-09-09&format=eforms.zip",
    );
    assert.equal(
      exportUrl({ month: "2026-08", format: "ocds.zip" }),
      "https://oeffentlichevergabe.de/api/notice-exports?pubMonth=2026-08&format=ocds.zip",
    );
  });

  it("requires exactly one of day or month", () => {
    assert.throws(() => exportUrl({}), ExportError);
    assert.throws(() => exportUrl({ day: "2026-09-09", month: "2026-08" }), ExportError);
    assert.throws(() => exportUrl({ day: "09-09-2026" }), /YYYY-MM-DD/);
  });

  it("sends no conditional headers", async () => {
    let seen: HeadersInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen = init?.headers;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { etag: '"version-0"' },
      });
    };
    await fetchExport({ day: "2026-09-09", fetchImpl });
    const keys = Object.keys((seen ?? {}) as Record<string, string>).map((k) =>
      k.toLowerCase(),
    );
    assert.ok(!keys.includes("if-none-match"));
    assert.ok(!keys.includes("if-modified-since"));
  });

  it("treats a 304 as an error rather than as an empty day", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 304 });
    await assert.rejects(
      fetchExport({ day: "2026-06-03", fetchImpl }),
      /cache is replaying|304/,
    );
  });

  it("rejects an empty body instead of reporting zero notices", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array(), { status: 200 });
    await assert.rejects(fetchExport({ day: "2026-06-03", fetchImpl }), /empty body/);
  });

  it("records the server validator without reusing it", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { etag: '"version-0"' },
      });
    const archive = await fetchExport({ day: "2026-09-09", fetchImpl });
    assert.equal(archive.etag, '"version-0"');
    assert.equal(archive.resource, "pubDay=2026-09-09");
  });
});
