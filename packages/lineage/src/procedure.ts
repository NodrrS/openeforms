/**
 * The procedure model.
 *
 * A procurement runs through several notices: a prior information notice
 * announcing it, a contract notice opening it, and a contract award notice
 * closing it, plus corrected versions of any of them. `cbc:ContractFolderID`
 * is what ties them together.
 *
 * Two facts about the real data shape everything here.
 *
 * **The identifier is often absent.** Measured over August 2026, 8,762 of
 * 22,892 German notices carry no `ContractFolderID` at all, and on the minimal
 * profile used for below-threshold procurement the figure is 8,627 of 9,293.
 * Those notices cannot be linked to anything, by anyone, from this data. An
 * index that quietly drops them would overstate its own completeness, so they
 * are counted and reported instead.
 *
 * **A procedure's notices are spread across months.** Within any one monthly
 * export almost every folder appears once: 12,999 distinct folders in August
 * 2026, of which only 863 held more than one notice. Lineage only emerges once
 * several exports are indexed together, which is why the index accumulates
 * rather than answering from a single file.
 */

import type { NoticeKind } from "@openeforms/core";

/** Where a procedure has got to, inferred from the notice kinds seen. */
export type Stage = "planning" | "open" | "awarded" | "unknown";

/** One version of one notice, reduced to what the index needs. */
export interface NoticeRef {
  /** `cbc:ID` of the notice. */
  noticeId: string;
  /** Normalised version number; `01` and `1` both become 1. */
  version: number;
  kind: NoticeKind;
  /** `cbc:IssueDate`, where published. */
  issueDate: string | undefined;
  /** `cbc:CustomizationID` as published. */
  profile: string | undefined;
  /** Whether the procedure is at or above the EU thresholds, where derivable. */
  thresholdScope: "above" | "below" | "unknown";
  /** Where this notice came from, e.g. an export filename. Caller-supplied. */
  source: string | undefined;
}

export interface TimelineEntry {
  noticeId: string;
  kind: NoticeKind;
  /** Highest version seen for this notice. */
  latestVersion: number;
  /** Every version seen, ascending. */
  versions: number[];
  issueDate: string | undefined;
  /** True when more than one version was seen, i.e. it was corrected. */
  corrected: boolean;
}

export interface Procedure {
  contractFolderId: string;
  /** Every notice version indexed, in insertion order. */
  notices: NoticeRef[];
  /** One entry per distinct notice id, ordered by issue date then id. */
  timeline: TimelineEntry[];
  stage: Stage;
  /** Earliest issue date seen, where any notice published one. */
  firstIssueDate: string | undefined;
  lastIssueDate: string | undefined;
  /** True when any notice in the procedure has more than one version. */
  hasCorrections: boolean;
}

/**
 * Infer the stage from the notice kinds present.
 *
 * An award notice means the procedure concluded; a contract notice means it
 * opened; a prior information notice alone means it was only announced.
 * `BriefNotice` carries no stage of its own.
 */
export function stageOf(kinds: readonly NoticeKind[]): Stage {
  if (kinds.includes("ContractAwardNotice")) return "awarded";
  if (kinds.includes("ContractNotice")) return "open";
  if (kinds.includes("PriorInformationNotice")) return "planning";
  return "unknown";
}

/** Build the per-notice timeline for a set of indexed notice versions. */
export function buildTimeline(notices: readonly NoticeRef[]): TimelineEntry[] {
  const byId = new Map<string, NoticeRef[]>();
  for (const n of notices) {
    const list = byId.get(n.noticeId);
    if (list) list.push(n);
    else byId.set(n.noticeId, [n]);
  }

  const entries: TimelineEntry[] = [];
  for (const [noticeId, versions] of byId) {
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    const newest = sorted[sorted.length - 1] as NoticeRef;
    const numbers = [...new Set(sorted.map((v) => v.version))].sort((a, b) => a - b);
    entries.push({
      noticeId,
      kind: newest.kind,
      latestVersion: newest.version,
      versions: numbers,
      issueDate: newest.issueDate,
      corrected: numbers.length > 1,
    });
  }

  // Undated notices sort last, so a known chronology is never disturbed by one.
  return entries.sort((a, b) => {
    if (a.issueDate && b.issueDate && a.issueDate !== b.issueDate) {
      return a.issueDate < b.issueDate ? -1 : 1;
    }
    if (a.issueDate && !b.issueDate) return -1;
    if (!a.issueDate && b.issueDate) return 1;
    return a.noticeId < b.noticeId ? -1 : a.noticeId > b.noticeId ? 1 : 0;
  });
}
