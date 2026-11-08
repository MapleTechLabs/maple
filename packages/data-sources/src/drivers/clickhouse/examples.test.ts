import { describe, expect, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import type { CatalogEntry } from "@maple/domain/data-sources"
import { catalogExamples } from "./examples"
import { piiFieldNames, piiIssue } from "./run"

const payments: CatalogEntry = {
	name: "shop.payments",
	kind: "table",
	rowEstimate: 500,
	timeField: "created_at",
	fields: [
		{ name: "created_at", type: "timestamp" },
		{ name: "status", type: "string", sampleValues: ["paid", "failed"] },
		{ name: "email", type: "string", pii: true, sampleValues: ["a@x"] },
		{ name: "amount", type: "number" },
	],
}

describe("catalogExamples", () => {
	it("writes examples the driver accepts on a source with personal data", () => {
		const examples = catalogExamples([payments])
		const pii = piiFieldNames({ entries: [payments], examples: [], truncated: false })
		expect(Arr.map(examples, (e) => e.title)).toEqual([
			"Rows over time in shop.payments",
			"Rows by status in shop.payments",
			"Latest rows in shop.payments",
		])
		const issues = Arr.map(examples, (e) =>
			e.query._tag === "sql" ? piiIssue(e.query.sql, pii) : "not sql",
		)
		expect(issues).toEqual([null, null, null])
	})
})
