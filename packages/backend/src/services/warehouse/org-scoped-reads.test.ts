import { Array as Arr, Effect, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { isDatasourceDefinition } from "@maple-dev/effect-orm/tinybird"
import * as Datasources from "@maple/domain/tinybird"
import { collectQueryCatalog } from "@maple/query-engine/benchmark"
import { listTrustedReadDatasourceNames } from "./warehouse-catalog"

// Every single-tenant read runs on an org-scoped token, which carries only datasources with an
// OrgId column. A tenant read that names any other datasource would be refused by Tinybird.

const everyDatasourceName = Arr.map(
	Arr.filter(Rec.values(Datasources), isDatasourceDefinition),
	(datasource) => datasource._name,
)
const trusted = new Set(listTrustedReadDatasourceNames())
const outsideToken = Arr.filter(everyDatasourceName, (name) => !trusted.has(name))

/** The datasources a statement names, matched the way the token service picks its scopes. */
const named = (sql: string, names: ReadonlyArray<string>) =>
	Arr.filter(names, (name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(sql))

describe("org-scoped reads cover every tenant query", () => {
	const tenantReads = Arr.filter(
		Effect.runSync(collectQueryCatalog),
		(entry) => entry.compiled?.tenantScope === "single-tenant",
	)

	it("compiles a meaningful set of single-tenant reads", () => {
		expect(tenantReads.length).toBeGreaterThan(100)
	})

	it("names no datasource the org-scoped token leaves out", () => {
		const refused = Arr.flatMap(tenantReads, (entry) =>
			Arr.map(named(entry.sql, outsideToken), (name) => `${entry.source}:${entry.name} reads ${name}`),
		)
		expect(refused).toEqual([])
	})
})
