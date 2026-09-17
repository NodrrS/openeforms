/**
 * Integration test against the real eForms SDK rule set.
 *
 * Fixtures are large and not committed. To run:
 *
 *   cd .fixtures
 *   curl -sLO https://github.com/OP-TED/eForms-SDK/archive/refs/tags/1.15.1.tar.gz
 *   tar -xzf 1.15.1.tar.gz eForms-SDK-1.15.1/schematrons
 *   curl -o 2026-08-eforms.zip \
 *     "https://oeffentlichevergabe.de/api/notice-exports?pubMonth=2026-08&format=eforms.zip"
 *   unzip -q 2026-08-eforms.zip -d 2026-08
 *
 * The suite skips itself when they are absent, so `npm test` works on a clean
 * clone.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  contextToSelection, evaluate, loadSchematron, parseDocument, toSvrl, validate,
  type Schema,
} from "../src/index.ts";

const FIXTURES = new URL("../../../.fixtures/", import.meta.url).pathname;
const SCHEMA_PATH = join(FIXTURES, "eForms-SDK-1.15.1/schematrons/static/complete-validation.sch");
const NOTICES = join(FIXTURES, "2026-08");
const AVAILABLE = existsSync(SCHEMA_PATH) && existsSync(NOTICES);

const SUBTYPE =
  "/*/*:UBLExtensions/*:UBLExtension/*:ExtensionContent/*:EformsExtension" +
  "/*:NoticeSubType/*:SubTypeCode/text()";

describe("eForms SDK rule set", { skip: AVAILABLE ? false : "fixtures not present" }, () => {
  let schema: Schema;

  before(() => {
    schema = loadSchematron(SCHEMA_PATH);
  });

  it("loads the whole rule set through 211 includes", () => {
    assert.equal(schema.patterns.length, 211);
    assert.equal(schema.phases.length, 51);
    assert.equal(Object.keys(schema.namespaces).length, 12);
    assert.equal(Object.keys(schema.diagnostics).length, 1059);
    assert.equal(schema.queryBinding, "xslt2");
  });

  it("carries tens of thousands of assertions", () => {
    const rules = schema.patterns.reduce((n, p) => n + p.rules.length, 0);
    const assertions = schema.patterns.reduce(
      (n, p) => n + p.rules.reduce((m, r) => m + r.assertions.length, 0),
      0,
    );
    assert.ok(rules > 12_000, `expected >12000 rules, got ${rules}`);
    assert.ok(assertions > 44_000, `expected >44000 assertions, got ${assertions}`);
  });

  it("binds the schema's global variables against a real notice", () => {
    const doc = parseDocument(readFileSync(join(NOTICES, firstNotice()), "utf8"));
    const subType = evaluate(SUBTYPE, doc, schema);
    assert.match(subType, /^[A-Z0-9]+$/);
  });

  it("fires rules on a real notice and reports real rule identifiers", () => {
    const file = firstNotice();
    const doc = parseDocument(readFileSync(join(NOTICES, file), "utf8"));
    const phase = `eforms-${evaluate(SUBTYPE, doc, schema)}`;
    const report = validate(doc, schema, { phase, maxFailures: 100 });

    // The phase narrows to the subtype's patterns, not all 211.
    assert.ok(report.patternsEvaluated > 0 && report.patternsEvaluated < 30);

    // Rules must actually match nodes. Zero here is the silent-failure mode
    // that the match-pattern bug produced.
    assert.ok(report.nodesMatched > 100, `only ${report.nodesMatched} nodes matched`);

    for (const f of report.failures) {
      assert.match(
        f.id ?? "",
        /^[A-Za-z0-9_-]+$/,
        `failure id looks malformed: ${JSON.stringify(f.id)}`,
      );
      assert.ok(f.location.startsWith("/"), `location should be an XPath: ${f.location}`);
      assert.ok(f.test.length > 0);
    }
  });

  it("produces SVRL that parses back as XML", () => {
    const doc = parseDocument(readFileSync(join(NOTICES, firstNotice()), "utf8"));
    const phase = `eforms-${evaluate(SUBTYPE, doc, schema)}`;
    const svrl = toSvrl(validate(doc, schema, { phase, maxFailures: 25 }), schema);
    const parsed = parseDocument(svrl);
    assert.equal(parsed.documentElement?.localName, "schematron-output");
  });

  it("records unevaluable assertions rather than aborting the run", () => {
    // Some real rules use multi-variable quantified expressions where a later
    // binding refers to an earlier one. fontoxpath rejects those. The engine
    // must collect them and keep going, so one engine limitation cannot hide
    // every rule that does work.
    const doc = parseDocument(readFileSync(join(NOTICES, firstNotice()), "utf8"));
    const phase = `eforms-${evaluate(SUBTYPE, doc, schema)}`;
    const report = validate(doc, schema, { phase, maxFailures: 500 });
    assert.ok(Array.isArray(report.errors));
    // Whatever the error count, evaluation completed and rules still fired.
    assert.ok(report.nodesMatched > 0);
  });

  function firstNotice(): string {
    const files = readdirSync(NOTICES).filter((f) => f.endsWith(".xml"));
    assert.ok(files.length > 0, "no notices in the fixture directory");
    return files[0] as string;
  }
});

describe("rule contexts are match patterns", () => {
  // Regression: contexts were once evaluated as location paths from the
  // document node, so every relative context selected nothing and the
  // validator reported every document as clean. That is the worst possible
  // failure mode for a validator, so it gets its own test.
  it("anchors a relative context so it matches anywhere in the tree", () => {
    assert.equal(contextToSelection("cbc:ID"), "//(cbc:ID)");
    assert.equal(contextToSelection("cac:Lot/cbc:ID"), "//(cac:Lot/cbc:ID)");
  });

  it("leaves an absolute context alone", () => {
    assert.equal(contextToSelection("/*"), "/*");
    assert.equal(contextToSelection("/*/cac:ContractingParty"), "/*/cac:ContractingParty");
  });

  it("wraps alternation so it distributes over both branches", () => {
    assert.equal(contextToSelection("cbc:ID|cbc:Name"), "//(cbc:ID|cbc:Name)");
  });

  it("handles attribute contexts", () => {
    assert.equal(contextToSelection("cbc:ID/@schemeName"), "//(cbc:ID/@schemeName)");
  });

  it("actually selects nodes a location path would miss", () => {
    const doc = parseDocument(
      `<root xmlns="urn:x"><a><b>1</b></a><a><b>2</b></a></root>`,
    );
    const schema = {
      namespaces: { x: "urn:x" }, lets: [], phases: [], patterns: [],
      diagnostics: {}, title: undefined, queryBinding: undefined,
    } as Schema;
    // As written, a relative path from the document node finds nothing.
    assert.equal(evaluate("count(x:b)", doc, schema), "0");
    // Anchored as a match pattern, it finds both.
    assert.equal(evaluate(`count(${contextToSelection("x:b")})`, doc, schema), "2");
  });
});
