import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Schema } from "effect"
import { ExternalDataSourceId, type CatalogEntryView } from "@maple/domain/data-sources"
import { searchCatalogs, type SearchableSource } from "./search"

const entry = (name: string, fields: CatalogEntryView["fields"], extra: Partial<CatalogEntryView> = {}) =>
	({ name, kind: "table", fields, exposed: true, ...extra }) satisfies CatalogEntryView

let nextId = 0

const source = (
	name: string,
	environment: SearchableSource["environment"],
	entries: ReadonlyArray<CatalogEntryView>,
	description = "",
): SearchableSource => ({
	id: Schema.decodeSync(ExternalDataSourceId)(
		`00000000-0000-4000-8000-00000000000${(nextId = (nextId + 1) % 10)}`,
	),
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
		expect(Arr.map(hits, (hit) => hit.source)).toEqual(["shop-prod", "shop-staging"])
		expect(hits[0]?.matchedFields).toContain("status")
	})

	it("ranks a table named for the words above a longer name that contains them", () => {
		const invoices = entry("billing.invoices", [
			{ name: "amount_cents", type: "number", note: "Invoice total" },
		])
		const archive = entry("legacy.invoices_archive_2019", [{ name: "invoice_no", type: "string" }])
		const hits = searchCatalogs(
			[
				source("warehouse-legacy", "production", [archive]),
				source("billing", "production", [invoices]),
			],
			"invoices",
		)
		expect(Arr.map(hits, (hit) => hit.entry)).toEqual([
			"billing.invoices",
			"legacy.invoices_archive_2019",
		])
	})

	it("follows an environment the question names", () => {
		const hits = searchCatalogs(
			[source("shop-prod", "production", [payments]), source("shop-staging", "staging", [payments])],
			"payments in staging",
		)
		expect(hits[0]?.source).toBe("shop-staging")
	})

	it("finds a resource by a field name when the entry name does not match", () => {
		const users = entry(
			"users",
			[{ name: "created_at", type: "timestamp", note: "Signup time: when the user was created" }],
			{
				kind: "resource",
			},
		)
		const hits = searchCatalogs(
			[source("clerk-prod", "production", [users]), source("shop-prod", "production", [payments])],
			"signups",
		)
		expect(Arr.map(hits, (hit) => `${hit.source}.${hit.entry}`)).toEqual(["clerk-prod.users"])
	})

	it("lists a source's entries when the question names the source", () => {
		const users = entry("users", [{ name: "id", type: "string" }], { kind: "resource" })
		const hits = searchCatalogs(
			[source("clerk-prod", "production", [users]), source("shop-prod", "production", [payments])],
			"clerk-prod",
		)
		expect(Arr.map(hits, (hit) => `${hit.source}.${hit.entry}`)).toEqual(["clerk-prod.users"])
	})

	it("never returns entries an admin hid", () => {
		const hidden = { ...payments, exposed: false }
		expect(searchCatalogs([source("shop-prod", "production", [hidden])], "payments")).toEqual([])
	})

	it("returns nothing for a question made only of filler words", () => {
		expect(searchCatalogs([source("shop-prod", "production", [payments])], "show me the data")).toEqual(
			[],
		)
	})

	it("caps the number of hits", () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			entry(`shop.orders_${i}`, [{ name: "id", type: "string" }]),
		)
		expect(searchCatalogs([source("shop-prod", "production", many)], "orders", 5)).toHaveLength(5)
	})
})
