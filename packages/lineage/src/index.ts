/**
 * @openeforms/lineage
 *
 * Groups eForms notices into procurement procedures and says what changed when
 * a notice is corrected.
 *
 * The identifier that links notices, `cbc:ContractFolderID`, is missing from
 * 38.3% of German notices and from 92.8% of those on the minimal profile used
 * below the EU thresholds. This package therefore reports its own coverage as
 * a first-class result. An index that dropped the unlinkable notices silently
 * would look complete and be wrong.
 *
 * ```ts
 * import { ProcedureIndex, diffTrees } from "@openeforms/lineage";
 * import { parseNotice } from "@openeforms/core";
 *
 * const index = new ProcedureIndex();
 * for (const xml of notices) index.add(parseNotice(xml), { source: "2026-08" });
 *
 * index.coverage();          // what could and could not be linked
 * index.byStage("awarded");  // procedures that concluded
 *
 * const changes = diffTrees(v1.root, v2.root);  // what the corrigendum changed
 * ```
 */

export {
  ProcedureIndex,
  type Coverage, type UnlinkedNotice, type IndexSnapshot,
  type AddOptions, type AddResult,
} from "./index-store.ts";

export {
  stageOf, buildTimeline,
  type Procedure, type NoticeRef, type TimelineEntry, type Stage,
} from "./procedure.ts";

export {
  diffTrees, flatten, summarise, changedValues, touchedSections,
  ROUTINE_VERSION_FIELDS,
  type Change, type ChangeKind, type DiffOptions,
} from "./diff.ts";
