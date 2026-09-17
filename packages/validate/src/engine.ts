/**
 * Schematron evaluation engine.
 *
 * XPath is evaluated with fontoxpath, an MIT-licensed XPath 3.1 engine, over a
 * slimdom document. There is deliberately no XSLT step.
 *
 * ## Why not compile to XSLT
 *
 * The usual way to run Schematron is to compile it to XSLT with SchXslt and
 * execute that with an XSLT 2.0+ processor. In JavaScript the only complete
 * such processor is Saxon-JS, which is not open source: its npm package
 * carries a proprietary licence. Depending on it would put a non-free
 * component at the centre of a library whose purpose is to make these rules
 * freely runnable.
 *
 * Schematron does not need XSLT. It is a small language over XPath, and XPath
 * is available under MIT. This engine interprets the rule model directly.
 *
 * ## The semantics that catch people out
 *
 * Within a pattern, each node is processed by the **first** rule whose context
 * matches it. Later rules in the same pattern do not see that node, even if
 * their contexts also match. Patterns are independent of one another, so the
 * same node can be processed once per pattern. Getting this wrong produces a
 * validator that reports extra failures, which is worse than one that crashes.
 */

import fontoxpath from "fontoxpath";
import { DOMParser, type Document, type Node } from "slimdom";

import {
  type Assertion, type Pattern, type Rule, type Schema, type Variable,
} from "./schematron.ts";

const {
  evaluateXPath,
  evaluateXPathToBoolean,
  evaluateXPathToNodes,
  evaluateXPathToString,
} = fontoxpath;

export interface Failure {
  /** `assert` failed (test false) or `report` matched (test true). */
  kind: "assert" | "report";
  /** The assertion's id, e.g. `ND-Buyer-1`. */
  id: string | undefined;
  role: string | undefined;
  flag: string | undefined;
  /** Pattern and rule that produced this. */
  patternId: string | undefined;
  ruleId: string | undefined;
  ruleContext: string;
  /** The XPath that was evaluated. */
  test: string;
  /** The assertion's text, a label key in the eForms rules. */
  message: string;
  /** Resolved diagnostic texts, where `diagnostics` referenced any. */
  diagnostics: string[];
  /** Location of the offending node, as an XPath. */
  location: string;
}

export interface ValidationReport {
  valid: boolean;
  failures: Failure[];
  /** Phase applied, or `#ALL`. */
  phase: string;
  /** Patterns actually evaluated. */
  patternsEvaluated: number;
  /** Nodes that matched some rule context. */
  nodesMatched: number;
  /** Assertions whose XPath could not be evaluated. */
  errors: EvaluationError[];
}

export interface EvaluationError {
  patternId: string | undefined;
  ruleId: string | undefined;
  assertionId: string | undefined;
  test: string;
  message: string;
}

