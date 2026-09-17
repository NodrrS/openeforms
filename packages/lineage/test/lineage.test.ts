import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DOC_NS, NS, parseNotice, parseXml } from "@openeforms/core";

import {
  ProcedureIndex, buildTimeline, diffTrees, flatten, stageOf, summarise,
  touchedSections, ROUTINE_VERSION_FIELDS,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface NoticeSpec {
  kind?: keyof typeof DOC_NS;
  prefix?: string | null;
  id: string;
  version: string;
  folder?: string | null;
  issueDate?: string;
  profile?: string;
  body?: string;
}

function notice(spec: NoticeSpec): string {
  const kind = spec.kind ?? "ContractNotice";
  const p = spec.prefix === undefined ? null : spec.prefix;
  const tag = p ? `${p}:${kind}` : kind;
  const decl = p ? `xmlns:${p}="${DOC_NS[kind]}"` : `xmlns="${DOC_NS[kind]}"`;
  const folder = spec.folder === null
    ? ""
    : `<cbc:ContractFolderID>${spec.folder ?? "FOLDER-1"}</cbc:ContractFolderID>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<${tag} ${decl} xmlns:cbc="${NS.CBC}" xmlns:cac="${NS.CAC}">
  <cbc:CustomizationID>${spec.profile ?? "eforms-de-2.1"}</cbc:CustomizationID>
  <cbc:ID>${spec.id}</cbc:ID>
  <cbc:VersionID>${spec.version}</cbc:VersionID>
  ${folder}
  ${spec.issueDate ? `<cbc:IssueDate>${spec.issueDate}</cbc:IssueDate>` : ""}
  ${spec.body ?? ""}
</${tag}>`;
}

const parse = (spec: NoticeSpec) => parseNotice(notice(spec));

// ---------------------------------------------------------------------------

describe("indexing", () => {
  it("groups notices sharing a procedure identifier", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01", issueDate: "2026-03-01" }));
    index.add(parse({ id: "N2", version: "01", kind: "ContractAwardNotice", issueDate: "2026-06-01" }));

    const procedures = index.procedures();
    assert.equal(procedures.length, 1);
    assert.equal(procedures[0]?.contractFolderId, "FOLDER-1");
    assert.equal(procedures[0]?.timeline.length, 2);
  });

  it("keeps separate procedures apart", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01", folder: "A" }));
    index.add(parse({ id: "N2", version: "01", folder: "B" }));
    assert.equal(index.procedures().length, 2);
    assert.equal(index.get("A")?.timeline.length, 1);
  });

  it("treats the two version spellings as one notice", () => {
    const index = new ProcedureIndex();
    // The feed publishes both "01" and "1" for version one.
    index.add(parse({ id: "N1", version: "01" }));
    index.add(parse({ id: "N1", version: "1" }));

    const p = index.get("FOLDER-1");
    assert.equal(p?.timeline.length, 1);
    assert.equal(p?.timeline[0]?.versions.length, 1, "01 and 1 must not count twice");
    assert.equal(index.coverage().duplicatesIgnored, 1);
  });

  it("records every version of a corrected notice", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01" }));
    index.add(parse({ id: "N1", version: "02" }));
    index.add(parse({ id: "N1", version: "03" }));

    const entry = index.get("FOLDER-1")?.timeline[0];
    assert.deepEqual(entry?.versions, [1, 2, 3]);
    assert.equal(entry?.latestVersion, 3);
    assert.equal(entry?.corrected, true);
    assert.equal(index.get("FOLDER-1")?.hasCorrections, true);
  });

  it("reports when a notice arrives out of version order", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "02" }));
    const r = index.add(parse({ id: "N1", version: "01" }));
    assert.equal(r.linked, true);
    assert.equal(r.linked && r.superseded, true);
    // The later version still wins.
    assert.equal(index.get("FOLDER-1")?.timeline[0]?.latestVersion, 2);
  });

  it("merges two indexes without double-counting", () => {
    const a = new ProcedureIndex();
    a.add(parse({ id: "N1", version: "01" }));
    const b = new ProcedureIndex();
    b.add(parse({ id: "N1", version: "01" }));
    b.add(parse({ id: "N2", version: "01" }));

    a.merge(b);
    assert.equal(a.get("FOLDER-1")?.timeline.length, 2);
    assert.ok(a.coverage().duplicatesIgnored >= 1);
  });

  it("round-trips through a snapshot", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01", issueDate: "2026-01-01" }));
    index.add(parse({ id: "N2", version: "01", folder: null }));

    const restored = ProcedureIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
    assert.deepEqual(restored.coverage(), index.coverage());
    assert.deepEqual(restored.get("FOLDER-1")?.timeline, index.get("FOLDER-1")?.timeline);
  });
});

