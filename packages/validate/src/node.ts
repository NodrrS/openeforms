/**
 * Node-specific conveniences.
 *
 * Kept apart from the engine so the rest of the package stays usable in a
 * browser, where there is no filesystem.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseSchematron, type HrefResolver, type Schema } from "./schematron.ts";

/**
 * An href resolver that reads included pattern files from disk, relative to
 * the file that referenced them.
 */
export function fileResolver(baseDir: string): HrefResolver {
  return (href, fromHref) => {
    const from = fromHref ? dirname(resolve(baseDir, fromHref)) : baseDir;
    return readFileSync(resolve(from, href), "utf8");
  };
}

/** Load a Schematron schema from disk, resolving its includes. */
export function loadSchematron(path: string): Schema {
  return parseSchematron(readFileSync(path, "utf8"), {
    resolver: fileResolver(dirname(path)),
  });
}
