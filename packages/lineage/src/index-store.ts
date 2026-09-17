/**
 * The procedure index.
 *
 * Accumulates notices across many exports and groups them by
 * `cbc:ContractFolderID`. Storage-agnostic: the index holds small summaries,
 * not documents, and serialises to plain JSON so a caller can persist it
 * however they like.
 *
 * The index never silently discards a notice. One that carries no procedure
 * identifier is counted in {@link Coverage} and can be listed, because a
 * procurement dataset that quietly omits two fifths of its input is worse than
 * one that admits the gap.
 */

import { keyOf, type Notice } from "@openeforms/core";

import {
  buildTimeline, stageOf, type NoticeRef, type Procedure, type Stage,
} from "./procedure.ts";

export interface Coverage {
  /** Notices offered to the index, including unlinkable ones. */
  noticesSeen: number;
  /** Notices that carried a procedure identifier and were linked. */
  linked: number;
  /** Notices with no `ContractFolderID`; these cannot be linked at all. */
  unlinked: number;
  /** Unlinked notices broken down by `CustomizationID`. */
  unlinkedByProfile: Record<string, number>;
  /** Notices skipped because they carried no usable id or version. */
  unusable: number;
  /** Distinct procedures. */
  procedures: number;
  /** Procedures holding more than one distinct notice. */
  proceduresWithMultipleNotices: number;
  /** Procedures where some notice was published more than once. */
  proceduresWithCorrections: number;
  /** Notice versions superseded by a later version of the same notice. */
  supersededVersions: number;
  /** Duplicate `(noticeId, version)` pairs offered more than once. */
  duplicatesIgnored: number;
}

/** A notice the index could not link, kept so the gap can be inspected. */
export interface UnlinkedNotice {
  noticeId: string | undefined;
  version: number | undefined;
  kind: string;
  profile: string | undefined;
  reason: "no-contract-folder-id" | "no-notice-id" | "no-version";
  source: string | undefined;
}

export interface IndexSnapshot {
  version: 1;
  entries: Array<[string, NoticeRef[]]>;
  unlinked: UnlinkedNotice[];
  counters: {
    noticesSeen: number;
    unusable: number;
    duplicatesIgnored: number;
  };
}

export interface AddOptions {
  /** Where the notice came from, e.g. an export filename. */
  source?: string;
  /**
   * Keep unlinked notices for inspection. On by default. Turn it off when
   * indexing very large corpora and only the counts matter.
   */
  retainUnlinked?: boolean;
}

export type AddResult =
  | { linked: true; contractFolderId: string; superseded: boolean; duplicate: boolean }
  | { linked: false; reason: UnlinkedNotice["reason"] };

export class ProcedureIndex {
  /** folder id → every notice version indexed under it. */
  private readonly folders = new Map<string, NoticeRef[]>();
  /** folder id → set of `noticeId@version`, to reject duplicates. */
  private readonly seenKeys = new Map<string, Set<string>>();
  private readonly unlinkedNotices: UnlinkedNotice[] = [];
  private noticesSeen = 0;
  private unusable = 0;
  private duplicatesIgnored = 0;

  /**
   * Add one parsed notice.
   *
   * Returns what happened rather than throwing, because "this notice cannot be
   * linked" is an ordinary and frequent outcome in this data, not an error.
   */
  add(notice: Notice, options: AddOptions = {}): AddResult {
    this.noticesSeen++;
    const retain = options.retainUnlinked ?? true;

    const record = (reason: UnlinkedNotice["reason"]): AddResult => {
      if (reason !== "no-contract-folder-id") this.unusable++;
      if (retain) {
        this.unlinkedNotices.push({
          noticeId: notice.noticeId,
          version: notice.version?.number,
          kind: notice.kind,
          profile: notice.profile.raw,
          reason,
          source: options.source,
        });
      }
      return { linked: false, reason };
    };

    if (!notice.noticeId) return record("no-notice-id");
    if (!notice.version) return record("no-version");
    if (!notice.contractFolderId) return record("no-contract-folder-id");

    const folderId = notice.contractFolderId;
    const key = keyOf(notice) as string;

    let keys = this.seenKeys.get(folderId);
    if (!keys) {
      keys = new Set();
      this.seenKeys.set(folderId, keys);
      this.folders.set(folderId, []);
    }
    if (keys.has(key)) {
      this.duplicatesIgnored++;
      return { linked: true, contractFolderId: folderId, superseded: false, duplicate: true };
    }
    keys.add(key);

    const list = this.folders.get(folderId) as NoticeRef[];
    const superseded = list.some(
      (n) => n.noticeId === notice.noticeId && n.version > notice.version!.number,
    );

    list.push({
      noticeId: notice.noticeId,
      version: notice.version.number,
      kind: notice.kind,
      issueDate: notice.issueDate,
      profile: notice.profile.raw,
      thresholdScope: notice.legalBasis?.scope ?? "unknown",
      source: options.source,
    });

    return { linked: true, contractFolderId: folderId, superseded, duplicate: false };
  }

