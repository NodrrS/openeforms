/**
 * EFX to XPath 2.0 translation.
 *
 * EFX is surface syntax over XPath: the SDK's own toolchain compiles it to
 * XPath so that rules can be evaluated against a notice. This translator
 * produces the same target language, resolving business-term identifiers
 * through a {@link SymbolRegistry}.
 *
 * Where EFX and XPath differ the mapping is stated explicitly rather than
 * assumed:
 *
 * | EFX                    | XPath                                  |
 * | ---------------------- | -------------------------------------- |
 * | `==`                   | `=`                                    |
 * | `!=`                   | `!=`                                   |
 * | `x is empty`           | `not(normalize-space(x) != '')`        |
 * | `x is present`         | `exists(x)`                            |
 * | `x like "p"`           | `matches(x, 'p')`                      |
 * | `x is unique in /Y`    | `count(Y[. = x]) <= 1`                 |
 * | `every $v in s satisfies c` | `every $v in s satisfies c`       |
 * | `%`                    | `mod`                                  |
 * | `value-union(a, b)`    | `distinct-values((a, b))`              |
 */

import {
  type Expression, type FieldReference, type Iterator, type NodeReference,
  type SingleExpression,
} from "./ast.ts";
import { parse, parseSingleExpression } from "./parser.ts";
import { UnknownSymbolError, type SymbolRegistry } from "./symbols.ts";

export interface TranslateOptions {
  registry: SymbolRegistry;
  /**
   * Identifier the expression is evaluated relative to. Field paths are
   * emitted relative to this node where possible, matching what the SDK does
   * when it attaches a rule to a context.
   */
  contextNodeId?: string;
  /**
   * When a referenced identifier is not in the registry, emit the identifier
   * itself as a path step instead of throwing. Off by default: a silently
   * wrong XPath is worse than a loud failure.
   */
  allowUnknownSymbols?: boolean;
}

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

const COMPARISON: Record<string, string> = {
  "==": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=",
};

const ARITHMETIC: Record<string, string> = {
  "+": "+", "-": "-", "*": "*", "/": "div", "%": "mod",
};

class Translator {
  private readonly registry: SymbolRegistry;
  private readonly contextNodeId: string | undefined;
  private readonly allowUnknown: boolean;
  /** Variables currently in scope, so `$x` is not mistaken for a field. */
  private readonly scope = new Set<string>();

  constructor(options: TranslateOptions) {
    this.registry = options.registry;
    this.contextNodeId = options.contextNodeId;
    this.allowUnknown = options.allowUnknownSymbols ?? false;
  }

  // -- references ---------------------------------------------------------

  private fieldPath(ref: FieldReference): string {
    const def = this.registry.field(ref.fieldId);
    if (!def) {
      if (!this.allowUnknown) throw new UnknownSymbolError(ref.fieldId, "field");
      return ref.fieldId;
    }

    // A context override supplies the path prefix itself, so the field must
    // contribute only its node-relative tail. Using the absolute path here
    // concatenates the context onto a path that already contains it.
    const overridden =
      ref.variableContext !== undefined ||
      ref.fieldContext !== undefined ||
      ref.nodeContext !== undefined;

    let base: string;
    if (overridden) {
      base = def.xpathRelative;
    } else if (ref.absolute && def.xpathAbsolute) {
      base = def.xpathAbsolute;
    } else if (this.contextNodeId && def.parentNodeId === this.contextNodeId) {
      base = def.xpathRelative;
    } else if (def.xpathAbsolute) {
      base = def.xpathAbsolute;
    } else {
      base = def.xpathRelative;
    }

    if (ref.axis) base = `${ref.axis}::${stripLeadingSlash(base)}`;

    if (ref.variableContext) base = `$${ref.variableContext.name}/${stripLeadingSlash(base)}`;
    else if (ref.fieldContext) base = `${this.fieldPath(ref.fieldContext)}/${stripLeadingSlash(base)}`;
    else if (ref.nodeContext) base = `${this.nodePath(ref.nodeContext)}/${stripLeadingSlash(base)}`;

    if (ref.predicate) base = `${base}[${this.visit(ref.predicate)}]`;
    return base;
  }

