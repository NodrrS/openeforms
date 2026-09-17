# @openeforms/validate

ISO Schematron validation for eForms notices. No JVM, no XSLT step, no
proprietary dependencies.

Part of [OpenEForms](https://github.com/NodrrS/openeforms).

```ts
import { loadSchematron, validate, toSvrl } from "@openeforms/validate";

const schema = loadSchematron("schematrons/static/complete-validation.sch");
const report = validate(noticeXml, schema, { phase: "eforms-16" });

report.valid;             // false
report.failures[0].id;    // "ND-Buyer-1"
report.failures[0].location; // "/*:ContractNotice[1]/*:ContractingParty[1]"
toSvrl(report, schema);   // standard SVRL, readable by other Schematron tooling
```

## Why there is no XSLT step

The usual way to run Schematron is to compile it to XSLT with SchXslt and
execute that. In JavaScript the only complete XSLT 2.0+ processor is Saxon-JS,
whose npm package is published under a proprietary licence, not an open-source
one. Putting it at the centre of this library would mean the rules still could
not be run freely, which is the problem OpenEForms exists to solve.

Schematron does not require XSLT. It is a small rule language over XPath, and
XPath is available under MIT. This package interprets the rule model directly
with [fontoxpath](https://github.com/FontoXML/fontoxpath) over
[slimdom](https://github.com/bwrrp/slimdom.js). Both are MIT.

## The semantics that catch people out

**Rule contexts are match patterns, not location paths.** A context of
`cac:ProcurementProjectLot/cbc:ID` means every such element anywhere in the
document, the way an XSLT template match does. Evaluating it as a path from the
document node selects nothing, and a validator that does this reports every
document as clean. It has a regression test of its own.

**Within a pattern, the first matching rule claims the node.** Later rules in
the same pattern never see it, even when their contexts also match. Different
patterns are independent, so the same node is processed once per pattern.

**`assert` fires when its test is false; `report` fires when it is true.**

**Phases matter.** The eForms schema defines one phase per notice subtype.
Running `#ALL` against a single notice evaluates every other subtype's rules
too and produces a flood of irrelevant failures. Pass the phase for the
notice's own subtype.

## What has been verified

Against eForms SDK 1.15.1 and a real month of German notices:

| | |
| --- | --- |
| Patterns loaded through `include` | 211 |
| Rules | 12,768 |
| Assertions | 44,449 |
| Phases | 51 |
| Diagnostics | 1,059 |
| Schema load | about 8 s |
| Validation | roughly 1 s per notice for one phase |

Rules fire against real notices, match thousands of context nodes, and report
genuine eForms rule identifiers with SVRL-style locations.

## What has not been verified

**Conformance against an independent oracle.** The remaining work is to run the
same notices through the KoSIT validator and require identical failure sets.
Until that is done, this package should be treated as a working implementation
whose agreement with the reference implementation is unmeasured.

Two known gaps, both surfaced rather than hidden:

- **Some real rules do not evaluate.** A few eForms assertions use multi-variable
  quantified expressions where a later binding refers to an earlier one, which
  is valid XPath that fontoxpath rejects with `XQDY0054`. These land in
  `report.errors`; they are never silently treated as passing.
- **Abstract patterns and `is-a` instantiation** are not implemented. The eForms
  rules use none. Abstract rules are correctly skipped.

Validating notices against a rule set from a different SDK release produces
extra failures, because the German profile eForms-DE 2.1 tracks EU SDK 1.13 and
1.14 rather than 1.15. Match the versions.

## API

| Export | Purpose |
| --- | --- |
| `parseSchematron(source, { resolver, href })` | Parse a schema; `resolver` supplies `include`d files |
| `loadSchematron(path)` | Node convenience: parse from disk, resolving includes |
| `validate(doc, schema, options)` | Run the rules; returns failures, errors and counts |
| `toSvrl(report, schema)` | Render the report as standard SVRL |
| `evaluate(xpath, doc, schema, vars)` | Evaluate one XPath with the schema's prefixes |
| `contextToSelection(context)` | Turn a rule context into a selection expression |

`validate` takes `phase`, `maxFailures` and `throwOnEvaluationError`. By
default a rule whose XPath cannot be evaluated is collected in `report.errors`
and the run continues, so one broken rule cannot hide the rest.

The package reads no files of its own except through `loadSchematron`, so the
engine stays usable in a browser.

MIT.
