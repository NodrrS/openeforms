/**
 * ISO Schematron document model.
 *
 * Schematron (ISO/IEC 19757-3) is a rule language: a schema declares namespace
 * prefixes and variables, then groups `rule` elements into `pattern`s, each
 * rule carrying `assert` and `report` tests written in XPath.
 *
 * The eForms SDK ships its validation rules this way. Its top-level schema
 * pulls in over two hundred pattern files with `include`, declares twelve
 * namespace prefixes and two global variables, and defines one phase per
 * notice subtype.
 */

import { DOMParser, type Document, type Element } from "slimdom";

export const SCH_NS = "http://purl.oclc.org/dsdl/schematron";

/** Severity as published in `role`. Schematron does not fix these values. */
export type Role = "ERROR" | "WARN" | "INFO" | (string & {});

export interface Assertion {
  /** `assert` fires when the test is false; `report` fires when it is true. */
  kind: "assert" | "report";
  id: string | undefined;
  test: string;
  role: Role | undefined;
  flag: string | undefined;
  /** Ids referenced by `diagnostics`, resolved against the schema. */
  diagnostics: string[];
  /**
   * The element's text. In the eForms SDK this is a label key of the form
   * `rule|text|ND-Buyer-1`, resolved from the SDK's label assets rather than
   * being a human-readable sentence.
   */
  message: string;
}

export interface Rule {
  id: string | undefined;
  context: string;
  /** Rule-scoped variables, evaluated with the matched node as context. */
  lets: Variable[];
  assertions: Assertion[];
}

export interface Pattern {
  id: string | undefined;
  lets: Variable[];
  rules: Rule[];
}

export interface Variable {
  name: string;
  /** XPath expression, mutually exclusive with `literal` in practice. */
  value: string;
}

export interface Phase {
  id: string;
  /** Pattern ids activated by this phase. */
  active: string[];
}

export interface Schema {
  title: string | undefined;
  /** `xslt2`, `xslt3`, `xpath2`… Recorded; this engine evaluates XPath 3.1. */
  queryBinding: string | undefined;
  /** Prefix to namespace URI, from `ns` declarations. */
  namespaces: Record<string, string>;
  /** Schema-level variables, evaluated once against the document root. */
  lets: Variable[];
  phases: Phase[];
  patterns: Pattern[];
  /** Diagnostic id to message text. */
  diagnostics: Record<string, string>;
}

/**
 * Resolves an `include` or `extends` href to the referenced document's text.
 *
 * The package does not read the filesystem itself, so it stays usable in a
 * browser and in tests without fixtures. Node callers can pass a resolver
 * built on `readFileSync`.
 */
export type HrefResolver = (href: string, fromHref: string | undefined) => string;

export class SchematronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchematronError";
  }
}

function elements(parent: Element, local: string): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.childNodes)) {
    const el = child as Element;
    if (el.nodeType === 1 && el.namespaceURI === SCH_NS && el.localName === local) {
      out.push(el);
    }
  }
  return out;
}

function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null || v === "" ? undefined : v;
}

function textOf(el: Element): string {
  return (el.textContent ?? "").trim().replace(/\s+/g, " ");
}

function parseVariables(parent: Element): Variable[] {
  return elements(parent, "let").flatMap((el) => {
    const name = attr(el, "name");
    const value = attr(el, "value");
    if (!name) return [];
    // A `let` with no `value` carries its content as a literal sequence; the
    // eForms rules never do this, so it is recorded as a string literal.
    return [{ name, value: value ?? `'${textOf(el).replace(/'/g, "''")}'` }];
  });
}

function parseAssertions(rule: Element): Assertion[] {
  const out: Assertion[] = [];
  for (const kind of ["assert", "report"] as const) {
    for (const el of elements(rule, kind)) {
      const test = attr(el, "test");
      if (!test) {
        throw new SchematronError(
          `<${kind}${attr(el, "id") ? ` id="${attr(el, "id")}"` : ""}> has no test attribute`,
        );
      }
      out.push({
        kind,
        id: attr(el, "id"),
        test,
        role: attr(el, "role"),
        flag: attr(el, "flag"),
        diagnostics: (attr(el, "diagnostics") ?? "").split(/\s+/).filter(Boolean),
        message: textOf(el),
      });
    }
  }
  // Preserve document order across the two kinds.
  return out.sort((a, b) => sourceOrder(rule, a) - sourceOrder(rule, b));
}

/** Index of an assertion's element among the rule's children, for ordering. */
function sourceOrder(rule: Element, a: Assertion): number {
  const kids = Array.from(rule.childNodes) as Element[];
  return kids.findIndex(
    (k) =>
      k.nodeType === 1 &&
      k.namespaceURI === SCH_NS &&
      k.localName === a.kind &&
      (attr(k, "id") ?? "") === (a.id ?? "") &&
      attr(k, "test") === a.test,
  );
}

