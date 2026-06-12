import { describe, expect, it } from "vitest"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { deviation } from "./anomaly-format"

const incident = (
	overrides: Partial<
		Pick<AnomalyIncidentDocument, "signalType" | "lastObservedValue" | "baselineMedian" | "baselineSigma">
	>,
) => ({
	signalType: "error_rate" as AnomalyIncidentDocument["signalType"],
	lastObservedValue: 0,
	baselineMedian: 0,
	baselineSigma: 0,
	...overrides,
})

describe("deviation", () => {
	it("labels throughput as a percent of baseline", () => {
		const full = deviation(
			incident({ signalType: "throughput", lastObservedValue: 0, baselineMedian: 1.2, baselineSigma: 1 }),
		)
		expect(full.kind).toBe("percent")
		expect(full.label).toBe("−100%")

		const partial = deviation(
			incident({ signalType: "throughput", lastObservedValue: 8.5, baselineMedian: 49.7, baselineSigma: 70 }),
		)
		expect(partial.label).toBe("−83%")
	})

	it("falls back to σ for throughput with no baseline", () => {
		const dev = deviation(
			incident({ signalType: "throughput", lastObservedValue: 0, baselineMedian: 0, baselineSigma: 0 }),
		)
		expect(dev.label).toBe("new signal")
	})

	it("keeps σ labels in the readable range", () => {
		const dev = deviation(
			incident({ lastObservedValue: 0.05, baselineMedian: 0.008, baselineSigma: 0.01 }),
		)
		expect(dev.kind).toBe("sigma")
		expect(dev.label).toBe("+4.2σ")
	})

	it("switches to a ratio past the σ readability limit", () => {
		// The "+99.4σ" production case: log volume 332.9/min vs 2.6/min baseline.
		const dev = deviation(
			incident({
				signalType: "log_volume",
				lastObservedValue: 332.9,
				baselineMedian: 2.6,
				baselineSigma: 3.32,
			}),
		)
		expect(dev.kind).toBe("ratio")
		expect(dev.label).toBe("128× baseline")
	})

	it("caps absurd ratios", () => {
		const dev = deviation(
			incident({ lastObservedValue: 100_000, baselineMedian: 1, baselineSigma: 1 }),
		)
		expect(dev.label).toBe("999× baseline")
	})

	it("labels brand-new signals", () => {
		const dev = deviation(incident({ lastObservedValue: 50 }))
		expect(dev.kind).toBe("new")
		expect(dev.label).toBe("new signal")
	})
})
