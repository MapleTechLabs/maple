# MCP eval fixtures and deterministic tool tests

The model-driven evals live in [`src/evals/`](../../evals/README.md). This directory keeps what
they share with the free, deterministic tests that run in `bun run test`:

- `fixtures.ts`, `fake-warehouse.ts`: canned warehouse rows, routed by the compiled SQL. The real
  `WarehouseQueryService` still runs (OrgId enforcement, DSL compile, row parsing); only the wire
  call is faked.
- `eval-runtime.ts`: the app's MCP services over PGlite, for running tools end to end.
- `utils.ts`: the fixture identifiers and the eval tenant.
- `*.test.ts`: renderer and tool regression tests that need no model.
- `harness.ts`: the old single-run harness, still used by the diagnosis eval until that moves to
  `src/evals/`.
