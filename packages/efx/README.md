# @openeforms/efx

Parser and XPath translator for **EFX**, the eForms Expression Language.
No JVM anywhere in the toolchain.

Part of [OpenEForms](https://github.com/NodrrS/openeforms).

```ts
import { toXPath, inMemoryRegistry } from "@openeforms/efx";

const registry = inMemoryRegistry(
  [{ id: "BT-24-Lot", parentNodeId: "ND-Lot",
     xpathRelative: "cac:ProcurementProject/cbc:Description" }],
  [{ id: "ND-Lot", xpathRelative: "cac:ProcurementProjectLot" }],
);

toXPath("BT-24-Lot is not empty", { registry, contextNodeId: "ND-Lot" });
// "not(not(normalize-space(cac:ProcurementProject/cbc:Description) != ''))"
```

## Why it is hand-written

The canonical toolchain generates a parser from `Efx.g4` with ANTLR, which is a
Java program. This package does not, because the whole reason OpenEForms exists
is that consuming eForms currently means running a JVM. A build step needing
Java would reintroduce that problem for every contributor and every CI job.

The cost is honest: a hand-written parser can drift from the grammar, a
generated one cannot. Three things hold it in place.

1. The grammar is vendored in [`grammar/`](grammar) as the normative
   specification, pinned to an SDK release.
2. Parser methods are named after the grammar's rules.
3. `test/grammar-coverage.test.ts` extracts every parser rule from the `.g4`
   and fails if one is neither implemented nor listed as deliberately out of
   scope. An upstream change cannot pass unnoticed.

## Scope

Implemented: the whole expression language — typed expressions, sequences,
iterators and quantifiers, field and node references with axes, predicates and
context overrides, attribute references, codelist references, and all 23
functions.

Not implemented: EFX **templates**, the label and free-text machinery for
rendering human-readable notice views. Templates need the SDK's label assets
and two further lexer modes, and are not needed to evaluate validation rules.
The coverage test lists each template rule with that reason.

## Symbol resolution

EFX names business terms; the mapping to XPath lives in the SDK's
`fields.json`. This package does not bundle the SDK, because a pinned copy
inside a library is how implementations quietly fall behind. Supply a registry:

```ts
import { fieldsJsonRegistry } from "@openeforms/efx";
const registry = fieldsJsonRegistry(JSON.parse(await readFile("fields.json", "utf8")));
```

An unknown identifier throws by default. A silently wrong XPath is worse than a
loud failure; pass `allowUnknownSymbols` if you want the identifier emitted
as-is.

MIT. The vendored grammar is CC BY 4.0, Publications Office of the European Union.
