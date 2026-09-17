# @openeforms/lineage

Groups eForms notices into procurement procedures, and says what changed when a
notice is corrected.

Part of [OpenEForms](https://github.com/NodrrS/openeforms).

```ts
import { parseNotice } from "@openeforms/core";
import { ProcedureIndex, diffTrees, ROUTINE_VERSION_FIELDS } from "@openeforms/lineage";

const index = new ProcedureIndex();
for (const xml of notices) index.add(parseNotice(xml), { source: "2026-08" });

index.coverage();          // what could and could not be linked
index.byStage("awarded");  // procedures that concluded
index.get("FOLDER-1");     // one procedure, with its timeline

diffTrees(v1.root, v2.root, { ignore: ROUTINE_VERSION_FIELDS });
```

## Coverage is a result, not a footnote

`cbc:ContractFolderID` is what links the notices of one procurement. It is
frequently absent, so any honest index has to say how much of its input it
could actually use.

Measured over August 2026, and reproduced exactly by this package's own test
suite:

| | |
| --- | --- |
| Notices indexed | 22,892 |
| Linked to a procedure | 14,130 |
| **Unlinkable, no identifier** | **8,762 (38.3%)** |
| of those, on the minimal profile | 8,627 |
| of those, on the full German profile | 135 |
| Distinct procedures | 12,999 |

Below-threshold procurement, published under the minimal `eforms-sdk-0.1`
profile, is 93% unlinkable. No tool can reconstruct those lifecycles from this
data, and one that appears to is wrong. `coverage()` reports the gap and
`unlinked()` lists the notices with a reason for each, so the limit can be
quoted rather than discovered later.

## Lineage needs more than one export

Within a single month almost every procedure appears once: of 12,999 folders in
August 2026, only 863 held more than one notice, because a procurement's prior
information notice, contract notice and award notice are months apart. The
index accumulates, merges and serialises for exactly this reason.

```ts
const snapshot = index.toJSON();               // plain JSON, persist anywhere
const restored = ProcedureIndex.fromJSON(snapshot);
restored.merge(nextMonthsIndex);
```

Storage is left to the caller. The index holds small summaries rather than
documents, so a JSON snapshot is practical at national scale.

## What a corrigendum actually changed

A republished notice announces a new version and says nothing about what
differs. `diffTrees` compares the two documents and reports it. On a real
August 2026 corrigendum:

```
cac:ProcurementProjectLot/cac:TenderingProcess/…/cbc:EndDate
  "2026-09-10+02:00" → "2026-09-24+02:00"
cac:ProcurementProjectLot/cac:TenderingProcess/…/cbc:EndTime
  "13:30:00+02:00" → "11:15:00+02:00"
cbc:NoticeTypeCode/@listName
  "competition" → "change"
```

The tender deadline moved two weeks and the cut-off time moved earlier. That is
the thing a bidder needs to know, and nothing in the feed surfaces it.

Paths are namespace-qualified with the standard eForms prefixes, never the ones
the document happened to use, so two notices differing only in XML prefixes
produce an empty diff. Pass `ROUTINE_VERSION_FIELDS` as `ignore` to suppress
the identifier, version and timestamp fields that change on every
republication.

## Version numbers

The feed publishes version tokens both zero-padded and unpadded, so `01` and
`1` denote the same version while comparing unequal as strings. The index
normalises before keying: offering both spellings of one notice registers one
version, not two, and counts as a duplicate rather than a correction.

## What the index tells you

| Method | Result |
| --- | --- |
| `add(notice, { source })` | Linked, or not linked with the reason |
| `procedures()` | Every procedure, ordered by first issue date |
| `get(folderId)` | One procedure with its timeline and stage |
| `byStage(stage)` | `planning`, `open`, `awarded` or `unknown` |
| `coverage()` | What was linked, what was not, and why |
| `unlinked()` | The notices that could not be linked |
| `toJSON()` / `fromJSON()` / `merge()` | Persist and combine across exports |

Stage is inferred from the notice kinds present: an award notice means
concluded, a contract notice means open, a prior information notice alone means
announced. Across August 2026 that gives 7,347 open, 5,630 awarded and 22
planning.

## Verified

The corpus test indexes the whole monthly export and asserts its figures
against those measured independently by
[openeforms-probe](https://github.com/NodrrS/openeforms-probe), which uses a
different language and a different XML parser. Every count matches, and one
invariant holds that neither tool was built to check: folders with more than
one notice (863) equals procedures with more than one distinct notice (825)
plus procedures with a corrected notice (38).

MIT.
