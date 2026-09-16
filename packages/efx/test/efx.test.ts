import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EfxSyntaxError, UnknownSymbolError, inMemoryRegistry, parse,
  parseSingleExpression, toXPath, tokenise, singleExpressionToXPath,
  type FieldReference, type Expression,
} from "../src/index.ts";

// A small slice of the SDK's field registry, shaped like fields.json.
const registry = inMemoryRegistry(
  [
    { id: "BT-24-Lot", parentNodeId: "ND-Lot", xpathRelative: "cac:ProcurementProject/cbc:Description", xpathAbsolute: "/*/cac:ProcurementProjectLot/cac:ProcurementProject/cbc:Description", type: "text" },
    { id: "BT-137-Lot", parentNodeId: "ND-Lot", xpathRelative: "cbc:ID", xpathAbsolute: "/*/cac:ProcurementProjectLot/cbc:ID", type: "text" },
    { id: "BT-27-Lot", parentNodeId: "ND-Lot", xpathRelative: "cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount", xpathAbsolute: "/*/cac:ProcurementProjectLot/cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount", type: "number" },
    { id: "BT-01-notice", parentNodeId: "ND-Root", xpathRelative: "cbc:RegulatoryDomain", xpathAbsolute: "/*/cbc:RegulatoryDomain", type: "text" },
    { id: "BT-05-notice", parentNodeId: "ND-Root", xpathRelative: "cbc:IssueDate", xpathAbsolute: "/*/cbc:IssueDate", type: "date" },
  ],
  [
    { id: "ND-Root", xpathRelative: "/*", xpathAbsolute: "/*" },
    { id: "ND-Lot", parentNodeId: "ND-Root", xpathRelative: "cac:ProcurementProjectLot", xpathAbsolute: "/*/cac:ProcurementProjectLot" },
  ],
);

const inLot = { registry, contextNodeId: "ND-Lot" };
const inRoot = { registry, contextNodeId: "ND-Root" };

// ---------------------------------------------------------------------------

describe("lexer", () => {
  it("keeps longest-match keywords apart from identifiers", () => {
    // `in` must not be lexed out of `information`.
    const kinds = tokenise("information").map((t) => t.kind);
    assert.deepEqual(kinds, ["Identifier", "EOF"]);
  });

  it("prefers the longest axis and function names", () => {
    assert.equal(tokenise("ancestor-or-self::BT-24-Lot")[0]?.value, "ancestor-or-self");
    assert.equal(tokenise("string-length('a')")[0]?.value, "string-length");
  });

  it("distinguishes a negative literal from subtraction", () => {
    assert.deepEqual(tokenise("-5").map((t) => t.kind), ["INTEGER", "EOF"]);
    assert.deepEqual(
      tokenise("BT-27-Lot - 5").map((t) => t.kind),
      ["FieldId", "Minus", "INTEGER", "EOF"],
    );
  });

  it("lexes field identifiers with parenthesised discriminators", () => {
    assert.equal(tokenise("BT-500(a)-Organization-Company")[0]?.kind, "FieldId");
  });

  it("lexes the literal forms the grammar defines", () => {
    assert.equal(tokenise("2026-08-03Z")[0]?.kind, "DATE");
    assert.equal(tokenise("12:30:00Z")[0]?.kind, "TIME");
    assert.equal(tokenise("P30D")[0]?.kind, "DayTimeDurationLiteral");
    assert.equal(tokenise("P2Y")[0]?.kind, "YearMonthDurationLiteral");
    assert.equal(tokenise("1.5")[0]?.kind, "DECIMAL");
  });

  it("reports an unterminated string with a position", () => {
    assert.throws(() => tokenise("'abc"), EfxSyntaxError);
  });
});

// ---------------------------------------------------------------------------

