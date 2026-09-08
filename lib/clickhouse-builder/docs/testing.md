# Testing and release checks

The release target is the builder's supported API, not the entire ClickHouse SQL
language. The standalone suite uses public package exports from a fresh build and
executes deterministic SELECT/CTE fixtures. It does not create tables or write data.

## Commands

Run these from `lib/clickhouse-builder`:

```sh
bun run build
bun run typecheck
bun run test
```

`test` includes SQL generation, type/codec regressions, the dialect coverage manifest,
and documentation checks. Live tests skip when no endpoint is configured.
`typecheck` also checks the compile-time assertion files under `src/`, live
fixtures under `tests/`, and TypeScript release scripts under `scripts/`; build first because the latter import public exports.

For live tests against an existing local server:

```sh
CLICKHOUSE_BUILDER_TEST_URL=http://127.0.0.1:8123 \
CLICKHOUSE_BUILDER_TEST_USER=maple \
CLICKHOUSE_BUILDER_TEST_PASSWORD=maple \
bun run test:clickhouse
```

`test:clickhouse` builds the package and requires an endpoint. Missing configuration,
an unreachable server, a failed assertion, or a decoding error fails the command.
The user defaults to `default` and the password to an empty string.

`bun run test:package` builds and packs the package, installs the tarball outside the
workspace with its Effect peer, typechecks a consumer with strict declarations, and
executes imports from all four public entry points under Node. This needs npm registry
access. It uses the installed Effect and TypeScript versions, with explicit Node, DOM,
and disposable type libraries required by the Effect declarations.

`bun run test:release` requires the same ClickHouse environment and runs build,
typecheck, all tests (including live tests), documentation checks, and the isolated
tarball check. `prepublishOnly` runs it too, so publishing cannot silently skip live
checks. Packing for inspection uses `npm pack --ignore-scripts` and never publishes.

## What the manifest guarantees

`tests/dialect-cases.ts` is the fixture manifest. Each case names the features it
covers and asserts complete decoded result rows. `tests/dialect-coverage.test.ts`
discovers the function barrel, built query/union methods, and public type descriptors,
and rejects missing coverage, stale entries, duplicate case IDs, and redundant
exemptions. Add a case or a specific exemption when extending those APIs.

The inventory covers the wrapped ClickHouse functions (including `/expr` names),
query and union methods, and built-in type descriptors. It is not a percentage of
ClickHouse's grammar, every overload, every input combination, or every low-level
expression/SQL factory. Those also have unit and consumer checks. Custom and untyped
descriptors are explicit extension points: their factories are smoke-tested, but the
caller's SQL type and schema remain the caller's responsibility.

Cases cover normal results plus selected empty inputs, nullable/nested values,
64-bit identity preservation through `toString`, parameter escaping, grouped windows,
and joins against nullable unions. Each case runs under both quoted/unquoted 64-bit
JSON output and default/nullable outer joins. The original publishing regression
suite additionally checks unmatched joins under both settings and DateTime64 bounds.
Fixtures pin the session timezone to UTC, matching the timestamp codecs' wire contract.
Both JSON and JSONEachRow response formats are exercised.

Tests preserve documented behavior: arithmetic chains follow SQL precedence, not call
order, and `windowFunnel` with `strict_order` rejects intervening events.

## Version and CI policy

Regular PR CI runs the standalone live and tarball checks only when
`lib/clickhouse-builder/**` changes, reusing the existing ClickHouse 26.2 service.
Unrelated app, warehouse, root lockfile, and shared CI changes do not trigger these
two checks. Maple's schema/catalog tests remain additional product regression
coverage; the standalone suite does not depend on Maple tables or migrations.

Before release, run **ClickHouse builder release checks**
(`.github/workflows/clickhouse-builder-release.yml`) on the exact release commit.
It runs the complete release check against pinned **26.2.19.43** and **26.8.2.7**
servers. These are tested compatibility points; older versions are not established
by this suite. The workflow is also callable by a publishing workflow, which should
make publishing depend on its success. The matrix is intentionally reserved for
release checks to avoid repeating service setup on every PR.

The workflow validates but does not publish. Its successful results apply only to the
commit tested; rerun it after any release changes.

## Upstream references

ClickHouse's [stateless functional tests](https://github.com/ClickHouse/ClickHouse/tree/master/tests/queries/0_stateless)
and [testing guide](https://clickhouse.com/docs/resources/develop-contribute/contribute/tests)
are useful sources of additional edge cases. Port relevant operations into the DSL
and retain provenance when copying fixtures. Executing upstream SQL unchanged would
not validate the builder. The current small fixtures were written for this package.