  private nodePath(ref: NodeReference): string {
    const def = this.registry.node(ref.nodeId);
    if (!def) {
      if (!this.allowUnknown) throw new UnknownSymbolError(ref.nodeId, "node");
      return ref.nodeId;
    }
    let base = ref.absolute && def.xpathAbsolute
      ? def.xpathAbsolute
      : def.xpathAbsolute ?? def.xpathRelative;
    if (ref.predicate) base = `${base}[${this.visit(ref.predicate)}]`;
    return base;
  }

  // -- expressions --------------------------------------------------------

  visit(e: Expression): string {
    switch (e.node) {
      case "Literal":
        if (e.type === "string") return `'${String(e.value).replace(/'/g, "''")}'`;
        if (e.type === "boolean") return e.value ? "true()" : "false()";
        if (e.type === "number") return String(e.value);
        if (e.type === "date") return `xs:date('${e.raw}')`;
        if (e.type === "time") return `xs:time('${e.raw}')`;
        return `xs:duration('${e.raw}')`;

      case "FieldReference": return this.fieldPath(e);
      case "NodeReference": return this.nodePath(e);
      case "AttributeReference": return `${this.fieldPath(e.field)}/@${e.attribute}`;
      case "VariableReference": return `$${e.name}`;

      case "CodelistReference":
        // The SDK resolves a codelist to its enumerated values; without the
        // codelist files the honest emission is a named lookup the caller can
        // substitute, not a guessed list.
        return `$codelist:${e.codelistId}`;

      case "TypeCast": return this.cast(e.type, this.visit(e.operand));

      case "UnaryOperation": return `not(${this.visit(e.operand)})`;

      case "BinaryOperation": {
        const left = this.visit(e.left);
        const right = this.visit(e.right);
        if (e.operator === "and" || e.operator === "or") {
          return `(${left} ${e.operator} ${right})`;
        }
        const cmp = COMPARISON[e.operator];
        if (cmp) return `(${left} ${cmp} ${right})`;
        const arith = ARITHMETIC[e.operator];
        if (arith) return `(${left} ${arith} ${right})`;
        throw new TranslationError(`Unsupported operator ${e.operator}`);
      }

      case "Conditional":
        return `(if (${this.visit(e.condition)}) then ${this.visit(e.whenTrue)} else ${this.visit(e.whenFalse)})`;

      case "InListCondition": {
        const inner = `${this.visit(e.needle)} = ${this.visit(e.haystack)}`;
        return e.negated ? `not(${inner})` : `(${inner})`;
      }

      case "LikeCondition": {
        const inner = `matches(${this.visit(e.subject)}, '${e.pattern.replace(/'/g, "''")}')`;
        return e.negated ? `not(${inner})` : inner;
      }

      case "EmptinessCondition": {
        // "empty" in EFX means no non-whitespace content, which is weaker than
        // XPath's empty(): a present but blank element counts as empty.
        const inner = `not(normalize-space(${this.visit(e.subject)}) != '')`;
        return e.negated ? `not(${inner})` : inner;
      }

      case "PresenceCondition": {
        const inner = `exists(${this.visit(e.subject)})`;
        return e.negated ? `not(${inner})` : inner;
      }

      case "UniqueCondition": {
        const subject = this.visit(e.subject);
        const within = this.fieldPath(e.within);
        const inner = `count(${within}[. = ${subject}]) <= 1`;
        return e.negated ? `not(${inner})` : `(${inner})`;
      }

      case "QuantifiedExpression": {
        const bound = this.bind(e.iterators);
        try {
          return `(${e.quantifier} ${bound} satisfies ${this.visit(e.condition)})`;
        } finally {
          this.unbind(e.iterators);
        }
      }

      case "ForExpression": {
        const bound = this.bind(e.iterators);
        try {
          return `(for ${bound} return ${this.visit(e.body)})`;
        } finally {
          this.unbind(e.iterators);
        }
      }

      case "SequenceLiteral":
        return `(${e.items.map((i) => this.visit(i)).join(", ")})`;

      case "FunctionCall": return this.call(e.name, e.args.map((a) => this.visit(a)));

      default: {
        const never: never = e;
        throw new TranslationError(`Unhandled node ${JSON.stringify(never)}`);
      }
    }
  }

