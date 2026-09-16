/**
 * Symbol resolution.
 *
 * EFX refers to business terms by identifier — `BT-24-Lot`, `ND-Root` — and
 * the mapping from an identifier to an XPath location lives in the SDK's
 * `fields/fields.json`, not in the grammar. Translating EFX to XPath therefore
 * needs a registry.
 *
 * This package does not bundle the SDK. The SDK is a versioned artefact that
 * changes several times a year, and pinning a copy inside a library is how
 * implementations quietly fall behind. Instead the caller supplies a registry,
 * and {@link fieldsJsonRegistry} adapts the SDK's own `fields.json` to it.
 */

export interface FieldDefinition {
  /** Field identifier, e.g. `BT-24-Lot`. */
  id: string;
  /** Identifier of the node this field hangs from, e.g. `ND-Lot`. */
  parentNodeId: string;
  /** XPath relative to the parent node. */
  xpathRelative: string;
  /** Absolute XPath from the document root, when the SDK publishes one. */
  xpathAbsolute?: string;
  /** SDK value type, e.g. `text`, `indicator`, `date`, `measure`, `code`. */
  type?: string;
  /** Codelist this field draws from, when it is a coded field. */
  codelistId?: string;
}

export interface NodeDefinition {
  id: string;
  parentNodeId?: string;
  xpathRelative: string;
  xpathAbsolute?: string;
}

export interface SymbolRegistry {
  field(id: string): FieldDefinition | undefined;
  node(id: string): NodeDefinition | undefined;
}

export class UnknownSymbolError extends Error {
  readonly symbol: string;
  constructor(symbol: string, kind: "field" | "node") {
    super(
      `Unknown ${kind} identifier ${JSON.stringify(symbol)}. ` +
        `Supply a registry built from the eForms SDK's fields.json for the SDK version this expression targets.`,
    );
    this.name = "UnknownSymbolError";
    this.symbol = symbol;
  }
}

/** A registry backed by plain maps. Useful for tests and for small subsets. */
export function inMemoryRegistry(
  fields: readonly FieldDefinition[],
  nodes: readonly NodeDefinition[],
): SymbolRegistry {
  const f = new Map(fields.map((x) => [x.id, x]));
  const n = new Map(nodes.map((x) => [x.id, x]));
  return { field: (id) => f.get(id), node: (id) => n.get(id) };
}

/** The shape of the SDK's `fields/fields.json`, as far as this package needs. */
export interface SdkFieldsJson {
  sdkVersion?: string;
  fields?: Array<{
    id: string;
    parentNodeId: string;
    xpathRelative: string;
    xpathAbsolute?: string;
    type?: string;
    codeList?: { value?: { id?: string } };
  }>;
  xmlStructure?: Array<{
    id: string;
    parentId?: string;
    xpathRelative: string;
    xpathAbsolute?: string;
  }>;
}

/**
 * Build a registry from the SDK's `fields.json`.
 *
 * ```ts
 * const sdk = JSON.parse(await readFile("fields.json", "utf8"));
 * const registry = fieldsJsonRegistry(sdk);
 * ```
 */
export function fieldsJsonRegistry(json: SdkFieldsJson): SymbolRegistry {
  const fields: FieldDefinition[] = (json.fields ?? []).map((f) => ({
    id: f.id,
    parentNodeId: f.parentNodeId,
    xpathRelative: f.xpathRelative,
    ...(f.xpathAbsolute !== undefined ? { xpathAbsolute: f.xpathAbsolute } : {}),
    ...(f.type !== undefined ? { type: f.type } : {}),
    ...(f.codeList?.value?.id !== undefined ? { codelistId: f.codeList.value.id } : {}),
  }));
  const nodes: NodeDefinition[] = (json.xmlStructure ?? []).map((n) => ({
    id: n.id,
    ...(n.parentId !== undefined ? { parentNodeId: n.parentId } : {}),
    xpathRelative: n.xpathRelative,
    ...(n.xpathAbsolute !== undefined ? { xpathAbsolute: n.xpathAbsolute } : {}),
  }));
  return inMemoryRegistry(fields, nodes);
}
