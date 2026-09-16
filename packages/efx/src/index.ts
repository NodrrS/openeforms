/**
 * @openeforms/efx
 *
 * A parser and XPath translator for EFX, the eForms Expression Language, with
 * no JVM anywhere in the toolchain.
 *
 * EFX is how the eForms SDK writes validation rules and conditions. The
 * canonical implementation generates a parser from an ANTLR grammar and runs
 * on Java. This package implements the same language directly, because
 * requiring a JVM to read European procurement rules is the problem
 * OpenEForms exists to remove.
 *
 * The normative grammar is vendored in `grammar/` and the parser's methods are
 * named after its rules, so the two can be checked against each other.
 *
 * ```ts
 * import { toXPath, inMemoryRegistry } from "@openeforms/efx";
 *
 * const registry = inMemoryRegistry(
 *   [{ id: "BT-24-Lot", parentNodeId: "ND-Lot", xpathRelative: "cbc:Description" }],
 *   [{ id: "ND-Lot", xpathRelative: "cac:ProcurementProjectLot" }],
 * );
 *
 * toXPath("BT-24-Lot is not empty", { registry, contextNodeId: "ND-Lot" });
 * // => "not(not(normalize-space(cbc:Description) != ''))"
 * ```
 */

export { tokenise, stringLiteralValue, EfxSyntaxError, type Token, type TokenKind } from "./lexer.ts";

export { parse, parseSingleExpression, EfxParser } from "./parser.ts";

export type {
  Expression, SingleExpression, EfxType, Literal, BinaryOperation,
  UnaryOperation, Conditional, InListCondition, LikeCondition,
  EmptinessCondition, PresenceCondition, UniqueCondition, QuantifiedExpression,
  ForExpression, SequenceLiteral, FunctionCall, TypeCast, CodelistReference,
  FieldReference, NodeReference, AttributeReference, VariableReference,
  Reference, Iterator, Axis, ComparisonOperator, ArithmeticOperator,
} from "./ast.ts";
export { isReference } from "./ast.ts";

export {
  inMemoryRegistry, fieldsJsonRegistry, UnknownSymbolError,
  type SymbolRegistry, type FieldDefinition, type NodeDefinition,
  type SdkFieldsJson,
} from "./symbols.ts";

export {
  translate, toXPath, singleExpressionToXPath, TranslationError,
  type TranslateOptions,
} from "./xpath.ts";
