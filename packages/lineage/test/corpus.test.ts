/**
 * Differential test against the real feed.
 *
 * Indexes a whole monthly export and checks the coverage figures against those
 * measured independently, by a Python implementation using a different XML
 * parser, in https://github.com/NodrrS/openeforms-probe.
 *
 * Fixtures are not committed. To run:
 *
 *   mkdir -p .fixtures && cd .fixtures
 *   curl -o 2026-08-eforms.zip \
 *     "https://oeffentlichevergabe.de/api/notice-exports?pubMonth=2026-08&format=eforms.zip"
 *   unzip -q 2026-08-eforms.zip -d 2026-08
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseNotice, parseXml } from "@openeforms/core";

import {
  ProcedureIndex, diffTrees, ROUTINE_VERSION_FIELDS, type Coverage,
} from "../src/index.ts";

const NOTICES = new URL("../../../.fixtures/2026-08/", import.meta.url).pathname;
const AVAILABLE = existsSync(NOTICES);

/** Figures measured by openeforms-probe over the August 2026 export. */
const PROBE = {
  notices: 22_892,
  missingContractFolderId: 8_762,
  minimalProfileMissing: 8_627,
  fullProfileMissing: 135,
  distinctContractFolders: 12_999,
  foldersWithMoreThanOneNotice: 863,
} as const;

describe("corpus: indexing the August 2026 export", { skip: AVAILABLE ? false : "fixtures not present" }, () => {
  let index: ProcedureIndex;
  let coverage: Coverage;

  before(() => {
    index = new ProcedureIndex();
    for (const file of readdirSync(NOTICES)) {
      if (!file.endsWith(".xml")) continue;
      index.add(parseNotice(readFileSync(join(NOTICES, file))), { source: file });
    }
    coverage = index.coverage();
  });

  it("sees every notice and loses none", () => {
    assert.equal(coverage.noticesSeen, PROBE.notices);
    assert.equal(coverage.linked + coverage.unlinked + coverage.unusable, coverage.noticesSeen);
    assert.equal(coverage.unusable, 0, "every notice had a usable id and version");
  });

  it("reproduces the probe's count of unlinkable notices", () => {
    assert.equal(coverage.unlinked, PROBE.missingContractFolderId);
    assert.equal(coverage.linked, PROBE.notices - PROBE.missingContractFolderId);
  });

  it("reproduces the split of unlinkable notices by profile", () => {
    assert.equal(coverage.unlinkedByProfile["eforms-sdk-0.1"], PROBE.minimalProfileMissing);
    assert.equal(coverage.unlinkedByProfile["eforms-de-2.1"], PROBE.fullProfileMissing);
  });

  it("reproduces the number of distinct procedures", () => {
    assert.equal(coverage.procedures, PROBE.distinctContractFolders);
  });

  it("reproduces the number of folders holding more than one notice", () => {
    const multiFile = index.procedures().filter((p) => p.notices.length > 1).length;
    assert.equal(multiFile, PROBE.foldersWithMoreThanOneNotice);
  });

  it("is internally consistent about what a second notice means", () => {
    // A folder can hold two notices either because the procedure has two
    // distinct notices, or because one notice was corrected. Those two counts
    // must add up to the folders holding more than one notice.
    const multiFile = index.procedures().filter((p) => p.notices.length > 1).length;
    assert.equal(
      coverage.proceduresWithMultipleNotices + coverage.proceduresWithCorrections,
      multiFile,
      "distinct-notice procedures plus corrected procedures should equal multi-notice folders",
    );
  });

  it("classifies every procedure into a stage", () => {
    const procedures = index.procedures();
    const staged =
      index.byStage("planning").length +
      index.byStage("open").length +
      index.byStage("awarded").length +
      index.byStage("unknown").length;
    assert.equal(staged, procedures.length);
    // Real data: mostly open and awarded, few planning notices.
    assert.ok(index.byStage("awarded").length > 1000);
    assert.ok(index.byStage("open").length > 1000);
  });

  it("survives a snapshot round trip at full scale", () => {
    const restored = ProcedureIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
    assert.deepEqual(restored.coverage(), coverage);
  });

  it("diffs a real corrigendum and finds the substantive change", () => {
    // Find a notice published in more than one version in this export.
    const byId = new Map<string, Array<{ file: string; version: number }>>();
    for (const file of readdirSync(NOTICES)) {
      const m = /^(.+)-(\d+)\.xml$/.exec(file);
      if (!m?.[1] || !m[2]) continue;
      const list = byId.get(m[1]) ?? [];
      list.push({ file, version: Number.parseInt(m[2], 10) });
      byId.set(m[1], list);
    }
    const corrected = [...byId.values()].filter((v) => v.length > 1);
    assert.ok(corrected.length > 50, `expected many corrected notices, found ${corrected.length}`);

    let withSubstantiveChange = 0;
    for (const versions of corrected.slice(0, 20)) {
      versions.sort((a, b) => a.version - b.version);
      const first = versions[0];
      const last = versions[versions.length - 1];
      if (!first || !last) continue;
      const changes = diffTrees(
        parseXml(readFileSync(join(NOTICES, first.file))),
        parseXml(readFileSync(join(NOTICES, last.file))),
        { ignore: ROUTINE_VERSION_FIELDS },
      );
      if (changes.length > 0) withSubstantiveChange++;
      for (const c of changes) {
        assert.ok(c.path.startsWith("/"), `path should be rooted: ${c.path}`);
        assert.ok(["added", "removed", "changed"].includes(c.kind));
      }
    }
    // A corrigendum that changes nothing but the version would be odd.
    assert.ok(
      withSubstantiveChange > 10,
      `only ${withSubstantiveChange} of 20 corrigenda changed anything substantive`,
    );
  });
});
