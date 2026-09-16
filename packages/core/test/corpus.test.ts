/**
 * Differential test against the real feed.
 *
 * Parses every notice in one monthly export and checks the results against
 * figures measured independently, by a Python implementation using a different
 * XML parser, in https://github.com/NodrrS/openeforms-probe.
 *
 * Two implementations agreeing on 22,892 production documents is the point.
 * If this test and the probe ever disagree, one of them has a bug.
 *
 * Fixtures are not committed (546 MB extracted). To run:
 *
 *   curl -o .fixtures/2026-08-eforms.zip \
 *     "https://oeffentlichevergabe.de/api/notice-exports?pubMonth=2026-08&format=eforms.zip"
 *   unzip -q .fixtures/2026-08-eforms.zip -d .fixtures/2026-08
 *   node --test packages/core/test/corpus.test.ts
 *
 * The suite skips itself when the fixture directory is absent, so a plain
 * `npm test` works on a fresh clone.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  parseExportFilename,
  prefixesUsed,
  tryParseNotice,
  type Notice,
} from "../src/index.ts";

const DIR = new URL("../../../.fixtures/2026-08/", import.meta.url).pathname;
const AVAILABLE = existsSync(DIR);

/** Figures measured by openeforms-probe over the August 2026 export. */
const PROBE = {
  notices: 22_892,
  parseErrors: 0,
  customizationIds: {
    "eforms-de-2.1": 13_561,
    "eforms-sdk-0.1": 9_293,
    "eforms-sdk-1.0": 38,
  },
  rootElements: {
    ContractNotice: 14_519,
    ContractAwardNotice: 8_214,
    PriorInformationNotice: 159,
  },
  distinctRootPrefixes: 7,
  missingContractFolderId: 8_762,
  minimalProfileMissingFolderId: 8_627,
  distinctContractFolders: 12_999,
  legalBasisAbsent: 9_299,
} as const;

interface Summary {
  notices: number;
  parseErrors: number;
  customization: Map<string, number>;
  kinds: Map<string, number>;
  rootPrefixes: Set<string>;
  missingFolderId: number;
  minimalMissingFolderId: number;
  folders: Set<string>;
  legalBasisAbsent: number;
  legalBasisRaw: Map<string, number>;
  paddedVersions: number;
  unpaddedVersions: number;
  filenameVersionMismatches: number;
}

let summary: Summary;

function summarise(): Summary {
  const s: Summary = {
    notices: 0,
    parseErrors: 0,
    customization: new Map(),
    kinds: new Map(),
    rootPrefixes: new Set(),
    missingFolderId: 0,
    minimalMissingFolderId: 0,
    folders: new Set(),
    legalBasisAbsent: 0,
    legalBasisRaw: new Map(),
    paddedVersions: 0,
    unpaddedVersions: 0,
    filenameVersionMismatches: 0,
  };

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const name of readdirSync(DIR)) {
    if (!name.endsWith(".xml")) continue;
    s.notices++;
    const result = tryParseNotice(readFileSync(join(DIR, name)));
    if (!result.ok) {
      s.parseErrors++;
      continue;
    }
    const n: Notice = result.notice;

    bump(s.customization, n.profile.raw ?? "(absent)");
    bump(s.kinds, n.kind);

    // Prefix of the root element only, which is what the probe counted.
    s.rootPrefixes.add(n.root.prefix);

    if (!n.contractFolderId) {
      s.missingFolderId++;
      if (n.profile.minimal) s.minimalMissingFolderId++;
    } else {
      s.folders.add(n.contractFolderId);
    }

    if (n.legalBasis) bump(s.legalBasisRaw, n.legalBasis.raw);
    else s.legalBasisAbsent++;

    if (n.version?.zeroPadded) s.paddedVersions++;
    else if (n.version) s.unpaddedVersions++;

    const fromName = parseExportFilename(name);
    if (fromName && n.version && fromName.version.number !== n.version.number) {
      s.filenameVersionMismatches++;
    }
  }
  return s;
}

describe("corpus: August 2026 export", { skip: AVAILABLE ? false : "fixtures not present" }, () => {
  before(() => {
    summary = summarise();
  });

  it("parses every notice without error", () => {
    assert.equal(summary.notices, PROBE.notices);
    assert.equal(summary.parseErrors, PROBE.parseErrors);
  });

  it("reproduces the customisation-generation split", () => {
    for (const [id, expected] of Object.entries(PROBE.customizationIds)) {
      assert.equal(summary.customization.get(id), expected, `count for ${id}`);
    }
    assert.equal(summary.customization.size, 3, "exactly three generations");
  });

  it("reproduces the notice-kind split", () => {
    for (const [kind, expected] of Object.entries(PROBE.rootElements)) {
      assert.equal(summary.kinds.get(kind), expected, `count for ${kind}`);
    }
  });

  it("sees the same seven root prefixes and is unaffected by them", () => {
    assert.equal(summary.rootPrefixes.size, PROBE.distinctRootPrefixes);
    // The unprefixed form is present, so prefix-blind code would work on some
    // documents and fail on others, which is what makes the bug so quiet.
    assert.ok(summary.rootPrefixes.has(""));
  });

  it("reproduces the missing procedure identifier counts", () => {
    assert.equal(summary.missingFolderId, PROBE.missingContractFolderId);
    assert.equal(summary.minimalMissingFolderId, PROBE.minimalProfileMissingFolderId);
    assert.equal(summary.folders.size, PROBE.distinctContractFolders);
  });

  it("reproduces the absent legal-basis count", () => {
    assert.equal(summary.legalBasisAbsent, PROBE.legalBasisAbsent);
  });

  it("folds the legal-basis spelling variants the feed really publishes", () => {
    // Both spellings occur in this month; normalisation must merge them.
    assert.ok(summary.legalBasisRaw.has("VOB/A"), "raw VOB/A present");
    assert.ok(summary.legalBasisRaw.has("vob-a"), "raw vob-a present");
    assert.ok(summary.legalBasisRaw.has("UVgO"), "raw UVgO present");
    assert.ok(summary.legalBasisRaw.has("uvgo"), "raw uvgo present");
  });

  it("sees both version-token styles and agrees with the filename", () => {
    assert.ok(summary.paddedVersions > 0, "zero-padded tokens present");
    assert.ok(summary.unpaddedVersions > 0, "unpadded tokens present");
    // Normalisation means the filename token and the element token always
    // resolve to the same number, despite differing in padding.
    assert.equal(summary.filenameVersionMismatches, 0);
  });
});
