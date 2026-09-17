/**
 * @openeforms/validate
 *
 * ISO Schematron validation for eForms notices, with no JVM, no XSLT step and
 * no proprietary dependencies.
 *
 * The usual route compiles Schematron to XSLT and runs it under Saxon-JS,
 * whose npm package is not open source. Schematron does not require XSLT: it
 * is a small rule language over XPath, and XPath is available under MIT. This
 * package interprets the rules directly with fontoxpath.
 *
 * ```ts
 * import { loadSchematron, validate, toSvrl } from "@openeforms/validate";
 *
 * const schema = loadSchematron("schematrons/static/complete-validation.sch");
 * const report = validate(noticeXml, schema, { phase: "eforms-16" });
 *
 * report.valid;            // false
 * report.failures[0].id;   // "ND-Buyer-1"
 * toSvrl(report, schema);  // standard SVRL, readable by other tooling
 * ```
 */

export {
  parseSchematron, SchematronError, SCH_NS,
  type Schema, type Pattern, type Rule, type Assertion, type Phase,
  type Variable, type Role, type HrefResolver,
} from "./schematron.ts";

export {
  validate, evaluate, parseDocument, contextToSelection, ValidationError,
  type ValidationReport, type Failure, type ValidateOptions,
  type EvaluationError,
} from "./engine.ts";

export { toSvrl, SVRL_NS } from "./svrl.ts";

export { loadSchematron, fileResolver } from "./node.ts";
