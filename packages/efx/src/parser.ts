/**
 * EFX parser.
 *
 * A recursive-descent transcription of `grammar/Efx.g4` (eForms SDK 1.15.1).
 * Method names match the grammar's rule names wherever a rule is implemented,
 * so the two can be checked against each other by eye and by
 * `test/grammar-coverage.test.ts`.
 *
 * ## Why not generate this from the grammar
 *
 * The canonical toolchain generates a parser from these `.g4` files with
 * ANTLR, which is a Java program. This package deliberately does not, because
 * the entire reason OpenEForms exists is that consuming eForms currently means
 * running a JVM. A build step that needs Java would reintroduce the problem one
 * level down, for every contributor and every CI job.
 *
 * The cost of that choice is honest: this parser can drift from the grammar,
 * whereas a generated one cannot. Three things hold it in place. The `.g4`
 * files are vendored in `grammar/` as the normative specification. The method
 * names below mirror the rule names. And the coverage test fails when the
 * grammar names a parser rule that is neither implemented here nor listed as
 * deliberately out of scope, so an upstream change cannot pass unnoticed.
 *
 * ## Operator precedence
 *
 * `Efx.g4` expresses precedence through ordered alternatives in left-recursive
 * rules. ANTLR resolves that automatically; a hand-written parser has to state
 * it. Binding, loosest first:
 *
 *   or → and → comparison and the `in`/`like`/`is` conditions → additive →
 *   multiplicative → unary → primary
 */

import {
  type ArithmeticOperator, type Axis, type ComparisonOperator,
  type EfxType, type Expression, type FieldReference, type Iterator,
  type NodeReference, type SingleExpression, type VariableReference,
} from "./ast.ts";
import { EfxSyntaxError, stringLiteralValue, tokenise, type Token, type TokenKind } from "./lexer.ts";

/** Functions whose result type is fixed by the grammar. */
const FUNCTION_TYPES: Record<string, EfxType> = {
  // booleanFunction
  "not": "boolean", "contains": "boolean", "starts-with": "boolean",
  "ends-with": "boolean", "sequence-equal": "boolean",
  // numericFunction
  "count": "number", "number": "number", "sum": "number",
  "string-length": "number",
  // stringFunction
  "substring": "string", "string": "string", "concat": "string",
  "format-number": "string",
  // dateFunction
  "date": "date", "add-measure": "date", "subtract-measure": "date",
  // timeFunction
  "time": "time",
  // durationFunction
  "day-time-duration": "duration", "year-month-duration": "duration",
  // sequenceFunction
  "distinct-values": "sequence", "value-union": "sequence",
  "value-intersect": "sequence", "value-except": "sequence",
};

/** Arity bounds, so a malformed call fails at parse time rather than later. */
const FUNCTION_ARITY: Record<string, [min: number, max: number]> = {
  "not": [1, 1], "contains": [2, 2], "starts-with": [2, 2], "ends-with": [2, 2],
  "sequence-equal": [2, 2], "count": [1, 1], "number": [1, 1], "sum": [1, 1],
  "string-length": [1, 1], "substring": [2, 3], "string": [1, 1],
  "concat": [1, Number.MAX_SAFE_INTEGER], "format-number": [1, 2],
  "date": [1, 1], "add-measure": [2, 2], "subtract-measure": [2, 2],
  "time": [1, 1], "day-time-duration": [1, 1], "year-month-duration": [1, 1],
  "distinct-values": [1, 1], "value-union": [2, 2], "value-intersect": [2, 2],
  "value-except": [2, 2],
};

const CAST_TYPES: Record<string, EfxType> = {
  indicator: "boolean", number: "number", text: "string", code: "string",
  date: "date", time: "time", measure: "duration", context: "late-bound",
};