  private bind(iterators: Iterator[]): string {
    const parts = iterators.map((it) => {
      const source = this.visit(it.source);
      this.scope.add(it.variable);
      return `$${it.variable} in ${source}`;
    });
    return parts.join(", ");
  }

  private unbind(iterators: Iterator[]): void {
    for (const it of iterators) this.scope.delete(it.variable);
  }

  private cast(type: string, inner: string): string {
    switch (type) {
      case "number": return `number(${inner})`;
      case "string": return `string(${inner})`;
      case "boolean": return `boolean(${inner})`;
      case "date": return `xs:date(${inner})`;
      case "time": return `xs:time(${inner})`;
      case "duration": return `xs:duration(${inner})`;
      default: return inner;
    }
  }

  private call(name: string, args: string[]): string {
    const a = (i: number): string => args[i] as string;
    switch (name) {
      case "not": return `not(${a(0)})`;
      case "contains": return `contains(${a(0)}, ${a(1)})`;
      case "starts-with": return `starts-with(${a(0)}, ${a(1)})`;
      case "ends-with": return `ends-with(${a(0)}, ${a(1)})`;
      case "sequence-equal": return `deep-equal(sort(${a(0)}), sort(${a(1)}))`;
      case "count": return `count(${a(0)})`;
      case "number": return `number(${a(0)})`;
      case "sum": return `sum(${a(0)})`;
      case "string-length": return `string-length(${a(0)})`;
      case "substring":
        return args.length === 3
          ? `substring(${a(0)}, ${a(1)}, ${a(2)})`
          : `substring(${a(0)}, ${a(1)})`;
      case "string": return `string(${a(0)})`;
      case "concat": return `concat(${args.join(", ")})`;
      case "format-number":
        return args.length === 2
          ? `format-number(${a(0)}, ${a(1)})`
          : `format-number(${a(0)}, '#,##0.00')`;
      case "date": return `xs:date(${a(0)})`;
      case "time": return `xs:time(${a(0)})`;
      case "day-time-duration": return `xs:dayTimeDuration(${a(0)})`;
      case "year-month-duration": return `xs:yearMonthDuration(${a(0)})`;
      case "add-measure": return `(${a(0)} + ${a(1)})`;
      case "subtract-measure": return `(${a(0)} - ${a(1)})`;
      case "distinct-values": return `distinct-values(${a(0)})`;
      case "value-union": return `distinct-values((${a(0)}, ${a(1)}))`;
      case "value-intersect": return `distinct-values(${a(0)}[. = ${a(1)}])`;
      case "value-except": return `distinct-values(${a(0)}[not(. = ${a(1)})])`;
      default:
        throw new TranslationError(`Function ${name}() has no XPath mapping`);
    }
  }
}

function stripLeadingSlash(p: string): string {
  return p.startsWith("/") ? p.replace(/^\/+/, "") : p;
}

/** Translate a parsed EFX expression to XPath 2.0. */
export function translate(expression: Expression, options: TranslateOptions): string {
  return new Translator(options).visit(expression);
}

/** Parse and translate an EFX expression in one step. */
export function toXPath(source: string, options: TranslateOptions): string {
  return translate(parse(source), options);
}

/**
 * Parse and translate a `singleExpression`, using its own context declaration
 * as the context node unless one is supplied explicitly.
 */
export function singleExpressionToXPath(
  source: string,
  options: TranslateOptions,
): { context: SingleExpression["context"]; xpath: string } {
  const parsed = parseSingleExpression(source);
  const contextNodeId = options.contextNodeId
    ?? (parsed.context.kind === "node" ? parsed.context.id : undefined);
  const xpath = translate(
    parsed.body,
    contextNodeId === undefined
      ? options
      : { ...options, contextNodeId },
  );
  return { context: parsed.context, xpath };
}
