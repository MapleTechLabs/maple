import { describe, expect, it } from "vitest"
import type { CatalogEntryView, ExternalDataSourceId } from "@maple/domain/data-sources"
import { searchCatalogs, type SearchableSource } from "./search"

const entry = (name: string, fields: CatalogEntryView["fields"], extra: Partial<CatalogEntryView> = {}) =>
	({ name, kind: "table", fields, exposed: true, ...extra }) satisfies CatalogEntryView

const source = (
	name: string,
	environment: SearchableSource["environment"],
	entries: ReadonlyArray<CatalogEntryView>,
	description = "",
): SearchableSource => ({
	id: `00000000-0000-4000-8000-${name.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "0")}` as ExternalDataSourceId,
	name,
	description,
	environment,
	tags: [],
	queryLanguage: "sql:clickhouse",
	entries,
})

const payments = entry("shop.payments", [
	{ name: "id", type: "string" },
	{ name: "status", type: "string", sampleValues: ["paid", "refunded", "failed"] },
	{ name: "amount", type: "number", note: "in cents" },
])

describe("searchCatalogs", () => {
	it("ranks the production copy above an identical staging copy", () => {
		const hits = searchCatalogs(
			[source("shop-staging", "staging", [payments]), source("shop-prod", "production", [payments])],
			"failed payments",
		)
		expect(hits.map((hit) => hit.source)).toEqual(["shop-prod", "shop-staging"])
		expect(hits[0]?.matchedFields).toContain("status")
	})

	it("follows an environment the question names", () => {
		const hits = searchCatalogs(
			[source("shop-prod", "production", [payments]), source("shop-staging", "staging", [payments])],
			"payments in staging",
		)
		expect(hits[0]?.source).toBe("shop-staging")
	})

	it("finds a resource by a field name when the entry name does not match", () => {
		const users = entry("users", [{ name: "created_at", type: "timestamp", note: "Signup time: when the user was created" }], {
			kind: "resource",
		})
		const hits = searchCatalogs([source("clerk-prod", "production", [users]), source("shop-prod", "production", [payments])], "signups")
		expect(hits.map((hit) => `${hit.source}.${hit.entry}`)).toEqual(["clerk-prod.users"])
	})

	it("never returns entries an admin hid", () => {
		const hidden = { ...payments, exposed: false }
		expect(searchCatalogs([source("shop-prod", "production", [hidden])], "payments")).toEqual([])
	})

	it("returns nothing for a question made only of filler words", () => {
		expect(searchCatalogs([source("shop-prod", "production", [payments])], "show me the data")).toEqual([])
	})

	it("caps the number of hits", () => {
		const many = Array.from({ length: 30 }, (_, i) => entry(`shop.orders_${i}`, [{ name: "id", type: "string" }]))
		expect(searchCatalogs([source("shop-prod", "production", many)], "orders", 5)).toHaveLength(5)
	})
})
