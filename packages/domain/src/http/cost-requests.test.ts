import { Option, Schema, Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { CostBreakdownRequest, CostTimeseriesRequest, CostTotalsRequest } from "./query-engine"

const WINDOW = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-30 00:00:00" }

const decoders = {
	totals: Schema.decodeUnknownOption(CostTotalsRequest),
	timeseries: Schema.decodeUnknownOption(CostTimeseriesRequest),
	breakdown: Schema.decodeUnknownOption(CostBreakdownRequest),
}

/** Whether the request decodes: a refusal here is the endpoint's 400. */
const accepts = (request: keyof typeof decoders, input: unknown) => Option.isSome(decoders[request](input))

const values = (count: number) => Arr.makeBy(count, (index) => `value-${index}`)

describe("cost request filters", () => {
	it("accepts up to 50 values of up to 300 characters per dimension", () => {
		expect(
			accepts("totals", {
				...WINDOW,
				metric: "effective",
				filters: { region: values(50), resource: [Str.repeat(300)("a")], service: [] },
			}),
		).toBe(true)
		expect(accepts("totals", WINDOW)).toBe(true)
	})

	it("rejects a dimension with more than 50 values", () => {
		expect(accepts("totals", { ...WINDOW, filters: { region: values(51) } })).toBe(false)
	})

	it("rejects a value longer than 300 characters", () => {
		expect(accepts("totals", { ...WINDOW, filters: { resource: [Str.repeat(301)("a")] } })).toBe(false)
	})

	it("rejects a bound that matches the format but is not a real date or time", () => {
		expect(accepts("totals", { ...WINDOW, startTime: "2026-13-01 00:00:00" })).toBe(false)
		// It would read March 2nd, not the day asked for.
		expect(accepts("timeseries", { ...WINDOW, startTime: "2026-02-30 00:00:00" })).toBe(false)
		expect(accepts("breakdown", { ...WINDOW, groupBy: "region", endTime: "2026-10-30 24:00:00" })).toBe(
			false,
		)
		expect(accepts("totals", { ...WINDOW, endTime: "2028-02-29 23:59:59.999" })).toBe(true)
	})

	it("rejects a metric or a time the query cannot bind", () => {
		expect(accepts("totals", { ...WINDOW, metric: "list" })).toBe(false)
		expect(accepts("totals", { ...WINDOW, startTime: "2026-10-01" })).toBe(false)
	})
})

describe("cost request currency", () => {
	it("takes a three-letter uppercase code on every read, and nothing else", () => {
		expect(accepts("totals", { ...WINDOW, currency: "EUR" })).toBe(true)
		expect(accepts("timeseries", { ...WINDOW, currency: "USD" })).toBe(true)
		expect(accepts("breakdown", { ...WINDOW, groupBy: "region", currency: "JPY" })).toBe(true)
		expect(accepts("totals", { ...WINDOW, currency: "eur" })).toBe(false)
		expect(accepts("timeseries", { ...WINDOW, currency: "EURO" })).toBe(false)
		expect(accepts("breakdown", { ...WINDOW, groupBy: "region", currency: "$" })).toBe(false)
		expect(accepts("totals", { ...WINDOW, currency: "" })).toBe(false)
		// A quote must not reach the query, which inlines the value.
		expect(accepts("totals", { ...WINDOW, currency: "U'D" })).toBe(false)
		expect(accepts("totals", { ...WINDOW, currency: "EUR\n" })).toBe(false)
	})
})

describe("cost request limits", () => {
	it("keeps a split timeseries between 1 and 20 series", () => {
		const request = { ...WINDOW, groupBy: "cloud_service" }
		expect(accepts("timeseries", { ...request, limit: 1 })).toBe(true)
		expect(accepts("timeseries", { ...request, limit: 20 })).toBe(true)
		expect(accepts("timeseries", { ...request, limit: 0 })).toBe(false)
		expect(accepts("timeseries", { ...request, limit: 21 })).toBe(false)
		expect(accepts("timeseries", { ...request, limit: 2.5 })).toBe(false)
		expect(accepts("timeseries", { ...WINDOW, groupBy: "tag" })).toBe(false)
	})

	it("keeps a breakdown between 1 and 200 rows and requires its dimension", () => {
		const request = { ...WINDOW, groupBy: "region" }
		expect(accepts("breakdown", { ...request, sortBy: "change", limit: 200 })).toBe(true)
		expect(accepts("breakdown", { ...request, limit: 201 })).toBe(false)
		expect(accepts("breakdown", { ...request, limit: 0 })).toBe(false)
		expect(accepts("breakdown", { ...request, sortBy: "key" })).toBe(false)
		expect(accepts("breakdown", WINDOW)).toBe(false)
	})
})