export class EfxParser {
  private readonly tokens: Token[];
  private readonly source: string;
  private pos = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenise(source);
  }

  // -- token helpers ------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] as Token;
  }

  private at(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value || t.text === value);
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "EOF") this.pos++;
    return t;
  }

  private accept(kind: TokenKind, value?: string): Token | undefined {
    return this.at(kind, value) ? this.next() : undefined;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const t = this.peek();
    if (!this.at(kind, value)) {
      const want = value ? `${kind} ${JSON.stringify(value)}` : kind;
      const got = t.kind === "EOF" ? "end of input" : `${t.kind} ${JSON.stringify(t.text)}`;
      throw new EfxSyntaxError(`Expected ${want} but found ${got}`, this.source, t.start);
    }
    return this.next();
  }

  private fail(message: string): never {
    throw new EfxSyntaxError(message, this.source, this.peek().start);
  }

  // -- entry points -------------------------------------------------------

  /** `singleExpression: StartExpression (FieldId|NodeId) ... expressionBlock EOF` */
  parseSingleExpression(): SingleExpression {
    // The `${...}` and `{...}` wrappers belong to DEFAULT-mode lexing. Accept
    // the bare context form `{ND-Root} expr` used by the SDK's rule files.
    this.expect("OpenBracket");
    const idToken = this.peek();
    let context: SingleExpression["context"];
    if (idToken.kind === "FieldId" || idToken.kind === "BtId") {
      context = { kind: "field", id: this.next().text };
    } else if (idToken.kind === "NodeId") {
      context = { kind: "node", id: this.next().text };
    } else {
      this.fail("Context declaration must name a field or a node");
    }
    const parameters: SingleExpression["parameters"] = [];
    while (this.accept("Comma")) {
      const cast = this.expect("TypeCast");
      const v = this.expect("Variable");
      parameters.push({
        name: v.text.slice(1),
        type: CAST_TYPES[cast.value as string] ?? "late-bound",
      });
    }
    this.expect("CloseBracket");
    const body = this.expression();
    this.expect("EOF");
    return { node: "SingleExpression", context, parameters, body };
  }

  /** Parse a bare expression with no context declaration. */
  parseExpression(): Expression {
    const e = this.expression();
    this.expect("EOF");
    return e;
  }

  // -- expression: precedence climbing ------------------------------------

  /** `expression` — the grammar's union of all typed expression rules. */
  private expression(): Expression {
    return this.logicalOr();
  }

  /** `booleanExpression # logicalOrCondition` */
  private logicalOr(): Expression {
    let left = this.logicalAnd();
    while (this.accept("Or")) {
      left = { node: "BinaryOperation", type: "boolean", operator: "or", left, right: this.logicalAnd() };
    }
    return left;
  }

  /** `booleanExpression # logicalAndCondition` */
  private logicalAnd(): Expression {
    let left = this.comparison();
    while (this.accept("And")) {
      left = { node: "BinaryOperation", type: "boolean", operator: "and", left, right: this.comparison() };
    }
    return left;
  }

  /**
   * The comparison tier, covering the grammar's `*Comparison`,
   * `*InListCondition`, `likePatternCondition`, `emptinessCondition`,
   * `presenceCondition` and `uniqueValueCondition` alternatives.
   */
  private comparison(): Expression {
    const left = this.additive();

    if (this.at("Comparison")) {
      const op = this.next().text as ComparisonOperator;
      return { node: "BinaryOperation", type: "boolean", operator: op, left, right: this.additive() };
    }

    // `not in`, `not like`
    if (this.at("Not") && (this.peek(1).kind === "In" || this.peek(1).kind === "Like")) {
      this.next();
      return this.inOrLike(left, true);
    }
    if (this.at("In") || this.at("Like")) return this.inOrLike(left, false);

    // `is [not] empty | present | unique in /X`
    if (this.accept("Is")) {
      const negated = this.accept("Not") !== undefined;
      if (this.accept("Empty")) {
        return { node: "EmptinessCondition", type: "boolean", negated, subject: left };
      }
      if (this.accept("Present")) {
        return { node: "PresenceCondition", type: "boolean", negated, subject: left };
      }
      if (this.accept("Unique")) {
        this.expect("In");
        const within = this.fieldReference();
        return { node: "UniqueCondition", type: "boolean", negated, subject: left, within };
      }
      this.fail("Expected `empty`, `present` or `unique` after `is`");
    }
    return left;
  }

  private inOrLike(left: Expression, negated: boolean): Expression {
    if (this.accept("Like")) {
      const pattern = this.expect("STRING");
      return {
        node: "LikeCondition", type: "boolean", negated,
        subject: left, pattern: stringLiteralValue(pattern.text),
      };
    }
    this.expect("In");
    return {
      node: "InListCondition", type: "boolean", negated,
      needle: left, haystack: this.unary(),
    };
  }

  /** `numericExpression # additionExpression`, `durationExpression` sums. */
  private additive(): Expression {
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "Plus" && t.kind !== "Minus") break;
      this.next();
      const right = this.multiplicative();
      left = {
        node: "BinaryOperation",
        type: resultType(left, right),
        operator: t.text as ArithmeticOperator,
        left, right,
      };
    }
    return left;
  }

  /** `numericExpression # multiplicationExpression` */
  private multiplicative(): Expression {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "Star" && t.kind !== "Slash" && t.kind !== "Percent") break;
      // A `/` directly before a field or node identifier is a path step, not
      // division: `BT-01/BT-02` never occurs, but `/BT-01` does.
      if (t.kind === "Slash") {
        const after = this.peek(1).kind;
        if (after === "FieldId" || after === "NodeId" || after === "BtId") break;
      }
      this.next();
      const right = this.unary();
      left = {
        node: "BinaryOperation",
        type: resultType(left, right),
        operator: t.text as ArithmeticOperator,
        left, right,
      };
    }
    return left;
  }

  /** Type casts and the `not(...)` function form. */
  private unary(): Expression {
    const cast = this.accept("TypeCast");
    if (cast) {
      const type = CAST_TYPES[cast.value as string] ?? "late-bound";
      return { node: "TypeCast", type, operand: this.unary() };
    }
    return this.primary();
  }

  // -- primary ------------------------------------------------------------

  private primary(): Expression {
    const t = this.peek();

    switch (t.kind) {
      case "If": return this.conditional();
      case "Every": case "Some": return this.quantifiedExpression();
      case "For": return this.forExpression();
      case "Not": return this.notFunction();
      case "Function": return this.functionCall();
      case "Notice": return this.fieldReference();
      case "OpenParenthesis": return this.parenthesised();
      case "Variable": return this.variableOrContextOverride();
      case "STRING": case "UUIDV4":
        this.next();
        return { node: "Literal", type: "string", value: stringLiteralValue(t.text), raw: t.text };
      case "INTEGER": case "DECIMAL":
        this.next();
        return { node: "Literal", type: "number", value: Number(t.text), raw: t.text };
      case "DATE":
        this.next();
        return { node: "Literal", type: "date", value: t.text, raw: t.text };
      case "TIME":
        this.next();
        return { node: "Literal", type: "time", value: t.text, raw: t.text };
      case "DayTimeDurationLiteral": case "YearMonthDurationLiteral":
        this.next();
        return { node: "Literal", type: "duration", value: t.text, raw: t.text };
      case "True": case "Always":
        this.next();
        return { node: "Literal", type: "boolean", value: true, raw: t.text };
      case "False": case "Never":
        this.next();
        return { node: "Literal", type: "boolean", value: false, raw: t.text };
      case "Slash": case "FieldId": case "NodeId": case "BtId": case "Axis":
        return this.fieldOrNodeReference();
      default:
        this.fail(`Unexpected ${t.kind === "EOF" ? "end of input" : JSON.stringify(t.text)}`);
    }
  }

  /** `(a)`, `(a, b, c)` and `(codelistId)`. */
  private parenthesised(): Expression {
    this.expect("OpenParenthesis");

    // `codelistReference: OpenParenthesis codelistId CloseParenthesis`
    if (this.at("Identifier") && this.peek(1).kind === "CloseParenthesis") {
      const id = this.next().text;
      this.expect("CloseParenthesis");
      return { node: "CodelistReference", codelistId: id };
    }

    const first = this.expression();
    if (this.at("Comma")) {
      const items = [first];
      while (this.accept("Comma")) items.push(this.expression());
      this.expect("CloseParenthesis");
      return { node: "SequenceLiteral", type: "sequence", items };
    }
    this.expect("CloseParenthesis");
    return first;
  }

  /** `If booleanExpression Then x Else y` */
  private conditional(): Expression {
    this.expect("If");
    const condition = this.expression();
    this.expect("Then");
    const whenTrue = this.expression();
    this.expect("Else");
    const whenFalse = this.expression();
    return {
      node: "Conditional",
      type: whenTrue.node === "Literal" ? whenTrue.type : resultType(whenTrue, whenFalse),
      condition, whenTrue, whenFalse,
    };
  }

  /** `(Every | Some) iteratorList Satisfies booleanExpression` */
  private quantifiedExpression(): Expression {
    const quantifier = this.next().kind === "Every" ? "every" : "some";
    const iterators = this.iteratorList();
    this.expect("Satisfies");
    return {
      node: "QuantifiedExpression", type: "boolean",
      quantifier, iterators, condition: this.expression(),
    };
  }

  /** `For iteratorList Return expression` */
  private forExpression(): Expression {
    this.expect("For");
    const iterators = this.iteratorList();
    this.expect("Return");
    return { node: "ForExpression", type: "sequence", iterators, body: this.expression() };
  }

  /** `iteratorList: iteratorExpression (Comma iteratorExpression)*` */
  private iteratorList(): Iterator[] {
    const out = [this.iteratorExpression()];
    while (this.accept("Comma")) out.push(this.iteratorExpression());
    return out;
  }

  /** `<type>VariableDeclaration In <type>Sequence` */
  private iteratorExpression(): Iterator {
    const cast = this.expect("TypeCast");
    const variable = this.expect("Variable");
    this.expect("In");
    return {
      node: "Iterator",
      variable: variable.text.slice(1),
      variableType: CAST_TYPES[cast.value as string] ?? "late-bound",
      source: this.unary(),
    };
  }

  /** `Not OpenParenthesis booleanExpression CloseParenthesis` */
  private notFunction(): Expression {
    this.expect("Not");
    this.expect("OpenParenthesis");
    const operand = this.expression();
    this.expect("CloseParenthesis");
    return { node: "UnaryOperation", type: "boolean", operator: "not", operand };
  }

  private functionCall(): Expression {
    const name = this.expect("Function").value as string;
    this.expect("OpenParenthesis");
    const args: Expression[] = [];
    if (!this.at("CloseParenthesis")) {
      args.push(this.expression());
      while (this.accept("Comma")) args.push(this.expression());
    }
    this.expect("CloseParenthesis");

    const arity = FUNCTION_ARITY[name];
    if (arity && (args.length < arity[0] || args.length > arity[1])) {
      const want = arity[1] === Number.MAX_SAFE_INTEGER
        ? `at least ${arity[0]}`
        : arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]} to ${arity[1]}`;
      this.fail(`Function ${name}() takes ${want} argument(s) but received ${args.length}`);
    }
    return { node: "FunctionCall", type: FUNCTION_TYPES[name] ?? "late-bound", name, args };
  }

  /** `$v` or `$v::BT-01-notice` (`contextVariableSpecifier`). */
  private variableOrContextOverride(): Expression {
    const v = this.expect("Variable");
    const variable: VariableReference = { node: "VariableReference", name: v.text.slice(1) };
    if (this.accept("ColonColon")) {
      const ref = this.fieldOrNodeReference();
      if (ref.node === "FieldReference") return { ...ref, variableContext: variable };
      if (ref.node === "AttributeReference") {
        return { ...ref, field: { ...ref.field, variableContext: variable } };
      }
      this.fail("A variable context override must be followed by a field reference");
    }
    return variable;
  }

  /**
   * `fieldReference` and `nodeReference`, including context overrides
   * (`ND-X::BT-1`, `BT-1::BT-2`), axes, predicates and `/@attribute`.
   */
  private fieldOrNodeReference(): Expression {
    const absolute = this.accept("Slash") !== undefined;

    let axis: Axis | undefined;
    if (this.at("Axis")) {
      axis = this.next().value as Axis;
      this.expect("ColonColon");
    }

    const head = this.peek();
    if (head.kind === "NodeId") {
      this.next();
      const nodeRef: NodeReference = {
        node: "NodeReference", nodeId: head.text, absolute,
        ...(this.predicateIfPresent() ? {} : {}),
      };
      const predicate = this.lastPredicate;
      this.lastPredicate = undefined;
      const withPredicate: NodeReference = predicate ? { ...nodeRef, predicate } : nodeRef;

      // `ND-X::rest` — the node is the context for what follows.
      if (this.accept("ColonColon")) {
        const inner = this.fieldOrNodeReference();
        if (inner.node === "FieldReference") return { ...inner, nodeContext: withPredicate };
        if (inner.node === "AttributeReference") {
          return { ...inner, field: { ...inner.field, nodeContext: withPredicate } };
        }
        this.fail("A node context override must be followed by a field reference");
      }
      return withPredicate;
    }

    if (head.kind !== "FieldId" && head.kind !== "BtId") {
      this.fail(`Expected a field or node identifier but found ${JSON.stringify(head.text)}`);
    }
    this.next();

    let field: FieldReference = { node: "FieldReference", fieldId: head.text, absolute };
    if (axis) field = { ...field, axis };
    this.predicateIfPresent();
    if (this.lastPredicate) {
      field = { ...field, predicate: this.lastPredicate };
      this.lastPredicate = undefined;
    }

    // `BT-1::rest` — the field is the context for what follows.
    if (this.accept("ColonColon")) {
      const inner = this.fieldOrNodeReference();
      if (inner.node === "FieldReference") return { ...inner, fieldContext: field };
      if (inner.node === "AttributeReference") {
        return { ...inner, field: { ...inner.field, fieldContext: field } };
      }
      this.fail("A field context override must be followed by a field reference");
    }

    if (this.accept("SlashAt")) {
      const attribute = this.expect("Identifier").text;
      return { node: "AttributeReference", field, attribute };
    }
    return field;
  }

  private lastPredicate: Expression | undefined;

  /** `(OpenBracket predicate CloseBracket)?` */
  private predicateIfPresent(): boolean {
    if (!this.accept("OpenBracket")) return false;
    this.lastPredicate = this.expression();
    this.expect("CloseBracket");
    return true;
  }

  /** A field reference in a position where only that is legal. */
  private fieldReference(): FieldReference {
    const ref = this.fieldOrNodeReference();
    if (ref.node !== "FieldReference") {
      this.fail("Expected a field reference");
    }
    return ref;
  }
}

/** Best-effort result type for an arithmetic operation. */
function resultType(left: Expression, right: Expression): EfxType {
  const lt = "type" in left ? left.type : "late-bound";
  const rt = "type" in right ? right.type : "late-bound";
  if (lt === "date" && rt === "date") return "duration";
  if (lt === "duration" || rt === "duration") return "duration";
  if (lt === "number" && rt === "number") return "number";
  if (lt === "late-bound" || rt === "late-bound") return "late-bound";
  return lt;
}

/** Parse a bare EFX expression. */
export function parse(source: string): Expression {
  return new EfxParser(source).parseExpression();
}

/** Parse a context declaration followed by an expression, e.g. `[ND-Root] ...`. */
export function parseSingleExpression(source: string): SingleExpression {
  return new EfxParser(source).parseSingleExpression();
}
