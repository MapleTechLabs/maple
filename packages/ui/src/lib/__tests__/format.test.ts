import { describe, expect, it } from "vitest"

import {
	axisTickFormatter,
	axisTickValues,
	bucketIntervalLabel,
	countLabel,
	EMPTY_VALUE,
	formatBucketLabel,
	formatBytes,
	formatBytesPerSecond,
	formatDuration,
	formatErrorRate,
	formatLatency,
	formatLoad,
	formatNumber,
	formatPercent,
	formatPercentColumn,
	formatRate,
	formatRatePerHour,
	formatStorageBytes,
	formatUptime,
	formatValueByUnit,
	inferBucketSeconds,
	inferRangeMs,
	parseBucketMs,
	pluralize,
} from "../format"

// This file is the contract for the consolidation: every helper below replaced
// two or more diverging copies, and each assertion pins the behaviour that won.

describe("formatDuration", () => {
	it("walks the full μs → h ladder", () => {
		expect(formatDuration(0.5)).toBe("500μs")
		expect(formatDuration(1)).toBe("1.0ms")
		expect(formatDuration(250)).toBe("250ms")
		expect(formatDuration(29.14)).toBe("29.1ms")
		expect(formatDuration(1_000)).toBe("1.00s")
		expect(formatDuration(2_240)).toBe("2.24s")
		expect(formatDuration(59_000)).toBe("59.0s")
		expect(formatDuration(41_060)).toBe("41.1s")
		expect(formatDuration(72)).toBe("72.0ms")
	})

	it("keeps going past a minute instead of stopping at seconds", () => {
		// The web copy capped here and rendered an hour as "3600.00s".
		expect(formatDuration(90_000)).toBe("1.5min")
		expect(formatDuration(3_600_000)).toBe("1.0h")
	})
})

describe("formatLatency", () => {
	it("shares the duration ladder and has a placeholder for missing values", () => {
		expect(formatLatency(90_000)).toBe("1.5min")
		expect(formatLatency(3_600_000)).toBe("1.0h")
		expect(formatLatency(Number.NaN)).toBe(EMPTY_VALUE)
	})
})

describe("formatNumber", () => {
	it("compacts at every tier", () => {
		expect(formatNumber(999)).toBe("999")
		expect(formatNumber(3_400)).toBe("3.4K")
		expect(formatNumber(1_200_000)).toBe("1.2M")
		expect(formatNumber(2_500_000_000)).toBe("2.5B")
		expect(formatNumber(1_200_000_000_000)).toBe("1.2T")
	})

	it("compacts negatives (delta columns), not just positives", () => {
		expect(formatNumber(-1_500)).toBe("-1.5K")
		expect(formatNumber(-2_500_000_000)).toBe("-2.5B")
	})

	it("keeps sub-1 values readable instead of collapsing to 0", () => {
		expect(formatNumber(0.0267)).toBe("0.0267")
		expect(formatNumber(0.08)).toBe("0.08")
		expect(formatNumber(0)).toBe("0")
	})
})

describe("byte formatting", () => {
	it("keeps the binary and decimal bases distinct", () => {
		expect(formatBytes(1_024)).toBe("1.0 KB")
		expect(formatStorageBytes(1_000)).toBe("1.0 KB")

		// The single assertion that makes the two impossible to conflate.
		// (Both drop the decimal above 100, hence "977 KB" rather than "976.6 KB".)
		expect(formatBytes(1_000_000)).toBe("977 KB")
		expect(formatStorageBytes(1_000_000)).toBe("1.0 MB")
	})

	it("keeps the sign of a negative binary size and floors storage at zero", () => {
		expect(formatBytes(0)).toBe("0 B")
		expect(formatBytes(-4096)).toBe("-4.0 KB")
		expect(formatBytes(Number.NaN)).toBe(EMPTY_VALUE)
		expect(formatStorageBytes(-5)).toBe("0 B")
	})

	it("formats throughput on the binary base", () => {
		expect(formatBytesPerSecond(0)).toBe("0 B/s")
		expect(formatBytesPerSecond(2_048)).toBe("2.0 KB/s")
	})

	it("keeps `bytes`-unit widgets on the decimal base", () => {
		// Saved dashboards render through here; flipping this to 1024 would
		// silently rewrite existing widgets.
		expect(formatValueByUnit(1_000_000, "bytes")).toBe("1.0 MB")
	})
})