describe("parser", () => {
  it("binds or looser than and", () => {
    const e = parse("TRUE and FALSE or TRUE") as Expression & { operator: string };
    assert.equal(e.node, "BinaryOperation");
    assert.equal(e.operator, "or");
  });

  it("binds multiplication tighter than addition", () => {
    const e = parse("1 + 2 * 3") as any;
    assert.equal(e.operator, "+");
    assert.equal(e.right.operator, "*");
  });

  it("respects explicit parentheses", () => {
    const e = parse("(1 + 2) * 3") as any;
    assert.equal(e.operator, "*");
    assert.equal(e.left.operator, "+");
  });

  it("parses the is-empty, is-present and is-unique conditions", () => {
    assert.equal(parse("BT-24-Lot is empty").node, "EmptinessCondition");
    assert.equal((parse("BT-24-Lot is not empty") as any).negated, true);
    assert.equal(parse("BT-24-Lot is present").node, "PresenceCondition");
    assert.equal(parse("BT-137-Lot is unique in /BT-137-Lot").node, "UniqueCondition");
  });

  it("parses in-list and not-in-list", () => {
    assert.equal(parse("BT-01-notice in ('a', 'b')").node, "InListCondition");
    assert.equal((parse("BT-01-notice not in ('a', 'b')") as any).negated, true);
  });

  it("parses quantified expressions", () => {
    const e = parse("every text:$v in ('a','b') satisfies $v == 'a'") as any;
    assert.equal(e.node, "QuantifiedExpression");
    assert.equal(e.quantifier, "every");
    assert.equal(e.iterators[0].variable, "v");
    assert.equal(e.iterators[0].variableType, "string");
  });

  it("parses for-return sequences", () => {
    const e = parse("for text:$v in ('a') return $v") as any;
    assert.equal(e.node, "ForExpression");
    assert.equal(e.type, "sequence");
  });

  it("parses predicates on references", () => {
    const e = parse("BT-137-Lot[BT-24-Lot is present]") as FieldReference;
    assert.equal(e.node, "FieldReference");
    assert.ok(e.predicate);
    assert.equal(e.predicate?.node, "PresenceCondition");
  });

  it("parses node and field context overrides", () => {
    const withNode = parse("ND-Lot::BT-24-Lot") as FieldReference;
    assert.equal(withNode.nodeContext?.nodeId, "ND-Lot");

    const withField = parse("BT-137-Lot::BT-24-Lot") as FieldReference;
    assert.equal(withField.fieldContext?.fieldId, "BT-137-Lot");

    const withVar = parse("$lot::BT-24-Lot") as FieldReference;
    assert.equal(withVar.variableContext?.name, "lot");
  });

  it("parses axes and attribute references", () => {
    assert.equal((parse("ancestor::BT-24-Lot") as FieldReference).axis, "ancestor");
    const attr = parse("BT-24-Lot/@listName") as any;
    assert.equal(attr.node, "AttributeReference");
    assert.equal(attr.attribute, "listName");
  });

  it("parses a codelist reference distinctly from a parenthesised group", () => {
    assert.equal((parse("(accessibility)") as any).node, "CodelistReference");
    assert.equal((parse("(1)") as any).node, "Literal");
    assert.equal((parse("(1, 2)") as any).node, "SequenceLiteral");
  });

  it("checks function arity at parse time", () => {
    assert.throws(() => parse("count()"), /takes 1 argument/);
    assert.throws(() => parse("substring('a')"), /takes 2 to 3/);
    assert.doesNotThrow(() => parse("substring('abc', 1, 2)"));
    assert.doesNotThrow(() => parse("concat('a','b','c','d')"));
  });

  it("infers a duration when subtracting typed date literals", () => {
    assert.equal((parse("2026-01-01Z - 2025-01-01Z") as any).type, "duration");
  });

  it("leaves arithmetic on field references late-bound", () => {
    // A field's type lives in the SDK registry, not in the expression, so the
    // parser alone cannot know that BT-05-notice is a date. Reporting
    // "late-bound" is the honest answer; the translator resolves it later.
    assert.equal((parse("BT-05-notice - BT-05-notice") as any).type, "late-bound");
  });

  it("parses a single expression with a context declaration", () => {
    const s = parseSingleExpression("[ND-Lot] BT-24-Lot is not empty");
    assert.equal(s.context.kind, "node");
    assert.equal(s.context.id, "ND-Lot");
    assert.equal(s.body.node, "EmptinessCondition");
  });

  it("parses declared parameters", () => {
    const s = parseSingleExpression("[ND-Root, text:$x, number:$n] TRUE");
    assert.deepEqual(s.parameters, [
      { name: "x", type: "string" },
      { name: "n", type: "number" },
    ]);
  });

  it("reports the offset of a syntax error", () => {
    try {
      parse("BT-24-Lot and");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof EfxSyntaxError);
      assert.match(err.message, /offset \d+/);
    }
  });
});

