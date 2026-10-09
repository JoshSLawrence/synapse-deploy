# Template fixtures

Each directory holds an exported template, its parameters file and what the
predecessor implementation produced for it (`legacy.json`).

The `legacy.json` files were recorded from the predecessor and are frozen:
they are data, not something to regenerate. The recorder no longer exists. A
`differences.json` lists where the current evaluator intentionally differs from
those records, one entry per difference with its reason; `parity.test.ts`
fails on a difference that is not listed and on a listed one that no longer
occurs.