// ---------------------------------------------------------------------------

describe("coverage is reported, not hidden", () => {
  it("counts notices with no procedure identifier instead of dropping them", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01" }));
    index.add(parse({ id: "N2", version: "01", folder: null, profile: "eforms-sdk-0.1" }));
    index.add(parse({ id: "N3", version: "01", folder: null, profile: "eforms-sdk-0.1" }));

    const c = index.coverage();
    assert.equal(c.noticesSeen, 3);
    assert.equal(c.linked, 1);
    assert.equal(c.unlinked, 2);
    assert.equal(c.unlinkedByProfile["eforms-sdk-0.1"], 2);
    assert.equal(c.procedures, 1);
  });

  it("lists the unlinkable notices with a reason", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N2", version: "01", folder: null }), { source: "2026-08.zip" });

    const unlinked = index.unlinked();
    assert.equal(unlinked.length, 1);
    assert.equal(unlinked[0]?.reason, "no-contract-folder-id");
    assert.equal(unlinked[0]?.source, "2026-08.zip");
  });

  it("never loses a notice: linked plus unlinked plus unusable equals seen", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01" }));
    index.add(parse({ id: "N2", version: "01", folder: null }));
    index.add(parse({ id: "N3", version: "01", folder: "B" }));
    index.add(parse({ id: "N4", version: "01", folder: null }));

    const c = index.coverage();
    assert.equal(c.linked + c.unlinked + c.unusable, c.noticesSeen);
  });

  it("counts procedures with more than one notice and with corrections", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "N1", version: "01", folder: "A" }));
    index.add(parse({ id: "N2", version: "01", folder: "A" }));
    index.add(parse({ id: "N3", version: "01", folder: "B" }));
    index.add(parse({ id: "N3", version: "02", folder: "B" }));

    const c = index.coverage();
    assert.equal(c.proceduresWithMultipleNotices, 1, "only A has two distinct notices");
    assert.equal(c.proceduresWithCorrections, 1, "only B has a corrected notice");
    assert.equal(c.supersededVersions, 1);
  });
});

// ---------------------------------------------------------------------------

describe("stages and timeline", () => {
  it("infers the stage from the notice kinds present", () => {
    assert.equal(stageOf(["PriorInformationNotice"]), "planning");
    assert.equal(stageOf(["ContractNotice"]), "open");
    assert.equal(stageOf(["ContractNotice", "ContractAwardNotice"]), "awarded");
    assert.equal(stageOf(["BriefNotice"]), "unknown");
  });

  it("classifies a full procedure as awarded", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "P", version: "01", kind: "PriorInformationNotice", issueDate: "2026-01-01" }));
    index.add(parse({ id: "C", version: "01", kind: "ContractNotice", issueDate: "2026-03-01" }));
    index.add(parse({ id: "A", version: "01", kind: "ContractAwardNotice", issueDate: "2026-09-01" }));

    const p = index.get("FOLDER-1");
    assert.equal(p?.stage, "awarded");
    assert.equal(p?.firstIssueDate, "2026-01-01");
    assert.equal(p?.lastIssueDate, "2026-09-01");
    assert.deepEqual(p?.timeline.map((t) => t.noticeId), ["P", "C", "A"]);
  });

  it("sorts undated notices last rather than corrupting the order", () => {
    const entries = buildTimeline([
      { noticeId: "B", version: 1, kind: "ContractNotice", issueDate: undefined, profile: undefined, thresholdScope: "unknown", source: undefined },
      { noticeId: "A", version: 1, kind: "ContractNotice", issueDate: "2026-01-01", profile: undefined, thresholdScope: "unknown", source: undefined },
    ]);
    assert.deepEqual(entries.map((e) => e.noticeId), ["A", "B"]);
  });

  it("finds procedures by stage", () => {
    const index = new ProcedureIndex();
    index.add(parse({ id: "A", version: "01", folder: "A", kind: "ContractAwardNotice" }));
    index.add(parse({ id: "B", version: "01", folder: "B", kind: "ContractNotice" }));
    assert.deepEqual(index.byStage("awarded").map((p) => p.contractFolderId), ["A"]);
    assert.deepEqual(index.byStage("open").map((p) => p.contractFolderId), ["B"]);
  });
});

// ---------------------------------------------------------------------------

