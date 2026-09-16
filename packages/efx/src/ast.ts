/**
 * EFX abstract syntax tree.
 *
 * EFX is a statically typed expression language: `booleanExpression`,
 * `numericExpression`, `stringExpression`, `dateExpression`, `timeExpression`
 * and `durationExpression` are separate rules in the grammar, and a
 * `lateBoundExpression` is one whose type is only known once a field
 * identifier is resolved against the SDK's field registry.
 *
 * The AST keeps that distinction in a `type` discriminant rather than in
 * separate node hierarchies, because the translator needs to reason about the
 * type of any node uniformly.
 */

export type EfxType =
  | "boolean" | "number" | "string" | "date" | "time" | "duration"
  /** A reference whose type depends on the field it names. */
  | "late-bound"
  | "sequence";

export type ComparisonOperator = "==" | "!=" | ">" | ">=" | "<" | "<=";
export type ArithmeticOperator = "+" | "-" | "*" | "/" | "%";

export type Axis =
  | "child" | "descendant" | "descendant-or-self" | "ancestor"
  | "ancestor-or-self" | "preceding" | "preceding-sibling"
  | "following" | "following-sibling";

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** `BT-01-notice`, optionally with an axis, a predicate and context overrides. */
export interface FieldReference {
  node: "FieldReference";
  /** Field identifier, e.g. `BT-24-Lot`. */
  fieldId: string;
  /** True when written with a leading `/`, i.e. rooted at the document. */
  absolute: boolean;
  axis?: Axis;
  predicate?: Expression;
  /** `ND-Root::BT-01-notice` — evaluate relative to this node. */
  nodeContext?: NodeReference;
  /** `BT-137-Lot::BT-24-Lot` — evaluate relative to this field. */
  fieldContext?: FieldReference;
  /** `$lot::BT-24-Lot` — evaluate relative to this variable. */
  variableContext?: VariableReference;
  /** `notice("id")/BT-01-notice` — resolve against another notice. */
  noticeContext?: Expression;
}

/** `ND-Root`, optionally with a predicate. */
export interface NodeReference {
  node: "NodeReference";
  nodeId: string;
  absolute: boolean;
  predicate?: Expression;
  noticeContext?: Expression;
}

/** `BT-01-notice/@listName` */
export interface AttributeReference {
  node: "AttributeReference";
  field: FieldReference;
  attribute: string;
}

export interface VariableReference {
  node: "VariableReference";
  /** Variable name without the `$`. */
  name: string;
}

/** `(accessibility)` — a reference to an SDK codelist. */
export interface CodelistReference {
  node: "CodelistReference";
  codelistId: string;
}

export type Reference =
  | FieldReference | NodeReference | AttributeReference | VariableReference;

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export interface Literal {
  node: "Literal";
  type: Exclude<EfxType, "late-bound" | "sequence">;
  /** Decoded value: string contents without quotes, numbers as numbers. */
  value: string | number | boolean;
  /** Source text exactly as written. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export interface BinaryOperation {
  node: "BinaryOperation";
  type: EfxType;
  operator: ComparisonOperator | ArithmeticOperator | "and" | "or";
  left: Expression;
  right: Expression;
}

export interface UnaryOperation {
  node: "UnaryOperation";
  type: EfxType;
  operator: "not";
  operand: Expression;
}

/** `if c then a else b` */
export interface Conditional {
  node: "Conditional";
  type: EfxType;
  condition: Expression;
  whenTrue: Expression;
  whenFalse: Expression;
}

/** `X in (a, b)` and `X not in (a, b)` */
export interface InListCondition {
  node: "InListCondition";
  type: "boolean";
  negated: boolean;
  needle: Expression;
  haystack: Expression;
}

/** `X like "pattern"` */
export interface LikeCondition {
  node: "LikeCondition";
  type: "boolean";
  negated: boolean;
  subject: Expression;
  pattern: string;
}

/** `X is empty`, `X is not empty` */
export interface EmptinessCondition {
  node: "EmptinessCondition";
  type: "boolean";
  negated: boolean;
  subject: Expression;
}

/** `X is present`, `X is not present` */
export interface PresenceCondition {
  node: "PresenceCondition";
  type: "boolean";
  negated: boolean;
  subject: Expression;
}

/** `X is unique in /Y` */
export interface UniqueCondition {
  node: "UniqueCondition";
  type: "boolean";
  negated: boolean;
  subject: Expression;
  within: FieldReference;
}

/** `$x in sequence` inside `every`, `some` and `for`. */
export interface Iterator {
  node: "Iterator";
  variable: string;
  /** Declared type of the loop variable. */
  variableType: EfxType;
  source: Expression;
}

/** `every $x in s satisfies c` / `some $x in s satisfies c` */
export interface QuantifiedExpression {
  node: "QuantifiedExpression";
  type: "boolean";
  quantifier: "every" | "some";
  iterators: Iterator[];
  condition: Expression;
}

/** `for $x in s return e` */
export interface ForExpression {
  node: "ForExpression";
  type: "sequence";
  iterators: Iterator[];
  body: Expression;
}

/** `(a, b, c)` */
export interface SequenceLiteral {
  node: "SequenceLiteral";
  type: "sequence";
  items: Expression[];
}

export interface FunctionCall {
  node: "FunctionCall";
  type: EfxType;
  name: string;
  args: Expression[];
}

/** `number:$x` — an explicit type assertion on a late-bound expression. */
export interface TypeCast {
  node: "TypeCast";
  type: EfxType;
  operand: Expression;
}

export type Expression =
  | Literal | BinaryOperation | UnaryOperation | Conditional
  | InListCondition | LikeCondition | EmptinessCondition | PresenceCondition
  | UniqueCondition | QuantifiedExpression | ForExpression | SequenceLiteral
  | FunctionCall | TypeCast | CodelistReference
  | FieldReference | NodeReference | AttributeReference | VariableReference;

/** A parsed `singleExpression`: a context declaration plus an expression. */
export interface SingleExpression {
  node: "SingleExpression";
  /** The `{FieldId}` or `{NodeId}` the expression is evaluated relative to. */
  context: { kind: "field" | "node"; id: string };
  parameters: Array<{ name: string; type: EfxType }>;
  body: Expression;
}

/** Narrow a node to a reference. */
export function isReference(e: Expression): e is Reference {
  return (
    e.node === "FieldReference" || e.node === "NodeReference" ||
    e.node === "AttributeReference" || e.node === "VariableReference"
  );
}