export interface ValidateOptions {
  /**
   * Phase to run. `#ALL` evaluates every pattern, which is the Schematron
   * default. The eForms schema defines one phase per notice subtype, so
   * running `#ALL` against a single notice produces failures from every other
   * subtype's rules and is almost never what you want.
   */
  phase?: string;
  /**
   * Stop after this many failures. Useful against the full eForms rule set,
   * which can produce thousands for a badly formed notice.
   */
  maxFailures?: number;
  /**
   * Throw when an assertion's XPath cannot be evaluated. Off by default:
   * collect them in `errors` so one malformed rule does not hide the rest.
   */
  throwOnEvaluationError?: boolean;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Parse an XML document for validation. */
export function parseDocument(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

/** Build a namespace resolver from the schema's `ns` declarations. */
function resolverFor(schema: Schema) {
  return (prefix: string): string | null => schema.namespaces[prefix] ?? null;
}

/**
 * An XPath locating a node, in the style SVRL uses: element steps with
 * positional predicates, attributes as `@name`.
 */
function locationOf(node: Node): string {
  const steps: string[] = [];
  let current: Node | null = node;

  if (current.nodeType === 2) {
    const a = current as unknown as { name: string; ownerElement: Node | null };
    const owner = a.ownerElement;
    return owner ? `${locationOf(owner)}/@${a.name}` : `@${a.name}`;
  }

  while (current && current.nodeType === 1) {
    const el = current as unknown as {
      localName: string;
      parentNode: Node | null;
      namespaceURI: string | null;
    };
    const parent = el.parentNode as unknown as { childNodes?: ArrayLike<Node> } | null;
    let index = 1;
    if (parent?.childNodes) {
      let seen = 0;
      for (const sibling of Array.from(parent.childNodes)) {
        const s = sibling as unknown as { nodeType: number; localName: string; namespaceURI: string | null };
        if (s.nodeType !== 1) continue;
        if (s.localName === el.localName && s.namespaceURI === el.namespaceURI) {
          seen++;
          if (sibling === current) index = seen;
        }
      }
    }
    steps.unshift(`*:${el.localName}[${index}]`);
    current = el.parentNode;
  }
  return `/${steps.join("/")}`;
}

/**
 * Turn a rule context into a selection expression.
 *
 * A Schematron `context` is an XSLT **match pattern**, not a location path. It
 * identifies nodes anywhere in the document that fit the pattern, so
 * `cac:ProcurementProjectLot/cbc:ID` means every such `cbc:ID` in the tree,
 * not a child of the document node. Evaluating the context as written selects
 * nothing for every relative pattern, which is a silent and total failure: the
 * validator reports a clean document because no rule ever fired.
 *
 * An absolute pattern is already a usable path. A relative one is wrapped in
 * `//(...)`, which distributes correctly over alternation (`a|b`) and works
 * for attribute patterns.
 */
export function contextToSelection(context: string): string {
  const trimmed = context.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return `//(${trimmed})`;
}

/**
 * Evaluate `let` declarations into a variable bag.
 *
 * Bindings are sequential: a later `let` can refer to an earlier one. A `let`
 * whose expression fails is recorded and skipped rather than aborting the run,
 * because one unevaluable variable should not suppress every rule that does
 * work. References to it will then fail individually and be reported.
 */
function bindVariables(
  lets: readonly Variable[],
  contextNode: Node,
  inherited: Record<string, unknown>,
  resolver: (p: string) => string | null,
  onError: (v: Variable, err: unknown) => void,
): Record<string, unknown> {
  const bag = { ...inherited };
  for (const v of lets) {
    try {
      bag[v.name] = evaluateXPath(v.value, contextNode, null, bag, evaluateXPath.ANY_TYPE, {
        namespaceResolver: resolver,
        language: evaluateXPath.XPATH_3_1_LANGUAGE,
      });
    } catch (err) {
      onError(v, err);
    }
  }
  return bag;
}

/**
 * Validate a document against a parsed Schematron schema.
 */
export function validate(
  document: Document | string,
  schema: Schema,
  options: ValidateOptions = {},
): ValidationReport {
  const doc = typeof document === "string" ? parseDocument(document) : document;
  const phase = options.phase ?? "#ALL";
  const maxFailures = options.maxFailures ?? Number.POSITIVE_INFINITY;
  const resolver = resolverFor(schema);
  const xpathOptions = {
    namespaceResolver: resolver,
    language: evaluateXPath.XPATH_3_1_LANGUAGE,
  };

  let patterns: Pattern[];
  if (phase === "#ALL") {
    patterns = schema.patterns;
  } else {
    const found = schema.phases.find((p) => p.id === phase);
    if (!found) {
      throw new ValidationError(
        `Unknown phase ${JSON.stringify(phase)}. The schema defines: ` +
          (schema.phases.length
            ? schema.phases.map((p) => p.id).join(", ")
            : "no phases, so only #ALL is available"),
      );
    }
    const active = new Set(found.active);
    patterns = schema.patterns.filter((p) => p.id !== undefined && active.has(p.id));
  }

  const failures: Failure[] = [];
  const errors: EvaluationError[] = [];
  let nodesMatched = 0;

  const varError =
    (patternId: string | undefined, ruleId: string | undefined) =>
    (v: Variable, err: unknown): void => {
      errors.push({
        patternId,
        ruleId,
        assertionId: undefined,
        test: v.value,
        message: `Variable $${v.name} could not be bound: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (options.throwOnEvaluationError) {
        throw new ValidationError(`Variable $${v.name} could not be bound: ${String(err)}`);
      }
    };

  const globals = bindVariables(schema.lets, doc, {}, resolver, varError(undefined, undefined));

  for (const pattern of patterns) {
    const patternVars = bindVariables(pattern.lets, doc, globals, resolver, varError(pattern.id, undefined));

    // Schematron: within a pattern, the first matching rule claims the node.
    const claimed = new Set<Node>();

    for (const rule of pattern.rules) {
      let contextNodes: Node[];
      try {
        contextNodes = evaluateXPathToNodes(
          contextToSelection(rule.context), doc, null, patternVars, xpathOptions,
        ) as Node[];
      } catch (err) {
        errors.push({
          patternId: pattern.id,
          ruleId: rule.id,
          assertionId: undefined,
          test: rule.context,
          message: `Rule context failed to evaluate: ${err instanceof Error ? err.message : String(err)}`,
        });
        if (options.throwOnEvaluationError) {
          throw new ValidationError(`Rule context ${JSON.stringify(rule.context)} failed: ${String(err)}`);
        }
        continue;
      }

      for (const node of contextNodes) {
        if (claimed.has(node)) continue;
        claimed.add(node);
        nodesMatched++;

        const ruleVars = bindVariables(rule.lets, node, patternVars, resolver, varError(pattern.id, rule.id));

        for (const assertion of rule.assertions) {
          if (failures.length >= maxFailures) {
            return finish();
          }
          evaluateAssertion(assertion, rule, pattern, node, ruleVars);
        }
      }
    }
  }

  return finish();

  function evaluateAssertion(
    assertion: Assertion,
    rule: Rule,
    pattern: Pattern,
    node: Node,
    vars: Record<string, unknown>,
  ): void {
    let result: boolean;
    try {
      result = evaluateXPathToBoolean(assertion.test, node, null, vars, xpathOptions);
    } catch (err) {
      errors.push({
        patternId: pattern.id,
        ruleId: rule.id,
        assertionId: assertion.id,
        test: assertion.test,
        message: err instanceof Error ? err.message : String(err),
      });
      if (options.throwOnEvaluationError) {
        throw new ValidationError(
          `Assertion ${assertion.id ?? assertion.test} failed to evaluate: ${String(err)}`,
        );
      }
      return;
    }

    // An assert fires when its test is false; a report fires when it is true.
    const fired = assertion.kind === "assert" ? !result : result;
    if (!fired) return;

    failures.push({
      kind: assertion.kind,
      id: assertion.id,
      role: assertion.role,
      flag: assertion.flag,
      patternId: pattern.id,
      ruleId: rule.id,
      ruleContext: rule.context,
      test: assertion.test,
      message: assertion.message,
      diagnostics: assertion.diagnostics.flatMap((id) => {
        const text = schema.diagnostics[id];
        return text === undefined ? [] : [text];
      }),
      location: locationOf(node),
    });
  }

  function finish(): ValidationReport {
    return {
      valid: failures.length === 0,
      failures,
      phase,
      patternsEvaluated: patterns.length,
      nodesMatched,
      errors,
    };
  }
}

/** Evaluate a single XPath against a document, using a schema's prefixes. */
export function evaluate(
  xpath: string,
  document: Document,
  schema: Schema,
  variables: Record<string, unknown> = {},
): string {
  return evaluateXPathToString(xpath, document, null, variables, {
    namespaceResolver: resolverFor(schema),
    language: evaluateXPath.XPATH_3_1_LANGUAGE,
  });
}