describe("percent formatters stay separate", () => {
	it("formatPercent never rounds a tiny non-zero share to 0%", () => {
		expect(formatPercent(0)).toBe("0%")
		expect(formatPercent(0.0001)).toBe("0.01%")
		expect(formatPercent(0.000_000_3)).toBe("<0.01%")
		expect(formatPercent(0.052)).toBe("5.2%")
		expect(formatPercent(0.06)).toBe("6.0%")
		expect(formatPercent(0.87)).toBe("87%")
		expect(formatPercent(Number.NaN)).toBe(EMPTY_VALUE)
	})

	it("formatPercent with a floor marks a tiny non-zero share", () => {
		expect(formatPercent(0.0004, { floor: 0.001 })).toBe("<0.1%")
		expect(formatPercent(0, { floor: 0.001 })).toBe("0%")
		expect(formatPercent(0.052, { floor: 0.001 })).toBe("5.2%")
	})

	it("formatPercentColumn and formatErrorRate share one precision rule for a column", () => {
		expect([0.88, 0.34, 0.01, 0, 1].map(formatPercentColumn)).toEqual([
			"88.0%",
			"34.0%",
			"1.0%",
			"0%",
			"100%",
		])
		expect([0.255, 0.0016, 0].map((value) => formatErrorRate(value))).toEqual(["25.5%", "0.16%", "0%"])
	})

	it("formatErrorRate surfaces a rare failure instead of showing 0%", () => {
		expect(formatErrorRate(0)).toBe("0%")
		expect(formatErrorRate(0.00005)).toBe("<0.01%")
		expect(formatErrorRate(0.0008)).toBe("0.08%")
		expect(formatErrorRate(0.0016)).toBe("0.16%")
		expect(formatErrorRate(0.087)).toBe("8.7%")
	})
})

describe("formatLoad / formatUptime", () => {
	it("renders load and uptime", () => {
		expect(formatLoad(1.234)).toBe("1.23")
		expect(formatLoad(Number.NaN)).toBe(EMPTY_VALUE)
		expect(formatUptime(0)).toBe(EMPTY_VALUE)
		expect(formatUptime(30 * 60)).toBe("30m")
		expect(formatUptime(5 * 3600)).toBe("5h")
		expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe("3d 4h")
	})
})

describe("value-by-unit dispatch", () => {
	it("routes each unit to its formatter", () => {
		expect(formatValueByUnit(0.5, "percent")).toBe("50.0%")
		expect(formatValueByUnit(90_000, "duration_ms")).toBe("1.5min")
		expect(formatValueByUnit(90_000_000, "duration_us")).toBe("1.5min")
		expect(formatValueByUnit(90, "duration_s")).toBe("1.5min")
		expect(formatValueByUnit(1_500, "requests_per_sec")).toBe("1.5K/s")
		expect(formatValueByUnit(3_400, undefined)).toBe("3.4K")
	})
})

describe("bucket helpers normalize warehouse timestamps", () => {
	// ClickHouse buckets arrive tz-less. Parsing them raw made every chart's axis
	// labels — and the trailing "incomplete bucket" marker — shift by the
	// browser's UTC offset. These assertions fail under a non-UTC TZ if the
	// normalization is dropped.
	it("parseBucketMs reads a tz-less bucket as UTC", () => {
		expect(parseBucketMs("2026-05-24 14:30:00")).toBe(Date.parse("2026-05-24T14:30:00Z"))
		expect(parseBucketMs(42)).toBeNull()
	})

	it("formatBucketLabel labels a tz-less bucket at its UTC instant", () => {
		const context = { rangeMs: 60 * 60 * 1000, bucketSeconds: 300 }
		const tzLess = formatBucketLabel("2026-05-24 14:30:00", context, "tick")
		const explicit = formatBucketLabel("2026-05-24T14:30:00Z", context, "tick")
		expect(tzLess).toBe(explicit)
	})

	it("infers spacing and range from tz-less buckets", () => {
		const data = [{ bucket: "2026-05-24 14:00:00" }, { bucket: "2026-05-24 14:05:00" }]
		expect(inferBucketSeconds(data)).toBe(300)
		expect(inferRangeMs(data)).toBe(5 * 60 * 1000)
	})

	it("maps bucket seconds to a rate suffix", () => {
		expect(bucketIntervalLabel(60)).toBe("/min")
		expect(bucketIntervalLabel(86_400)).toBe("/d")
		expect(bucketIntervalLabel(7)).toBe("")
		expect(bucketIntervalLabel(undefined)).toBe("")
	})
})

describe("pluralize / countLabel", () => {
	it("picks the noun form from the count", () => {
		expect(pluralize(1, "host")).toBe("host")
		expect(pluralize(0, "host")).toBe("hosts")
		expect(pluralize(2, "query", "queries")).toBe("queries")
		expect(countLabel(1200, "span")).toBe("1,200 spans")
	})
})

