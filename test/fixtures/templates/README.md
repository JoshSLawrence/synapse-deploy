# Template fixtures

Each directory holds an exported template, its parameters file and what the
predecessor implementation produced for it (`legacy.json`).

The `legacy.json` files were recorded from the predecessor and are frozen:
they are data, not something to regenerate. The recorder no longer exists. The
`differences.json` files, which list where the current evaluator intentionally
differs from these records, arrive with the template engine.