function parseRule(el: Element): Rule | undefined {
  // Abstract rules are templates for `extends`; they have no context and are
  // never matched directly.
  if (attr(el, "abstract") === "true") return undefined;
  const context = attr(el, "context");
  if (!context) {
    throw new SchematronError(`<rule${attr(el, "id") ? ` id="${attr(el, "id")}"` : ""}> has no context`);
  }
  return {
    id: attr(el, "id"),
    context,
    lets: parseVariables(el),
    assertions: parseAssertions(el),
  };
}

function parsePattern(el: Element): Pattern {
  return {
    id: attr(el, "id"),
    lets: parseVariables(el),
    rules: elements(el, "rule").flatMap((r) => {
      const rule = parseRule(r);
      return rule ? [rule] : [];
    }),
  };
}

/**
 * Parse a Schematron schema.
 *
 * `include` elements are resolved through `resolver`. A file whose root is a
 * bare `pattern`, which is how the eForms SDK ships its rule files, is
 * accepted as a pattern rather than requiring a wrapping schema.
 */
export function parseSchematron(
  source: string,
  options: { resolver?: HrefResolver; href?: string } = {},
): Schema {
  const doc: Document = new DOMParser().parseFromString(source, "text/xml");
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== SCH_NS) {
    throw new SchematronError(
      `Expected a Schematron document in ${SCH_NS} but found ` +
        `<${root?.localName ?? "nothing"}> in ${root?.namespaceURI ?? "no namespace"}.`,
    );
  }
  if (root.localName !== "schema") {
    throw new SchematronError(
      `Expected <schema> as the document element but found <${root.localName}>.`,
    );
  }

  const namespaces: Record<string, string> = {};
  for (const el of elements(root, "ns")) {
    const prefix = attr(el, "prefix");
    const uri = attr(el, "uri");
    if (prefix && uri) namespaces[prefix] = uri;
  }

  const diagnostics: Record<string, string> = {};
  for (const group of elements(root, "diagnostics")) {
    for (const el of elements(group, "diagnostic")) {
      const id = attr(el, "id");
      if (id) diagnostics[id] = textOf(el);
    }
  }

  const phases: Phase[] = elements(root, "phase").flatMap((el) => {
    const id = attr(el, "id");
    if (!id) return [];
    return [{
      id,
      active: elements(el, "active").flatMap((a) => {
        const pattern = attr(a, "pattern");
        return pattern ? [pattern] : [];
      }),
    }];
  });

  const patterns: Pattern[] = [];
  // Walk the schema's children in order so included patterns keep their
  // position relative to inline ones.
  for (const child of Array.from(root.childNodes)) {
    const el = child as Element;
    if (el.nodeType !== 1 || el.namespaceURI !== SCH_NS) continue;

    if (el.localName === "pattern") {
      // Abstract patterns are templates instantiated by `is-a`; the eForms
      // rules use none, and instantiating them is not implemented.
      if (attr(el, "abstract") === "true") continue;
      patterns.push(parsePattern(el));
      continue;
    }

    if (el.localName === "include") {
      const href = attr(el, "href");
      if (!href) throw new SchematronError("<include> has no href");
      if (!options.resolver) {
        throw new SchematronError(
          `<include href="${href}"> cannot be resolved because no resolver was supplied. ` +
            `Pass { resolver } to read included pattern files.`,
        );
      }
      const included = options.resolver(href, options.href);
      const sub = new DOMParser().parseFromString(included, "text/xml");
      const subRoot = sub.documentElement;
      if (!subRoot || subRoot.namespaceURI !== SCH_NS) {
        throw new SchematronError(`Included file ${href} is not a Schematron document`);
      }
      if (subRoot.localName === "pattern") {
        patterns.push(parsePattern(subRoot));
      } else if (subRoot.localName === "schema") {
        // An included schema contributes its patterns and declarations.
        const nested = parseSchematron(included, { ...options, href });
        patterns.push(...nested.patterns);
        Object.assign(namespaces, nested.namespaces);
        Object.assign(diagnostics, nested.diagnostics);
      } else if (subRoot.localName === "diagnostics") {
        for (const el2 of elements(subRoot, "diagnostic")) {
          const id = attr(el2, "id");
          if (id) diagnostics[id] = textOf(el2);
        }
      } else {
        throw new SchematronError(
          `Included file ${href} has unsupported root <${subRoot.localName}>`,
        );
      }
    }
  }

  return {
    title: elements(root, "title")[0] ? textOf(elements(root, "title")[0] as Element) : undefined,
    queryBinding: attr(root, "queryBinding"),
    namespaces,
    lets: parseVariables(root),
    phases,
    patterns,
    diagnostics,
  };
}