  /** Add many notices. */
  addAll(notices: Iterable<Notice>, options: AddOptions = {}): void {
    for (const n of notices) this.add(n, options);
  }

  /** Every procedure, ordered by first issue date then folder id. */
  procedures(): Procedure[] {
    const out: Procedure[] = [];
    for (const folderId of this.folders.keys()) {
      const p = this.get(folderId);
      if (p) out.push(p);
    }
    return out.sort((a, b) => {
      const ad = a.firstIssueDate;
      const bd = b.firstIssueDate;
      if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      return a.contractFolderId < b.contractFolderId ? -1 : 1;
    });
  }

  /** One procedure by its folder id. */
  get(contractFolderId: string): Procedure | undefined {
    const notices = this.folders.get(contractFolderId);
    if (!notices) return undefined;

    const timeline = buildTimeline(notices);
    const dates = timeline.map((t) => t.issueDate).filter((d): d is string => d !== undefined).sort();

    return {
      contractFolderId,
      notices: [...notices],
      timeline,
      stage: stageOf(timeline.map((t) => t.kind)),
      firstIssueDate: dates[0],
      lastIssueDate: dates[dates.length - 1],
      hasCorrections: timeline.some((t) => t.corrected),
    };
  }

  /** Procedures at a given stage. */
  byStage(stage: Stage): Procedure[] {
    return this.procedures().filter((p) => p.stage === stage);
  }

  /** Notices the index could not link, with the reason for each. */
  unlinked(): readonly UnlinkedNotice[] {
    return this.unlinkedNotices;
  }

  /** How much of the input was linkable, and what was lost. */
  coverage(): Coverage {
    const unlinkedByProfile: Record<string, number> = {};
    let noFolderId = 0;
    for (const u of this.unlinkedNotices) {
      if (u.reason !== "no-contract-folder-id") continue;
      noFolderId++;
      const key = u.profile ?? "(absent)";
      unlinkedByProfile[key] = (unlinkedByProfile[key] ?? 0) + 1;
    }

    let linked = 0;
    let multi = 0;
    let corrected = 0;
    let superseded = 0;
    for (const notices of this.folders.values()) {
      linked += notices.length;
      const timeline = buildTimeline(notices);
      if (timeline.length > 1) multi++;
      if (timeline.some((t) => t.corrected)) corrected++;
      superseded += timeline.reduce((n, t) => n + (t.versions.length - 1), 0);
    }

    // When unlinked notices are not retained the per-profile split is
    // unavailable, so derive the total from the counters instead of the list.
    const unlinkedTotal = this.unlinkedNotices.length > 0
      ? noFolderId
      : this.noticesSeen - linked - this.unusable;

    return {
      noticesSeen: this.noticesSeen,
      linked,
      unlinked: unlinkedTotal,
      unlinkedByProfile,
      unusable: this.unusable,
      procedures: this.folders.size,
      proceduresWithMultipleNotices: multi,
      proceduresWithCorrections: corrected,
      supersededVersions: superseded,
      duplicatesIgnored: this.duplicatesIgnored,
    };
  }

  /** A serialisable snapshot, for persisting the index between runs. */
  toJSON(): IndexSnapshot {
    return {
      version: 1,
      entries: [...this.folders.entries()].map(([k, v]) => [k, [...v]]),
      unlinked: [...this.unlinkedNotices],
      counters: {
        noticesSeen: this.noticesSeen,
        unusable: this.unusable,
        duplicatesIgnored: this.duplicatesIgnored,
      },
    };
  }

  /** Restore an index from a snapshot. */
  static fromJSON(snapshot: IndexSnapshot): ProcedureIndex {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported index snapshot version ${String(snapshot.version)}`);
    }
    const index = new ProcedureIndex();
    for (const [folderId, notices] of snapshot.entries) {
      index.folders.set(folderId, [...notices]);
      index.seenKeys.set(
        folderId,
        new Set(notices.map((n) => `${n.noticeId}@${n.version}`)),
      );
    }
    index.unlinkedNotices.push(...snapshot.unlinked);
    index.noticesSeen = snapshot.counters.noticesSeen;
    index.unusable = snapshot.counters.unusable;
    index.duplicatesIgnored = snapshot.counters.duplicatesIgnored;
    return index;
  }

  /** Merge another index into this one. */
  merge(other: ProcedureIndex): void {
    for (const [folderId, notices] of other.folders) {
      let keys = this.seenKeys.get(folderId);
      if (!keys) {
        keys = new Set();
        this.seenKeys.set(folderId, keys);
        this.folders.set(folderId, []);
      }
      const list = this.folders.get(folderId) as NoticeRef[];
      for (const n of notices) {
        const key = `${n.noticeId}@${n.version}`;
        if (keys.has(key)) {
          this.duplicatesIgnored++;
          continue;
        }
        keys.add(key);
        list.push(n);
      }
    }
    this.unlinkedNotices.push(...other.unlinkedNotices);
    this.noticesSeen += other.noticesSeen;
    this.unusable += other.unusable;
    this.duplicatesIgnored += other.duplicatesIgnored;
  }
}
