import { describe, expect, it } from "vitest"
import { WarehouseConfigError, WarehouseQueryError, WarehouseSchemaDriftError } from "@maple/domain/http"
import { isMissingServiceApiColumns, isMissingServiceEndpointDetails } from "./missing-table"

const drift = (message: string) =>
	new WarehouseSchemaDriftError({
		message,
		pipeName: "serviceApiTotals",
		clickhouseType: "UNKNOWN_IDENTIFIER",
	})

describe("migration 0048 degrade detectors", () => {
	it("falls back when a cluster's rollups predate the HTTP columns", () => {
		expect(
			isMissingServiceApiColumns(
				drift("Unknown expression identifier `Http4xxCount` in scope SELECT ..."),
			),
		).toBe(true)
	})

	it("surfaces every other schema drift and failure", () => {
		expect(isMissingServiceApiColumns(drift("Unknown expression identifier `CommitSha`"))).toBe(false)
		expect(
			isMissingServiceApiColumns(
				new WarehouseQueryError({ message: "Http4xxCount overflowed", pipeName: "serviceApiTotals" }),
			),
		).toBe(false)
	})

	it("recognizes only a missing endpoint details table", () => {
		const missing = (table: string) =>
			new WarehouseConfigError({
				message: `Could not find table: ${table}`,
				pipeName: "serviceEndpointDetail",
				clickhouseType: "UNKNOWN_TABLE",
			})
		expect(isMissingServiceEndpointDetails(missing("service_endpoint_details_hourly"))).toBe(true)
		expect(isMissingServiceEndpointDetails(drift("service_endpoint_details_hourly"))).toBe(false)
	})
})