describe("diffing notice versions", () => {
  const v1 = parseXml(notice({
    id: "N1", version: "01",
    body: `<cac:ProcurementProjectLot><cbc:ID>LOT-1</cbc:ID><cbc:EndDate>2026-04-01</cbc:EndDate></cac:ProcurementProjectLot>`,
  }));
  const v2 = parseXml(notice({
    id: "N1", version: "02",
    body: `<cac:ProcurementProjectLot><cbc:ID>LOT-1</cbc:ID><cbc:EndDate>2026-05-15</cbc:EndDate></cac:ProcurementProjectLot>`,
  }));

  it("finds the changed value and says what it became", () => {
    const changes = diffTrees(v1, v2, { ignore: ROUTINE_VERSION_FIELDS });
    const deadline = changes.find((c) => c.path.endsWith("cbc:EndDate"));
    assert.ok(deadline, "the moved deadline should be reported");
    assert.equal(deadline?.kind, "changed");
    assert.equal(deadline?.before, "2026-04-01");
    assert.equal(deadline?.after, "2026-05-15");
  });

  it("ignores the version fields that change on every republication", () => {
    const changes = diffTrees(v1, v2, { ignore: ROUTINE_VERSION_FIELDS });
    assert.equal(changes.some((c) => c.path === "/cbc:VersionID"), false);
    // Without the ignore list, the version bump is visible.
    assert.equal(
      diffTrees(v1, v2).some((c) => c.path === "/cbc:VersionID"),
      true,
    );
  });

  it("reports nothing when only the XML prefixes differ", () => {
    // The same document under two of the seven prefixes the feed really uses.
    const body = `<cac:ProcurementProjectLot><cbc:ID>LOT-1</cbc:ID></cac:ProcurementProjectLot>`;
    const withNs7 = parseXml(notice({ id: "N", version: "01", prefix: "ns7", body }));
    const withCn = parseXml(notice({ id: "N", version: "01", prefix: "cn", body }));
    const bare = parseXml(notice({ id: "N", version: "01", prefix: null, body }));

    assert.deepEqual(diffTrees(withNs7, withCn), []);
    assert.deepEqual(diffTrees(withNs7, bare), []);
  });

  it("detects an added and a removed element", () => {
    const a = parseXml(notice({ id: "N", version: "01", body: `<cac:X><cbc:ID>1</cbc:ID></cac:X>` }));
    const b = parseXml(notice({ id: "N", version: "02", body: `<cac:Y><cbc:ID>2</cbc:ID></cac:Y>` }));
    const changes = diffTrees(a, b, { ignore: ROUTINE_VERSION_FIELDS });
    assert.ok(changes.some((c) => c.kind === "removed" && c.path.includes("cac:X")));
    assert.ok(changes.some((c) => c.kind === "added" && c.path.includes("cac:Y")));
  });

  it("indexes repeated siblings positionally", () => {
    const a = parseXml(notice({
      id: "N", version: "01",
      body: `<cac:Lot><cbc:ID>A</cbc:ID></cac:Lot><cac:Lot><cbc:ID>B</cbc:ID></cac:Lot>`,
    }));
    const paths = [...flatten(a).keys()];
    assert.ok(paths.some((p) => p.includes("cac:Lot[1]/cbc:ID")));
    assert.ok(paths.some((p) => p.includes("cac:Lot[2]/cbc:ID")));
  });

  it("compares attributes", () => {
    const a = parseXml(notice({ id: "N", version: "01", body: `<cac:L><cbc:ID schemeName="Lot">X</cbc:ID></cac:L>` }));
    const b = parseXml(notice({ id: "N", version: "02", body: `<cac:L><cbc:ID schemeName="Part">X</cbc:ID></cac:L>` }));
    const changes = diffTrees(a, b, { ignore: ROUTINE_VERSION_FIELDS });
    const attr = changes.find((c) => c.path.endsWith("/@schemeName"));
    assert.equal(attr?.before, "Lot");
    assert.equal(attr?.after, "Part");
  });

  it("respects a limit", () => {
    const a = parseXml(notice({ id: "N", version: "01", body: `<cac:A><cbc:X>1</cbc:X><cbc:Y>1</cbc:Y><cbc:Z>1</cbc:Z></cac:A>` }));
    const b = parseXml(notice({ id: "N", version: "02", body: `<cac:A><cbc:X>2</cbc:X><cbc:Y>2</cbc:Y><cbc:Z>2</cbc:Z></cac:A>` }));
    assert.equal(diffTrees(a, b, { limit: 2 }).length, 2);
  });

  it("summarises a change set", () => {
    assert.equal(summarise([]), "no differences");
    assert.equal(
      summarise([
        { kind: "changed", path: "/a", before: "1", after: "2" },
        { kind: "added", path: "/b", before: undefined, after: "x" },
      ]),
      "1 changed, 1 added",
    );
  });

  it("names the sections a change set touches", () => {
    const changes = diffTrees(v1, v2, { ignore: ROUTINE_VERSION_FIELDS });
    assert.deepEqual(touchedSections(changes), ["cac:ProcurementProjectLot"]);
  });

  it("finds no differences between a document and itself", () => {
    assert.deepEqual(diffTrees(v1, v1), []);
  });
});