describe("formatRatePerHour", () => {
	it("switches to the unit a reader can picture", () => {
		expect(formatRatePerHour(12.4)).toBe("12× an hour")
		expect(formatRatePerHour(2.34)).toBe("2.3× an hour")
		expect(formatRatePerHour(0.5)).toBe("12× a day")
		expect(formatRatePerHour(0.01)).toBe("1.7× a week")
	})
})

describe("formatRate", () => {
	it("reads at the precision a rate is compared at", () => {
		expect(formatRate(0)).toBe("0")
		expect(formatRate(0.0123)).toBe("0.012")
		expect(formatRate(12.3456)).toBe("12.3")
		expect(formatRate(123.4)).toBe("123")
		expect(formatRate(1234)).toBe("1.2K")
	})
})

describe("worst-case inputs", () => {
	it("formatDuration keeps sign, rolls up at rounding edges, reaches days and guards NaN", () => {
		expect(formatDuration(-42.5)).toBe("-42.5ms")
		expect(formatDuration(0.000001)).toBe("1ns")
		expect(formatDuration(0)).toBe("0μs")
		expect(formatDuration(999.96)).toBe("1.00s")
		expect(formatDuration(59_999)).toBe("1.0min")
		expect(formatDuration(259_200_000)).toBe("3.0d")
		expect(formatDuration(Number.NaN)).toBe("—")
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—")
	})

	it("formatNumber does not print InfinityT", () => {
		expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("—")
		expect(formatNumber(Number.NaN)).toBe("—")
	})

	it("byte formatters reach PB", () => {
		expect(formatStorageBytes(5e15)).toBe("5.0 PB")
		expect(formatBytes(5 * 1024 ** 5)).toBe("5.0 PB")
	})

	it("formatUptime has a sub-minute and a years tier", () => {
		expect(formatUptime(4)).toBe("<1m")
		expect(formatUptime(3 * 365 * 86_400)).toBe("3y 0d")
	})

	it("formatErrorRate guards non-finite input", () => {
		expect(formatErrorRate(Number.NaN)).toBe(EMPTY_VALUE)
	})
})

describe("axisTickFormatter", () => {
	it("prints every duration tick in the largest tick's unit at one precision", () => {
		const format = axisTickFormatter("duration_ms", [0, 1_600])
		expect([0, 500, 1_500].map(format)).toEqual(["0", "0.5s", "1.5s"])
	})

	it("reads in milliseconds while the largest tick is under 1s, then in seconds", () => {
		const under = [0, 800] as const
		const underLabels = axisTickValues(under, 3).map(axisTickFormatter("duration_ms", under, 3))
		expect(underLabels.every((label) => label === "0" || label.endsWith("ms"))).toBe(true)
		const over = [0, 1_200] as const
		expect(axisTickValues(over, 3).map(axisTickFormatter("duration_ms", over, 3))).toEqual([
			"0",
			"0.5s",
			"1.0s",
		])
	})

	it("prints whole-second steps without a decimal", () => {
		const format = axisTickFormatter("duration_ms", [0, 4_000])
		expect([0, 1_000, 2_000].map(format)).toEqual(["0", "1s", "2s"])
	})

	it("keeps small duration axes in milliseconds with a unitless zero", () => {
		const format = axisTickFormatter("duration_ms", [0, 400])
		expect([0, 100, 400].map(format)).toEqual(["0", "100ms", "400ms"])
	})

	it("drops decimals a percent axis does not need", () => {
		const format = axisTickFormatter("percent", [0, 1])
		expect([0, 0.2, 0.8].map(format)).toEqual(["0", "20%", "80%"])
	})

	it("adds decimals when the percent step needs them", () => {
		const format = axisTickFormatter("percent", [0, 0.01])
		expect([0, 0.002, 0.01].map(format)).toEqual(["0", "0.2%", "1.0%"])
	})
})

describe("axisTickValues", () => {
	it("steps evenly inside the domain and labels a 1s step without decimals", () => {
		const domain = [0, 2_200] as const
		expect(axisTickValues(domain, 3)).toEqual([0, 1_000, 2_000])
		expect(axisTickValues(domain, 3).map(axisTickFormatter("duration_ms", domain, 3))).toEqual([
			"0",
			"1s",
			"2s",
		])
	})

	it("does not drift on fractional steps", () => {
		expect(axisTickValues([0, 0.3], 3)).toEqual([0, 0.1, 0.2, 0.3])
	})
})
