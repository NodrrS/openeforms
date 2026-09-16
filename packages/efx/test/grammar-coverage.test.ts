/**
 * Grammar coverage.
 *
 * This package transcribes `grammar/Efx.g4` by hand instead of generating a
 * parser with ANTLR, because ANTLR is a Java program and requiring a JVM to
 * read European procurement rules is the problem OpenEForms exists to remove.
 *
 * The risk of that choice is drift: a generated parser cannot fall behind its
 * grammar, a hand-written one can. This test is the control. It reads the
 * vendored grammar, extracts every parser rule, and fails if a rule is neither
 * implemented nor listed below as deliberately out of scope.
 *
 * When the SDK is updated, a new rule will fail this test until someone
 * decides what to do about it. That is the point.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GRAMMAR = new URL("../grammar/Efx.g4", import.meta.url).pathname;

/**
 * Rules implemented by `src/parser.ts`, whether as a method of the same name
 * or folded into the precedence-climbing tiers. EFX spells out one rule per
 * type — `booleanExpression`, `numericExpression` and so on — where a
 * precedence-climbing parser uses one tier for all of them, so a single method
 * legitimately covers a family of rules.
 */
const IMPLEMENTED = new Set([
  // entry points
  "singleExpression", "expression", "expressionBlock",
  // typed expression families, handled by the precedence tiers
  "lateBoundExpression", "booleanExpression", "stringExpression",
  "numericExpression", "dateExpression", "timeExpression", "durationExpression",
  // sequences
  "sequenceExpression", "stringSequence", "booleanSequence", "numericSequence",
  "dateSequence", "timeSequence", "durationSequence",
  "stringSequenceFromIteration", "booleanSequenceFromIteration",
  "numericSequenceFromIteration", "dateSequenceFromIteration",
  "timeSequenceFromIteration", "durationSequenceFromIteration",
  // iteration
  "iteratorList", "iteratorExpression",
  "stringIteratorExpression", "booleanIteratorExpression",
  "numericIteratorExpression", "dateIteratorExpression",
  "timeIteratorExpression", "durationIteratorExpression",
  "contextIteratorExpression",
  // literals
  "stringLiteral", "numericLiteral", "booleanLiteral", "trueBooleanLiteral",
  "falseBooleanLiteral", "dateLiteral", "timeLiteral", "durationLiteral",
  // declarations
  "parameterList", "parameterDeclaration", "parameterValue",
  "stringVariableDeclaration", "booleanVariableDeclaration",
  "numericVariableDeclaration", "dateVariableDeclaration",
  "timeVariableDeclaration", "durationVariableDeclaration",
  "contextVariableDeclaration",
  // references
  "variableReference", "scalarFromReference", "sequenceFromReference",
  "pathFromReference", "attributeReference", "fieldReference",
  "fieldReferenceInOtherNotice", "fieldReferenceWithVariableContextOverride",
  "fieldReferenceWithNodeContextOverride",
  "fieldReferenceWithFieldContextOverride", "fieldReferenceWithPredicate",
  "fieldReferenceWithAxis", "simpleFieldReference", "absoluteFieldReference",
  "fieldContext", "nodeReference", "nodeReferenceInOtherNotice", "nodeContext",
  "absoluteNodeReference", "nodeReferenceWithPredicate", "simpleNodeReference",
  "noticeReference", "codelistReference", "codelistId", "axis", "predicate",
  "contextFieldSpecifier", "contextNodeSpecifier", "contextVariableSpecifier",
  "contextDeclarationBlock",
  // functions
  "booleanFunction", "numericFunction", "stringFunction", "dateFunction",
  "timeFunction", "durationFunction", "sequenceFunction",
]);

/**
 * Rules this package does not implement, each with the reason.
 *
 * All of these belong to EFX *templates* — the label and free-text machinery
 * used to render human-readable notice views. Templates need the SDK's label
 * asset files and the lexer's LABEL and DEFAULT modes. They are a separate
 * concern from evaluating validation rules, and are not needed by the
 * validation package that consumes this one.
 */
const OUT_OF_SCOPE = new Map<string, string>([
  ["templateFile", "EFX templates are not implemented"],
  ["templateLine", "EFX templates are not implemented"],
  ["template", "EFX templates are not implemented"],
  ["templateFragment", "EFX templates are not implemented"],
  ["textBlock", "EFX templates are not implemented"],
  ["whitespace", "template lexing only"],
  ["labelBlock", "label rendering needs the SDK label assets"],
  ["labelType", "label rendering needs the SDK label assets"],
  ["assetType", "label rendering needs the SDK label assets"],
  ["assetId", "label rendering needs the SDK label assets"],
  ["otherAssetId", "label rendering needs the SDK label assets"],
]);

function parserRules(source: string): string[] {
  // Strip comments first: a block comment can contain text at column 0 that
  // would otherwise look like a rule declaration.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const rules = new Set<string>();
  // A parser rule name sits at column 0 and is lower-case. The colon may be on
  // the same line or on the next one, which the grammar does for the larger
  // rules, so the gap is allowed to span newlines.
  const re = /^([a-z][A-Za-z0-9_]*)\s*:/gm;
  for (const m of code.matchAll(re)) {
    if (m[1]) rules.add(m[1]);
  }
  return [...rules].sort();
}

describe("grammar coverage", () => {
  const source = readFileSync(GRAMMAR, "utf8");
  const rules = parserRules(source);

  it("finds the grammar's parser rules", () => {
    assert.ok(rules.length > 80, `expected a substantial grammar, found ${rules.length} rules`);
    // Spot-check anchors that must exist in any EFX grammar.
    for (const anchor of ["expression", "booleanExpression", "fieldReference"]) {
      assert.ok(rules.includes(anchor), `missing anchor rule ${anchor}`);
    }
  });

  it("accounts for every parser rule in the grammar", () => {
    const unaccounted = rules.filter(
      (r) => !IMPLEMENTED.has(r) && !OUT_OF_SCOPE.has(r),
    );
    assert.deepEqual(
      unaccounted,
      [],
      `Grammar rules neither implemented nor declared out of scope:\n` +
        unaccounted.map((r) => `  - ${r}`).join("\n") +
        `\n\nThe vendored grammar has changed. Implement these in src/parser.ts, ` +
        `or add them to OUT_OF_SCOPE with a reason.`,
    );
  });

  it("does not claim coverage of rules the grammar no longer has", () => {
    const known = new Set(rules);
    const stale = [...IMPLEMENTED, ...OUT_OF_SCOPE.keys()].filter((r) => !known.has(r));
    assert.deepEqual(
      stale,
      [],
      `These rules are listed here but absent from the grammar, so the lists ` +
        `are out of date:\n${stale.map((r) => `  - ${r}`).join("\n")}`,
    );
  });

  it("states a reason for every unimplemented rule", () => {
    for (const [rule, reason] of OUT_OF_SCOPE) {
      assert.ok(reason.length > 10, `rule ${rule} needs a real reason, not ${JSON.stringify(reason)}`);
    }
  });

  it("records which SDK release the grammar came from", () => {
    const readme = readFileSync(
      new URL("../grammar/README.md", import.meta.url).pathname,
      "utf8",
    );
    assert.match(readme, /\b\d+\.\d+\.\d+\b/, "grammar README must pin an SDK version");
  });
});