// ---------------------------------------------------------------------------

describe("xpath translation", () => {
  it("resolves a field relative to its own context node", () => {
    assert.equal(toXPath("BT-24-Lot", inLot), "cac:ProcurementProject/cbc:Description");
  });

  it("uses the absolute path when the context is a different node", () => {
    assert.equal(
      toXPath("BT-24-Lot", inRoot),
      "/*/cac:ProcurementProjectLot/cac:ProcurementProject/cbc:Description",
    );
  });

  it("maps == to = and % to mod", () => {
    assert.equal(toXPath("BT-27-Lot == 5", inLot),
      "(cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount = 5)");
    assert.equal(toXPath("BT-27-Lot % 2", inLot),
      "(cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount mod 2)");
    assert.equal(toXPath("4 / 2", inLot), "(4 div 2)");
  });

  it("translates emptiness as blank-or-absent, not XPath empty()", () => {
    // A present but whitespace-only element is empty in EFX.
    assert.equal(
      toXPath("BT-24-Lot is empty", inLot),
      "not(normalize-space(cac:ProcurementProject/cbc:Description) != '')",
    );
    assert.equal(
      toXPath("BT-24-Lot is not empty", inLot),
      "not(not(normalize-space(cac:ProcurementProject/cbc:Description) != ''))",
    );
  });

  it("translates presence with exists()", () => {
    assert.equal(toXPath("BT-24-Lot is present", inLot),
      "exists(cac:ProcurementProject/cbc:Description)");
  });

  it("translates uniqueness to a bounded count", () => {
    assert.equal(
      toXPath("BT-137-Lot is unique in /BT-137-Lot", inLot),
      "(count(/*/cac:ProcurementProjectLot/cbc:ID[. = cbc:ID]) <= 1)",
    );
  });

  it("translates like to matches()", () => {
    assert.equal(toXPath("BT-01-notice like '^eu$'", inRoot),
      "matches(cbc:RegulatoryDomain, '^eu$')");
  });

  it("translates in-list to an XPath general comparison", () => {
    assert.equal(toXPath("BT-01-notice in ('a', 'b')", inRoot),
      "(cbc:RegulatoryDomain = ('a', 'b'))");
    // XPath makes no distinction between a singleton and a one-item sequence,
    // so `('a')` collapsing to `'a'` is semantically identical here.
    assert.equal(toXPath("BT-01-notice not in ('a')", inRoot),
      "not(cbc:RegulatoryDomain = 'a')");
    assert.equal(toXPath("BT-01-notice not in ('a', 'b')", inRoot),
      "not(cbc:RegulatoryDomain = ('a', 'b'))");
  });

  it("preserves quantifiers and binds loop variables", () => {
    assert.equal(
      toXPath("every text:$v in ('a','b') satisfies $v == 'a'", inRoot),
      "(every $v in ('a', 'b') satisfies ($v = 'a'))",
    );
  });

  it("translates for-return", () => {
    assert.equal(
      toXPath("for text:$v in ('a') return $v", inRoot),
      "(for $v in 'a' return $v)",
    );
  });

  it("translates conditionals", () => {
    assert.equal(
      toXPath("if BT-24-Lot is present then 1 else 2", inLot),
      "(if (exists(cac:ProcurementProject/cbc:Description)) then 1 else 2)",
    );
  });

  it("does not concatenate the context onto an absolute path", () => {
    // Regression: a node context override plus an absolute field path once
    // produced /*/cac:ProcurementProjectLot/*/cac:ProcurementProjectLot/...
    const xpath = toXPath("ND-Lot::BT-24-Lot", inRoot);
    assert.equal(xpath.match(/cac:ProcurementProjectLot/g)?.length, 1);
  });

  it("translates predicates and context overrides", () => {
    assert.equal(
      toXPath("ND-Lot::BT-24-Lot", inRoot),
      "/*/cac:ProcurementProjectLot/cac:ProcurementProject/cbc:Description",
    );
    assert.equal(
      toXPath("BT-137-Lot[BT-24-Lot is present]", inLot),
      "cbc:ID[exists(cac:ProcurementProject/cbc:Description)]",
    );
  });

  it("translates attributes and axes", () => {
    assert.equal(toXPath("BT-24-Lot/@listName", inLot),
      "cac:ProcurementProject/cbc:Description/@listName");
    assert.equal(toXPath("ancestor::BT-24-Lot", inLot),
      "ancestor::cac:ProcurementProject/cbc:Description");
  });

  it("maps the set functions onto XPath equivalents", () => {
    assert.equal(toXPath("value-union(('a','x'), ('b'))", inRoot),
      "distinct-values((('a', 'x'), 'b'))");
    assert.equal(toXPath("value-except(('a'), ('b'))", inRoot),
      "distinct-values('a'[not(. = 'b')])");
    assert.equal(toXPath("distinct-values(('a','b'))", inRoot),
      "distinct-values(('a', 'b'))");
  });

  it("escapes quotes in string literals", () => {
    assert.equal(toXPath("\"it's\"", inRoot), "'it''s'");
  });

  it("refuses to guess at an unknown identifier", () => {
    assert.throws(() => toXPath("BT-9999-Lot", inLot), UnknownSymbolError);
  });

  it("can be told to pass unknown identifiers through", () => {
    assert.equal(
      toXPath("BT-9999-Lot", { ...inLot, allowUnknownSymbols: true }),
      "BT-9999-Lot",
    );
  });

  it("uses a single expression's own context declaration", () => {
    const { context, xpath } = singleExpressionToXPath(
      "[ND-Lot] BT-24-Lot is present",
      { registry },
    );
    assert.equal(context.id, "ND-Lot");
    // Relative to ND-Lot, not absolute.
    assert.equal(xpath, "exists(cac:ProcurementProject/cbc:Description)");
  });
});

