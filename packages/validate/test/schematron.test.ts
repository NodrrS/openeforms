import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseSchematron, validate, toSvrl, parseDocument,
  SchematronError, ValidationError, SVRL_NS,
} from "../src/index.ts";

const SCH = "http://purl.oclc.org/dsdl/schematron";

/** A schema with one pattern, built from the parts a test needs. */
function schema(body: string, extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="${SCH}" queryBinding="xslt2">
  <title>test</title>
  <ns prefix="e" uri="urn:example"/>
  ${extra}
  ${body}
</schema>`;
}

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:example">
  <lot id="LOT-0001"><name>Roof</name><value>100</value></lot>
  <lot id="LOT-0002"><name></name></lot>
  <buyer><name>Stadt Bremen</name></buyer>
</root>`;

// ---------------------------------------------------------------------------

describe("parsing", () => {
  it("reads namespaces, variables, phases and diagnostics", () => {
    const s = parseSchematron(schema(
      `<pattern id="p1"><rule context="e:root"><assert id="a1" test="true()">ok</assert></rule></pattern>`,
      `<let name="lotCount" value="count(//e:lot)"/>
       <phase id="only-p1"><active pattern="p1"/></phase>
       <diagnostics><diagnostic id="d1">a diagnostic</diagnostic></diagnostics>`,
    ));
    assert.equal(s.title, "test");
    assert.equal(s.queryBinding, "xslt2");
    assert.equal(s.namespaces["e"], "urn:example");
    assert.deepEqual(s.lets, [{ name: "lotCount", value: "count(//e:lot)" }]);
    assert.deepEqual(s.phases, [{ id: "only-p1", active: ["p1"] }]);
    assert.equal(s.diagnostics["d1"], "a diagnostic");
    assert.equal(s.patterns.length, 1);
    assert.equal(s.patterns[0]?.rules[0]?.assertions[0]?.id, "a1");
  });

  it("keeps asserts and reports in document order", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <assert id="a" test="true()">A</assert>
        <report id="b" test="false()">B</report>
        <assert id="c" test="true()">C</assert>
      </rule></pattern>`,
    ));
    assert.deepEqual(
      s.patterns[0]?.rules[0]?.assertions.map((a) => a.id),
      ["a", "b", "c"],
    );
  });

  it("skips abstract rules and patterns", () => {
    const s = parseSchematron(schema(
      `<pattern id="p">
         <rule id="abs" abstract="true"><assert test="true()">x</assert></rule>
         <rule context="e:root"><assert id="real" test="true()">y</assert></rule>
       </pattern>
       <pattern id="absP" abstract="true"><rule context="e:root"><assert test="true()">z</assert></rule></pattern>`,
    ));
    assert.equal(s.patterns.length, 1);
    assert.equal(s.patterns[0]?.rules.length, 1);
    assert.equal(s.patterns[0]?.rules[0]?.assertions[0]?.id, "real");
  });

  it("resolves includes through the supplied resolver", () => {
    const files: Record<string, string> = {
      "p1.sch": `<pattern id="inc" xmlns="${SCH}"><rule context="e:root"><assert id="i1" test="true()">t</assert></rule></pattern>`,
    };
    const s = parseSchematron(
      schema(`<include href="p1.sch"/>`),
      { resolver: (href) => files[href] ?? (() => { throw new Error(`no ${href}`); })() },
    );
    assert.equal(s.patterns.length, 1);
    assert.equal(s.patterns[0]?.id, "inc");
  });

  it("explains that an include needs a resolver rather than failing obscurely", () => {
    assert.throws(
      () => parseSchematron(schema(`<include href="x.sch"/>`)),
      /no resolver was supplied/,
    );
  });

  it("rejects a document that is not Schematron", () => {
    assert.throws(
      () => parseSchematron(`<html xmlns="http://www.w3.org/1999/xhtml"/>`),
      SchematronError,
    );
  });

  it("rejects an assert with no test", () => {
    assert.throws(
      () => parseSchematron(schema(`<pattern id="p"><rule context="e:root"><assert id="x">t</assert></rule></pattern>`)),
      /has no test attribute/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("assert and report semantics", () => {
  it("fires an assert when its test is false", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <assert id="fails" test="false()">should fire</assert>
        <assert id="passes" test="true()">should not fire</assert>
      </rule></pattern>`,
    ));
    const r = validate(DOC, s);
    assert.equal(r.valid, false);
    assert.deepEqual(r.failures.map((f) => f.id), ["fails"]);
  });

  it("fires a report when its test is true, the opposite way round", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <report id="fires" test="true()">matched</report>
        <report id="quiet" test="false()">not matched</report>
      </rule></pattern>`,
    ));
    const r = validate(DOC, s);
    assert.deepEqual(r.failures.map((f) => f.id), ["fires"]);
    assert.equal(r.failures[0]?.kind, "report");
  });

  it("evaluates against real document content", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:lot">
        <assert id="has-name" test="normalize-space(e:name) != ''">name required</assert>
      </rule></pattern>`,
    ));
    const r = validate(DOC, s);
    // LOT-0002 has an empty name; LOT-0001 does not.
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0]?.id, "has-name");
    assert.match(r.failures[0]?.location ?? "", /lot\[2\]/);
  });
});

