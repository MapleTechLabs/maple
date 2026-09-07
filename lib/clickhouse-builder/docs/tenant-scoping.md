# Tenant scoping

Every compiled query carries a `tenantScope`:

```ts
compiled.tenantScope // "single-tenant" | "cross-tenant" | "untenanted"
```

`"single-tenant"` means the query pins itself to one tenant. `"cross-tenant"` means it reads whatever
the credentials can see. The builder only _computes and reports_ this — it never blocks a
query. The intended use is that your executor refuses `"cross-tenant"` on its ordinary read path,
so a forgotten tenant filter fails loudly instead of quietly returning another tenant's rows.

> **Read this page before relying on the field.** It answers a narrow question precisely, and
> silently answers `"cross-tenant"` for everything outside that narrowness.

## Declare the tenant column

Row-per-tenant is the usual ClickHouse multi-tenancy shape, but whether a table has one — and
what the column is called — is a schema decision, so it is declared on the table:

```ts
const Events = CH.table("events", { OrgId: T.string, Name: T.string }, { tenantColumn: "OrgId" })
```

The option is checked against the column names you just declared, so a typo is a type error
rather than a query that silently never scopes. A table with **no** `tenantColumn` has nothing to
pin, and compiles to the third scope:

```ts
const Untenanted = CH.table("untenanted", { tenant_id: T.string, Name: T.string })

CH.from(Untenanted)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.tenant_id.eq("org_123")])
// tenantScope: "untenanted"  ← the column is not declared, so it does not scope
```

`"untenanted"` is not `"cross-tenant"`, and the difference is the point: "this table has no
row-level tenancy" and "this query reads every tenant's rows" are different facts, and an
executor that refuses the second should not refuse the first — otherwise every query over a
dimension or lookup table is refused.

The builder only says `"untenanted"` when it can see every source and none declares a tenant
column. Anything it cannot see into — a CTE handed to it as a SQL string, a subquery over a
table that does declare one — keeps the query at `"cross-tenant"`, so the unknown case is still
the refused one.

_(Backed by `docs/tenant-scoping.md > A table without a declared tenant column is untenanted`.)_

## What marks a query scoped

A query is `"single-tenant"` when **every tenanted source** is confined to the same tenant.
A binding is an equality to a literal or parameter, or a one-value `in_`. Tenant-key
equalities can propagate that binding across joins. Filtering only the main table does
not scope an independently joined tenant table.

```ts
CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])
// tenantScope: "single-tenant"
```

_(Backed by `docs/tenant-scoping.md > An OrgId equality scopes the query`.)_

Declaring a column that is not actually a tenant key will mark queries as scoped when they are
not — the builder takes the declaration at face value. Know which case you are in before building
an authorization decision on top of this.

## Only `eq` and `in_` count

```ts
$.OrgId.eq("org_123") // scopes
$.OrgId.in_("org_a") // scopes
$.OrgId.in_("org_a", "org_b") // cross-tenant
$.OrgId.eq($.OrgId) // does NOT scope
$.OrgId.neq("org_123") // does NOT scope
$.OrgId.like("org_%") // does NOT scope
```

`!=` and `LIKE` on the tenant column narrow nothing meaningful, and treating them as scoping
would be worse than useless.

_(Backed by `docs/tenant-scoping.md > in_ also scopes; neq does not`.)\_

## `and` preserves evidence; `or` discards it

```ts
.where(($) => [$.OrgId.eq("org_123").or($.Name.eq("checkout"))])
// tenantScope: "cross-tenant"
```

This is the bug the marker exists to catch: `OrgId = x OR anything` matches rows from other
tenants. `or()` drops scoping evidence deliberately. `and()` preserves it, so both a separate
entry in the `where` array and `$.OrgId.eq("org_123").and(otherCondition)` can scope a source.

_(Backed by `docs/tenant-scoping.md > The marker does not survive or()`.)_

## Inherited scope

A query reading only from scoped sources is itself scoped, even with no `where` of its own:

```ts
const inner = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])

CH.fromQuery(inner, "sub").select(($) => ({ name: $.name }))
// tenantScope: "single-tenant"
```

For joins, every tenanted source needs a binding to the **same value**. An inner join on
tenant keys can propagate a binding in either direction. A LEFT JOIN's ON clause can
constrain the right side, but cannot filter the preserved left side. An unmatched right
row therefore never proves the left side is scoped. Bind the preserved side explicitly:
with `join_use_nulls=0`, a filter matching the right column's default can retain unmatched
rows from any left-side tenant. The builder conservatively avoids reverse propagation
through LEFT JOINs.

Typed CTEs, FROM-subqueries, and unions inherit their inner scope and bound tenant value.
A union of `org_a` and `org_b` is cross-tenant even when each branch is individually scoped.
Apply tenant filters inside each derived query: filtering a projected column outside it
cannot prove that its aggregates or other columns exclude other tenants. Handwritten CTEs
require a scope declaration; see [Unions and CTEs](./unions-and-ctes.md#declare-the-ctes-scope).

## `crossTenant()` — the explicit opt-out

```ts
CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])
	.crossTenant()
// tenantScope: "cross-tenant"
```

`crossTenant()` forces `"cross-tenant"` regardless of the predicates, and it wins over everything
else. The point is to distinguish "this query deliberately spans tenants" from "someone forgot
the filter" — two states that are otherwise identical from the outside. Use it for admin and
internal-rollup queries so that reviewers, and your executor, can tell them apart.

_(Backed by `docs/tenant-scoping.md > crossTenant() is the explicit opt-out`.)_

## `route(tag)`

```ts
const compiled = CH.compileUnsafe(CH.from(Events).select(…).route("archive"), params)
compiled.route // "archive"
```

`.route(tag)` is unrelated metadata that rides along on the compiled query, as a type-level
fact as well as a runtime one. The tag is any string you like: it changes no SQL and means
nothing on its own — it exists so a query definition can declare which backend it must be read
from, and an executor that understands your vocabulary can honour it. If you have no such
executor, ignore it.

_(Backed by `docs/tenant-scoping.md > route is carried onto the compiled query`.)_

## Handwritten SQL

`rawCompiledQuery` requires `tenantScope` explicitly, since a raw string cannot be
inspected. Whatever you pass is taken at face value — which is why it also requires a
`reason` and a `justification` naming why the query isn't a builder query at all. See
[Extending](./extending.md#handwritten-queries-unsafecompiledquery).