// ---------------------------------------------------------------------------

describe("round trip on realistic rules", () => {
  // Shapes taken from the kind of conditions the SDK expresses.
  const cases: Array<[string, object]> = [
    ["BT-24-Lot is not empty", inLot],
    ["BT-27-Lot > 0", inLot],
    ["count(BT-137-Lot) > 1", inLot],
    ["BT-01-notice in ('eu', 'national')", inRoot],
    ["if BT-27-Lot is present then BT-27-Lot > 0 else TRUE", inLot],
    ["every text:$id in BT-137-Lot satisfies $id is not empty", inLot],
    ["not(BT-24-Lot is empty)", inLot],
    ["string-length(BT-24-Lot) <= 400", inLot],
    ["BT-137-Lot is unique in /BT-137-Lot", inLot],
    ["ND-Lot::BT-24-Lot is present", inRoot],
    ["concat(BT-137-Lot, '-', BT-24-Lot)", inLot],
    ["BT-05-notice >= 2026-01-01Z", inRoot],
  ];

  for (const [source, options] of cases) {
    it(`translates ${JSON.stringify(source)}`, () => {
      const xpath = toXPath(source, options as any);
      assert.ok(xpath.length > 0);
      // Balanced parentheses is a cheap structural check on the output.
      let depth = 0;
      for (const ch of xpath) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        assert.ok(depth >= 0, `unbalanced in ${xpath}`);
      }
      assert.equal(depth, 0, `unbalanced in ${xpath}`);
      // No business-term identifier should survive translation.
      assert.doesNotMatch(xpath, /\b(?:BT|OPP|OPT|OPA)-\d/, `unresolved id in ${xpath}`);
      assert.doesNotMatch(xpath, /\bND-[A-Za-z]/, `unresolved node in ${xpath}`);
    });
  }
});