// ---------------------------------------------------------------------------

describe("first matching rule wins", () => {
  // The defining Schematron semantic: inside a pattern, a node is processed by
  // the first rule whose context matches. Getting this wrong makes a validator
  // report failures that a conformant one does not.
  const twoRules = schema(
    `<pattern id="p">
      <rule context="e:lot"><assert id="first" test="false()">first rule</assert></rule>
      <rule context="e:lot"><assert id="second" test="false()">second rule</assert></rule>
    </pattern>`,
  );

  it("does not let a later rule in the same pattern claim a matched node", () => {
    const r = validate(DOC, parseSchematron(twoRules));
    // Two lots, one rule each, never the second rule.
    assert.deepEqual(r.failures.map((f) => f.id), ["first", "first"]);
    assert.equal(r.failures.some((f) => f.id === "second"), false);
  });

  it("lets a different pattern process the same node again", () => {
    const s = parseSchematron(schema(
      `<pattern id="p1"><rule context="e:lot"><assert id="a" test="false()">a</assert></rule></pattern>
       <pattern id="p2"><rule context="e:lot"><assert id="b" test="false()">b</assert></rule></pattern>`,
    ));
    const r = validate(DOC, s);
    assert.deepEqual(r.failures.map((f) => f.id).sort(), ["a", "a", "b", "b"]);
  });

  it("still applies a later rule to nodes the earlier one did not match", () => {
    const s = parseSchematron(schema(
      `<pattern id="p">
        <rule context="e:lot[@id='LOT-0001']"><assert id="specific" test="false()">specific</assert></rule>
        <rule context="e:lot"><assert id="general" test="false()">general</assert></rule>
      </pattern>`,
    ));
    const r = validate(DOC, parseSchematron(
      schema(
        `<pattern id="p">
          <rule context="e:lot[@id='LOT-0001']"><assert id="specific" test="false()">specific</assert></rule>
          <rule context="e:lot"><assert id="general" test="false()">general</assert></rule>
        </pattern>`,
      ),
    ));
    assert.deepEqual(r.failures.map((f) => f.id), ["specific", "general"]);
    void s;
  });
});

// ---------------------------------------------------------------------------

