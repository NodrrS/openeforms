/**
 * Notice-version diffing.
 *
 * When a notice is republished as version 2, something changed: a deadline
 * moved, a lot was withdrawn, a value was corrected. The export announces the
 * new version but never says what differs, and the German feed carries no
 * change log, so the only way to find out is to compare the documents.
 *
 * The comparison runs over the parsed XML tree rather than the normalised
 * model, because a correction can touch any field, including ones no model
 * covers.
 *
 * Paths are namespace-qualified using the eForms prefixes, never the prefixes
 * the document happened to use. Two notices that differ only in their XML
 * prefixes produce no changes at all, which is the correct answer: the same
 * element under `ns7:` and under `cn:` is the same element.
 */

import { NS, walk, type XmlElement } from "@openeforms/core";

export type ChangeKind = "added" | "removed" | "changed";

export interface Change {
  kind: ChangeKind;
  /** Namespace-qualified path with positional indexes, e.g. `cac:Lot[2]/cbc:ID`. */
  path: string;
  /** Value in the earlier version. Absent for an addition. */
  before: string | undefined;
  /** Value in the later version. Absent for a removal. */
  after: string | undefined;
}

export interface DiffOptions {
  /**
   * Ignore these paths, matched as prefixes. Useful for fields that change on
   * every republication without carrying meaning.
   */
  ignore?: readonly string[];
  /** Cap the number of changes returned. */
  limit?: number;
}

/** Well-known eForms namespaces, so paths read the same whatever the source. */
const PREFIX: Record<string, string> = {
  [NS.CBC]: "cbc",
  [NS.CAC]: "cac",
  [NS.EXT]: "ext",
  [NS.EFEXT]: "efext",
  [NS.EFAC]: "efac",
  [NS.EFBC]: "efbc",
};

function qualify(el: XmlElement): string {
  const prefix = PREFIX[el.uri];
  return prefix ? `${prefix}:${el.local}` : el.local;
}

/**
 * Flatten a tree to path → value.
 *
 * Sibling elements with the same qualified name get positional indexes, so
 * `cac:ProcurementProjectLot[2]/cbc:ID` is distinguishable from the first lot.
 * Attributes appear as `.../@name`. Only elements with text and attributes
 * carry values; structural elements contribute their path with no value so
 * that a whole subtree appearing or vanishing is visible.
 */
export function flatten(root: XmlElement): Map<string, string> {
  const out = new Map<string, string>();

  const visit = (el: XmlElement, basePath: string): void => {
    const counts = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const child of el.children) {
      const name = qualify(child);
      totals.set(name, (totals.get(name) ?? 0) + 1);
    }

    for (const child of el.children) {
      const name = qualify(child);
      const seen = (counts.get(name) ?? 0) + 1;
      counts.set(name, seen);
      const suffix = (totals.get(name) ?? 1) > 1 ? `[${seen}]` : "";
      const path = `${basePath}/${name}${suffix}`;

      const text = child.text.trim();
      if (text !== "") out.set(path, text);
      else if (child.children.length === 0) out.set(path, "");

      for (const [key, value] of child.attrs) {
        const [uri, local] = splitAttrKey(key);
        const attrPrefix = uri ? (PREFIX[uri] ? `${PREFIX[uri]}:` : "") : "";
        out.set(`${path}/@${attrPrefix}${local}`, value);
      }

      visit(child, path);
    }
  };

  visit(root, "");
  return out;
}

function splitAttrKey(key: string): [string, string] {
  const at = key.indexOf("|");
  return at < 0 ? ["", key] : [key.slice(0, at), key.slice(at + 1)];
}

/**
 * Compare two notice documents.
 *
 * `before` and `after` are the parsed roots, in that order. The result lists
 * what would have to change to turn the earlier document into the later one.
 */
export function diffTrees(
  before: XmlElement,
  after: XmlElement,
  options: DiffOptions = {},
): Change[] {
  const a = flatten(before);
  const b = flatten(after);
  const ignore = options.ignore ?? [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const ignored = (path: string): boolean =>
    ignore.some((prefix) => path === prefix || path.startsWith(prefix));

  const changes: Change[] = [];
  const paths = new Set([...a.keys(), ...b.keys()]);

  for (const path of [...paths].sort()) {
    if (changes.length >= limit) break;
    if (ignored(path)) continue;

    const hasA = a.has(path);
    const hasB = b.has(path);
    const valueA = a.get(path);
    const valueB = b.get(path);

    if (hasA && !hasB) {
      changes.push({ kind: "removed", path, before: valueA, after: undefined });
    } else if (!hasA && hasB) {
      changes.push({ kind: "added", path, before: undefined, after: valueB });
    } else if (valueA !== valueB) {
      changes.push({ kind: "changed", path, before: valueA, after: valueB });
    }
  }
  return changes;
}

/** A short, readable summary of a change set. */
export function summarise(changes: readonly Change[]): string {
  if (changes.length === 0) return "no differences";
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) counts[c.kind]++;
  const parts: string[] = [];
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return parts.join(", ");
}

/**
 * Paths whose values are expected to differ between any two versions of a
 * notice, and which therefore say nothing about what was corrected.
 *
 * Offered as a convenience, not applied automatically: whether a version
 * number counts as a meaningful difference depends on the question being
 * asked.
 */
export const ROUTINE_VERSION_FIELDS: readonly string[] = [
  "/cbc:ID",
  "/cbc:UUID",
  "/cbc:VersionID",
  "/cbc:IssueDate",
  "/cbc:IssueTime",
  "/ext:UBLExtensions",
];

/** Elements whose text differs, ignoring order among same-named siblings. */
export function changedValues(changes: readonly Change[]): Change[] {
  return changes.filter((c) => c.kind === "changed");
}

/** Count how many distinct top-level sections a change set touches. */
export function touchedSections(changes: readonly Change[]): string[] {
  const sections = new Set<string>();
  for (const c of changes) {
    const first = c.path.split("/").filter(Boolean)[0];
    if (first) sections.add(first.replace(/\[\d+\]$/, ""));
  }
  return [...sections].sort();
}

/** Iterate every element of a tree. Re-exported for callers building indexes. */
export { walk };
