# OpenEForms

Open tools for European public procurement notices, in TypeScript.

[eForms](https://docs.ted.europa.eu/eforms/latest/) is the mandatory standard for
procurement notices across the EU. Every working implementation of it is written in Java
and addressed to institutions with an IT department. Germany's notice service publishes
around 23,000 notices a month under a public-domain dedication, and in practice almost
nobody reads them except commercial alert services that charge for access.

The obstacle is not the licence. It is the dependency.

## Status

Early. `@openeforms/core` parses and normalises notices and is tested against a full
month of production data. `@openeforms/efx` implements the EFX expression
language and translates it to XPath. The remaining three packages are not
written yet.

| Package | Purpose | State |
| --- | --- | --- |
| [`@openeforms/core`](packages/core) | Namespace-aware parser, normalised notice model, export ingest | **working, tested** |
| [`@openeforms/efx`](packages/efx) | EFX parser and XPath translator, no JVM | **working, tested** |
| `@openeforms/validate` | Schematron validation via SchXslt and SaxonJS | planned |
| `@openeforms/lineage` | Procedure index over `ContractFolderID`, notice-version diffing | planned |
| `@openeforms/cli` | Command-line ingest, validation and reporting | planned |

## Why it is built this way

Three design decisions, each forced by measurement rather than by reading the
specification. The measurements are in a separate repository,
[openeforms-probe](https://github.com/NodrrS/openeforms-probe), which anyone can re-run.

**Elements are addressed by namespace and local name, never by prefix.** Seven distinct
prefixes carry the same root elements in one month of German data: `ns7:`, `ns8:`, `ns9:`,
`cn:`, `can:`, `pin:`, and no prefix at all. Prefix matching works on some notices and
fails on others without raising anything, which is the worst kind of bug.

**All three circulating customisation generations parse.** `eforms-de-2.1` is 59.2% of
the feed, `eforms-sdk-0.1` is 40.6%, `eforms-sdk-1.0` is 0.2%. A reader targeting only
the current German profile silently drops two fifths of the data.

**Absent values stay absent.** `cbc:ContractFolderID`, which links the notices of one
procurement, is missing on 38.3% of notices and on 92.8% of those using the minimal
profile. The model types it as optional and records the reason in `diagnostics`, so a
caller can distinguish "not published" from "we failed to read it". Any lineage feature
built on this data has to state its coverage rather than imply completeness.

A fourth decision lives in the ingest layer. The export returns one `ETag` per format,
identical for every day and month, so replaying it as `If-None-Match` makes the server
answer `304` with an empty body for data you have never fetched. `fetchExport` sends no
conditional headers and treats an unexpected `304` as an error, never as an empty day.

## Use

```bash
npm install @openeforms/core
```

```ts
import { parseNotice, keyOf } from "@openeforms/core";

const notice = parseNotice(await readFile("notice.xml"));

notice.kind;              // "ContractNotice"
notice.profile.family;    // "eforms-de"
notice.profile.minimal;   // false
notice.version;           // { raw: "01", number: 1, zeroPadded: true }
keyOf(notice);            // "abc@1" — same for a notice published as "1"
notice.contractFolderId;  // string | undefined, genuinely
notice.legalBasis;        // { raw: "VOB/A", code: "vob-a", scope: "below" }
notice.lots;              // [{ id, title, cpv, tenderDeadline }]
notice.diagnostics;       // what was absent or unrecognised, never thrown
```

Fetching is separate from parsing, so the library is usable against archives you already
have:

```ts
import { fetchExport } from "@openeforms/core";

const archive = await fetchExport({ day: "2026-09-09" });  // eForms zip bytes
```

## Develop

Requires Node 20 or newer. Node 22 runs the TypeScript sources directly.

```bash
npm install
npm test          # 27 unit tests, no network, no fixtures
npm run build
```

The corpus test checks the parser against a real monthly export and skips itself when the
fixture is absent:

```bash
mkdir -p .fixtures
curl -o .fixtures/2026-08-eforms.zip \
  "https://oeffentlichevergabe.de/api/notice-exports?pubMonth=2026-08&format=eforms.zip"
unzip -q .fixtures/2026-08-eforms.zip -d .fixtures/2026-08
node --test packages/core/test/corpus.test.ts
```

It parses all 22,892 notices and asserts that the counts match those measured
independently by the Python probe, which uses a different XML parser. Two implementations
agreeing on that many production documents is the point; a disagreement means one of them
is wrong.

## Licence

MIT. The notice data is CC0 and belongs to its publisher.