describe("variables", () => {
  it("binds schema-level variables against the document", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <assert id="count" test="$lotCount = 2">expected two lots</assert>
        <assert id="wrong" test="$lotCount = 99">deliberately false</assert>
      </rule></pattern>`,
      `<let name="lotCount" value="count(//e:lot)"/>`,
    ));
    const r = validate(DOC, s);
    assert.deepEqual(r.failures.map((f) => f.id), ["wrong"]);
  });

  it("binds rule-level variables against the matched node", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:lot">
        <let name="lotId" value="string(@id)"/>
        <assert id="id-shape" test="starts-with($lotId, 'LOT-')">id must start with LOT-</assert>
      </rule></pattern>`,
    ));
    assert.equal(validate(DOC, s).valid, true);
  });

  it("lets a rule variable shadow a schema variable", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:lot">
        <let name="v" value="'rule'"/>
        <assert id="shadow" test="$v = 'rule'">rule scope wins</assert>
      </rule></pattern>`,
      `<let name="v" value="'schema'"/>`,
    ));
    assert.equal(validate(DOC, s).valid, true);
  });
});

// ---------------------------------------------------------------------------

describe("phases", () => {
  const s = parseSchematron(schema(
    `<pattern id="p1"><rule context="e:root"><assert id="a" test="false()">a</assert></rule></pattern>
     <pattern id="p2"><rule context="e:root"><assert id="b" test="false()">b</assert></rule></pattern>`,
    `<phase id="one"><active pattern="p1"/></phase>`,
  ));

  it("evaluates every pattern under #ALL", () => {
    const r = validate(DOC, s);
    assert.deepEqual(r.failures.map((f) => f.id), ["a", "b"]);
    assert.equal(r.patternsEvaluated, 2);
  });

  it("evaluates only the patterns a phase activates", () => {
    const r = validate(DOC, s, { phase: "one" });
    assert.deepEqual(r.failures.map((f) => f.id), ["a"]);
    assert.equal(r.patternsEvaluated, 1);
  });

  it("names the available phases when asked for one that does not exist", () => {
    assert.throws(() => validate(DOC, s, { phase: "nope" }), /Unknown phase.*one/s);
    assert.throws(() => validate(DOC, s, { phase: "nope" }), ValidationError);
  });
});

// ---------------------------------------------------------------------------

describe("diagnostics, limits and errors", () => {
  it("resolves referenced diagnostics", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <assert id="a" test="false()" diagnostics="d1 d2">msg</assert>
      </rule></pattern>`,
      `<diagnostics><diagnostic id="d1">first</diagnostic><diagnostic id="d2">second</diagnostic></diagnostics>`,
    ));
    assert.deepEqual(validate(DOC, s).failures[0]?.diagnostics, ["first", "second"]);
  });

  it("stops at maxFailures", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:lot">
        <assert id="a" test="false()">a</assert>
        <assert id="b" test="false()">b</assert>
      </rule></pattern>`,
    ));
    assert.equal(validate(DOC, s).failures.length, 4);
    assert.equal(validate(DOC, s, { maxFailures: 2 }).failures.length, 2);
  });

  it("collects a broken XPath instead of aborting the run", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <assert id="broken" test="this is not xpath (((">x</assert>
        <assert id="good" test="false()">y</assert>
      </rule></pattern>`,
    ));
    const r = validate(DOC, s);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]?.assertionId, "broken");
    // The rest of the rule still ran.
    assert.deepEqual(r.failures.map((f) => f.id), ["good"]);
  });

  it("can be told to throw on a broken XPath instead", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root"><assert id="broken" test="(((">x</assert></rule></pattern>`,
    ));
    assert.throws(() => validate(DOC, s, { throwOnEvaluationError: true }), ValidationError);
  });

  it("carries role and flag through to the failure", () => {
    const s = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root">
        <assert id="a" test="false()" role="WARN" flag="minor">w</assert>
      </rule></pattern>`,
    ));
    const f = validate(DOC, s).failures[0];
    assert.equal(f?.role, "WARN");
    assert.equal(f?.flag, "minor");
  });
});

// ---------------------------------------------------------------------------

describe("SVRL output", () => {
  const s = parseSchematron(schema(
    `<pattern id="p"><rule context="e:lot" id="r1">
      <assert id="a" test="false()" role="ERROR" diagnostics="d1">failed text</assert>
      <report id="b" test="true()">reported text</report>
    </rule></pattern>`,
    `<diagnostics><diagnostic id="d1">the diagnostic</diagnostic></diagnostics>`,
  ));
  const svrl = toSvrl(validate(DOC, s), s);

  it("is well-formed XML in the SVRL namespace", () => {
    const doc = parseDocument(svrl);
    assert.equal(doc.documentElement?.namespaceURI, SVRL_NS);
    assert.equal(doc.documentElement?.localName, "schematron-output");
  });

  it("uses failed-assert for asserts and successful-report for reports", () => {
    assert.match(svrl, /<svrl:failed-assert[^>]*id="a"/);
    assert.match(svrl, /<svrl:successful-report[^>]*id="b"/);
  });

  it("records location, test, role and diagnostics", () => {
    assert.match(svrl, /location="[^"]*lot\[1\]"/);
    assert.match(svrl, /role="ERROR"/);
    assert.match(svrl, /<svrl:diagnostic-reference>the diagnostic<\/svrl:diagnostic-reference>/);
  });

  it("escapes XML metacharacters in tests", () => {
    const esc = parseSchematron(schema(
      `<pattern id="p"><rule context="e:root"><assert id="lt" test="count(//e:lot) &gt; 99">x &amp; y</assert></rule></pattern>`,
    ));
    const out = toSvrl(validate(DOC, esc), esc);
    assert.doesNotThrow(() => parseDocument(out));
    assert.match(out, /&gt;/);
    assert.match(out, /x &amp; y/);
  });

  it("declares the schema's namespace prefixes", () => {
    assert.match(svrl, /prefix="e" uri="urn:example"/);
  });
});
