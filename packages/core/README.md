# @openeforms/core

Namespace-aware parser and normalised model for eForms procurement notices,
including the German eForms-DE profile.

Part of [OpenEForms](https://github.com/NodrrS/openeforms). See the root README
for why the library is built the way it is, and
[openeforms-probe](https://github.com/NodrrS/openeforms-probe) for the
measurements behind those decisions.

```ts
import { parseNotice, keyOf } from "@openeforms/core";

const notice = parseNotice(xmlBytes);
notice.profile.family;   // "eforms-de" | "eforms-sdk" | "unknown"
notice.version;          // { raw: "01", number: 1, zeroPadded: true }
keyOf(notice);           // stable across the 01 / 1 padding split
notice.contractFolderId; // string | undefined — absent on 38% of real notices
notice.diagnostics;      // what was missing, reported rather than thrown
```

All element access is by `(namespaceUri, localName)`. The library never
dispatches on an XML prefix, because seven different prefixes carry the same
root elements in production data.

MIT.
