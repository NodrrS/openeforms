# Reference grammar

`Efx.g4` and `EfxLexer.g4` are copied verbatim from the eForms SDK, release
**1.15.1**, at `efx-grammar/` in <https://github.com/OP-TED/eForms-SDK>.

They are licensed **CC BY 4.0** by the Publications Office of the European
Union. They are included here as the normative specification this package is
written against, not as generated input: see `src/parser.ts`, whose functions
are named after these rules so the correspondence can be checked by eye.

To update: replace both files from a newer SDK tag, diff them, and adjust the
matching functions. `test/grammar-coverage.test.ts` asserts that every parser
rule named in `Efx.g4` is either implemented or listed as deliberately out of
scope, so an upstream rule that appears without being handled fails the build.
