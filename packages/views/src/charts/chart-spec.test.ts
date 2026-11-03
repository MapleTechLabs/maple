import { describe, expect, test } from "vitest"
import { ChartSpec, decodeChartSpec, encodeChartSpec, specCache } from "./chart-spec"

type Row = Readonly<Record<string, string | number>>

/** Rows whose `value` counts its reads, so a test can tell a fresh build and encode from a cached one. */
const countedRows = (count: number) => {
	const reads = { total: 0 }
	const rows: ReadonlyArray<Row> = Array.from({ length: count }, (_, index) => ({
		bucket: `2026-10-01 12:0${index}:00`,
		get value() {
			reads.total += 1
			return index
		},
	}))
	return { rows, reads }
}

const areaSpec = specCache((data: ReadonlyArray<Row>, rest: { readonly hidden: ReadonlyArray<string> }) =>
	ChartSpec.QueryBuilderArea({
		data,
		colors: { s1: "#000" },
		hidden: rest.hidden,
		fallbackColor: "#888",
		chrome: { border: "#ddd", background: "#fff" },
		unit: null,
		timeZone: "UTC",
		nowMs: 0,
		containerWidth: 400,
		gradientPrefix: "qbArea-test",
		showTooltip: true,
	}),
)

const hiddenOf = (encoded: string) => {
	const decoded = decodeChartSpec(encoded)
	return decoded._tag === "Some" && decoded.value._tag === "QueryBuilderArea" ? decoded.value.hidden : null
}

describe("chart spec caching", () => {
	test("a chart rebuilt over the same rows gets the same encoding without reading the rows again", () => {
		const { rows, reads } = countedRows(5)
		const first = encodeChartSpec(areaSpec(rows, { hidden: [] }))
		const afterFirst = reads.total
		expect(afterFirst).toBeGreaterThan(0)
		expect(encodeChartSpec(areaSpec(rows, { hidden: [] }))).toBe(first)
		expect(reads.total).toBe(afterFirst)
	})

	test("a change outside the rows builds and encodes again, carrying the change", () => {
		const { rows } = countedRows(3)
		expect(hiddenOf(encodeChartSpec(areaSpec(rows, { hidden: [] })))).toEqual([])
		expect(hiddenOf(encodeChartSpec(areaSpec(rows, { hidden: ["s1"] })))).toEqual(["s1"])
	})
})
