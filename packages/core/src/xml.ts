/**
 * A minimal, namespace-resolved XML tree.
 *
 * Built on `saxes` with namespace processing enabled, so every element carries
 * its resolved namespace URI and local name. Prefixes are retained purely for
 * diagnostics; nothing in this library dispatches on them.
 *
 * The tree is deliberately small. eForms notices are a few hundred elements,
 * and a full DOM implementation would add weight without buying anything the
 * accessors below do not already provide.
 */

import { SaxesParser } from "saxes";

export interface XmlElement {
  /** Resolved namespace URI. Empty string when the element is in no namespace. */
  readonly uri: string;
  /** Local name, prefix stripped. */
  readonly local: string;
  /** Prefix as written in the source document. Diagnostics only. */
  readonly prefix: string;
  /** Attributes keyed by `uri + "|" + local`; unprefixed keys use `"|name"`. */
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text content, trimmed. */
  readonly text: string;
  readonly parent: XmlElement | undefined;
}

interface MutableElement extends Omit<XmlElement, "children" | "attrs" | "text" | "parent"> {
  attrs: Map<string, string>;
  children: MutableElement[];
  text: string;
  parent: MutableElement | undefined;
}

export class XmlParseError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "XmlParseError";
    this.cause = cause;
  }
}

const decoder = new TextDecoder("utf-8");

/**
 * Parse an XML document into a namespace-resolved tree.
 *
 * Accepts a string or raw bytes. Bytes are decoded as UTF-8, which is what the
 * German notice export publishes.
 *
 * @throws {XmlParseError} on malformed XML.
 */
export function parseXml(source: string | Uint8Array): XmlElement {
  const text = typeof source === "string" ? source : decoder.decode(source);

  const parser = new SaxesParser({ xmlns: true, position: true });
  let root: MutableElement | undefined;
  let current: MutableElement | undefined;
  let failure: Error | undefined;

  parser.on("error", (err) => {
    failure ??= err;
  });

  parser.on("opentag", (tag) => {
    const attrs = new Map<string, string>();
    for (const [name, attr] of Object.entries(tag.attributes)) {
      // saxes gives {name, value, prefix, local, uri} when xmlns is on.
      if (typeof attr === "string") {
        attrs.set(`|${name}`, attr);
      } else {
        attrs.set(`${attr.uri ?? ""}|${attr.local ?? attr.name}`, attr.value);
      }
    }
    const el: MutableElement = {
      uri: tag.uri ?? "",
      local: tag.local ?? tag.name,
      prefix: tag.prefix ?? "",
      attrs,
      children: [],
      text: "",
      parent: current,
    };
    if (current) current.children.push(el);
    else root = el;
    current = el;
  });

  parser.on("text", (chunk) => {
    if (current) current.text += chunk;
  });

  parser.on("cdata", (chunk) => {
    if (current) current.text += chunk;
  });

  parser.on("closetag", () => {
    if (current) {
      current.text = current.text.trim();
      current = current.parent;
    }
  });

  try {
    parser.write(text).close();
  } catch (err) {
    throw new XmlParseError(
      err instanceof Error ? err.message : "XML parse failed",
      err,
    );
  }
  if (failure) throw new XmlParseError(failure.message, failure);
  if (!root) throw new XmlParseError("Document contained no root element");
  return root as XmlElement;
}

// ---------------------------------------------------------------------------
// Accessors. All address elements by (namespaceUri, localName), never prefix.
// ---------------------------------------------------------------------------

/** Direct children matching a namespace and local name. */
export function children(
  el: XmlElement | undefined,
  uri: string,
  local: string,
): XmlElement[] {
  if (!el) return [];
  return el.children.filter((c) => c.uri === uri && c.local === local);
}

/** First direct child matching a namespace and local name. */
export function child(
  el: XmlElement | undefined,
  uri: string,
  local: string,
): XmlElement | undefined {
  if (!el) return undefined;
  return el.children.find((c) => c.uri === uri && c.local === local);
}

/** Follow a chain of `(uri, local)` steps down the tree. */
export function path(
  el: XmlElement | undefined,
  ...steps: ReadonlyArray<readonly [string, string]>
): XmlElement | undefined {
  let node = el;
  for (const step of steps) {
    node = child(node, step[0], step[1]);
    if (!node) return undefined;
  }
  return node;
}

/** Trimmed text of the first matching direct child, if any. */
export function childText(
  el: XmlElement | undefined,
  uri: string,
  local: string,
): string | undefined {
  const found = child(el, uri, local);
  if (!found) return undefined;
  const value = found.text.trim();
  return value === "" ? undefined : value;
}

/** Depth-first iteration over the element and all its descendants. */
export function* walk(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const c of el.children) yield* walk(c);
}

/** First descendant at any depth matching a namespace and local name. */
export function descendant(
  el: XmlElement | undefined,
  uri: string,
  local: string,
): XmlElement | undefined {
  if (!el) return undefined;
  for (const node of walk(el)) {
    if (node !== el && node.uri === uri && node.local === local) return node;
  }
  return undefined;
}

/** All descendants at any depth matching a namespace and local name. */
export function descendants(
  el: XmlElement | undefined,
  uri: string,
  local: string,
): XmlElement[] {
  if (!el) return [];
  const out: XmlElement[] = [];
  for (const node of walk(el)) {
    if (node !== el && node.uri === uri && node.local === local) out.push(node);
  }
  return out;
}

/** Attribute value by namespace and local name. Use `""` for unprefixed. */
export function attr(
  el: XmlElement | undefined,
  uri: string,
  local: string,
): string | undefined {
  return el?.attrs.get(`${uri}|${local}`);
}

/** Every distinct prefix used in the document, for diagnostics. */
export function prefixesUsed(root: XmlElement): Set<string> {
  const seen = new Set<string>();
  for (const node of walk(root)) seen.add(node.prefix);
  return seen;
}
