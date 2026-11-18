import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Option } from "effect"
import { parseExportTable } from "./bigquery"
import type { GcpCostLine } from "./bigquery"
import { openDayOf } from "./GcpCostProvider"
import { resourceTypeOf, rowsOf, serviceCategoryOf } from "./normalize"

const line = (overrides: Partial<GcpCostLine> = {}): GcpCostLine => ({
	day: "2026-10-20",
	project: "acme-prod",
	service: "Cloud Run",
	sku: "CPU Allocation Time",
	region: "europe-west4",
	resource: "",
	costType: "regular",
	currency: "EUR",
	unit: "vCPU-second",
	cost: "3",
	listCost: "4",
	credits: "0",
	quantity: "100",
	...overrides,
})

describe("parseExportTable", () => {
	it("reads the project, dataset, kind of export and billing account of an export table id", () => {
		assert.deepStrictEqual(
			parseExportTable("  acme-billing:exports.gcp_billing_export_resource_v1_01ABCD_234567_89ABCD "),
			Option.some({
				ref: "acme-billing.exports.gcp_billing_export_resource_v1_01ABCD_234567_89ABCD",
				projectId: "acme-billing",
				datasetId: "exports",
				tableId: "gcp_billing_export_resource_v1_01ABCD_234567_89ABCD",
				detailed: true,
				billingAccountId: "01ABCD-234567-89ABCD",
			}),
		)
		assert.isFalse(
			Option.getOrThrow(
				parseExportTable("acme-billing.exports.gcp_billing_export_v1_01ABCD_234567_89ABCD"),
			).detailed,
		)
	})

	it("refuses anything that is not an export table, or could escape the query's quoting", () => {
		for (const input of [
			"acme-billing.exports.my_table",
			"acme-billing.exports",
			"acme-billing.ex`ports.gcp_billing_export_v1_01ABCD_234567_89ABCD",
			"acme-billing.exports.gcp_billing_export_v1_01ABCD_234567_89ABCD`; DROP",
			"Acme.exports.gcp_billing_export_v1_01ABCD_234567_89ABCD",
		]) {
			assert.isTrue(Option.isNone(parseExportTable(input)), input)
		}
	})
})

describe("rowsOf", () => {
	it("maps cost types to charge categories and keeps credits as rows of their own", () => {
		const rows = rowsOf(
			[
				line({ credits: "-1" }),
				line({ costType: "tax", sku: "", cost: "0.5", credits: "" }),
				line({ costType: "adjustment", cost: "-0.2" }),
				line({ costType: "rounding_error", cost: "0.01" }),
			],
			"2026-11-01",
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.chargeCategory, row.billedCost, row.estimated]),
			[
				["usage", 3, false],
				["credit", -1, false],
				["tax", 0.5, false],
				["adjustment", -0.19, false],
			],
		)
	})

	it("folds the credits of one SKU from several cost types into one row", () => {
		const rows = rowsOf(
			[line({ credits: "-1" }), line({ costType: "adjustment", cost: "0", credits: "-0.5" })],
			"2026-11-01",
		)
		assert.deepStrictEqual(
			Arr.map(
				Arr.filter(rows, (row) => row.chargeCategory === "credit"),
				(row) => row.billedCost,
			),
			[-1.5],
		)
	})

	it("names a chargeless region global and marks days from the open day on as estimated", () => {
		const [row] = rowsOf([line({ region: "", day: "2026-11-01" })], "2026-11-01")
		assert.strictEqual(row?.region, "global")
		assert.isTrue(row?.estimated)
	})
})

describe("openDayOf", () => {
	it("keeps the previous month open until its invoice closes on the tenth", () => {
		assert.strictEqual(openDayOf("2026-11-04"), "2026-10-01")
		assert.strictEqual(openDayOf("2026-11-10"), "2026-10-01")
		assert.strictEqual(openDayOf("2026-11-11"), "2026-11-01")
	})
})

describe("serviceCategoryOf and resourceTypeOf", () => {
	it("categorises Google services by name, Other when none matches", () => {
		assert.deepStrictEqual(
			Arr.map(["Compute Engine", "Cloud SQL", "BigQuery", "Networking", "Support"], serviceCategoryOf),
			["Compute", "Databases", "Analytics", "Networking", "Other"],
		)
	})

	it("reads the collection a full resource name points into", () => {
		assert.strictEqual(
			resourceTypeOf("//compute.googleapis.com/projects/p/zones/z/instances/123"),
			"instances",
		)
		assert.strictEqual(resourceTypeOf(""), "")
	})
})
