/**
 * SVRL output.
 *
 * Schematron Validation Report Language is the standard result format, so a
 * report from this engine can be read by tooling built for any other
 * Schematron implementation. Emitting it is what keeps this package
 * interoperable rather than a private dialect.
 */

import { type ValidationReport } from "./engine.ts";
import { type Schema } from "./schematron.ts";

export const SVRL_NS = "http://purl.oclc.org/dsdl/svrl";

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function attrIfPresent(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeAttr(value)}"`;
}

/**
 * Render a validation report as SVRL.
 *
 * A failed `assert` becomes `failed-assert`; a fired `report` becomes
 * `successful-report`, which is SVRL's counter-intuitive but correct name for
 * a report whose condition matched.
 */
export function toSvrl(report: ValidationReport, schema?: Schema): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<svrl:schematron-output xmlns:svrl="${SVRL_NS}"` +
      attrIfPresent("title", schema?.title) +
      attrIfPresent("phase", report.phase === "#ALL" ? undefined : report.phase) +
      ">",
  );

  if (schema) {
    for (const [prefix, uri] of Object.entries(schema.namespaces)) {
      lines.push(`  <svrl:ns-prefix-in-attribute-values prefix="${escapeAttr(prefix)}" uri="${escapeAttr(uri)}"/>`);
    }
  }

  let currentPattern: string | undefined | null = null;
  for (const f of report.failures) {
    if (f.patternId !== currentPattern) {
      currentPattern = f.patternId;
      lines.push(`  <svrl:active-pattern${attrIfPresent("id", f.patternId)}/>`);
    }
    lines.push(`  <svrl:fired-rule context="${escapeAttr(f.ruleContext)}"${attrIfPresent("id", f.ruleId)}/>`);

    const element = f.kind === "assert" ? "failed-assert" : "successful-report";
    lines.push(
      `  <svrl:${element} test="${escapeAttr(f.test)}" location="${escapeAttr(f.location)}"` +
        attrIfPresent("id", f.id) +
        attrIfPresent("role", f.role) +
        attrIfPresent("flag", f.flag) +
        ">",
    );
    if (f.message) lines.push(`    <svrl:text>${escapeText(f.message)}</svrl:text>`);
    for (const d of f.diagnostics) {
      lines.push(`    <svrl:diagnostic-reference>${escapeText(d)}</svrl:diagnostic-reference>`);
    }
    lines.push(`  </svrl:${element}>`);
  }

  lines.push("</svrl:schematron-output>");
  return lines.join("\n");
}
