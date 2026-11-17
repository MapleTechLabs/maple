import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { foldObservation, type HysteresisRow } from "@maple/alerting-core/hysteresis"
import { hysteresisConfigFor } from "./hysteresis-config"

const TICK_MS = 5 * 60 * 1000

/** Healthy ticks an open incident needs before it resolves. */
const healthyTicksToResolve = (signal: "latency_p95" | "throughput", reopenCount: number): number => {
	let row: HysteresisRow = {
		consecutiveBreaches: 0,
		consecutiveHealthy: 0,
		incidentOpen: true,
		lastResolvedAtMs: null,
	}
	for (let tick = 1; tick <= 60; tick++) {
		const outcome = Effect.runSync(
			foldObservation(row, "healthy", hysteresisConfigFor(signal, reopenCount), tick * TICK_MS),
		)
		if (outcome.transition === "resolve") return tick
		row = {
			...row,
			consecutiveBreaches: outcome.consecutiveBreaches,
			consecutiveHealthy: outcome.consecutiveHealthy,
		}
	}
	return Number.POSITIVE_INFINITY
}

describe("hysteresisConfigFor", () => {
	it("holds a flapping incident open through a 15-minute dip", () => {
		expect(healthyTicksToResolve("latency_p95", 0)).toBe(3)
		expect(healthyTicksToResolve("latency_p95", 1)).toBeGreaterThan(3)
	})

	it("stops growing below the no-data sweep's hour", () => {
		for (const reopens of [2, 5, 50]) {
			expect(healthyTicksToResolve("latency_p95", reopens) * TICK_MS).toBeLessThan(60 * 60 * 1000)
		}
		expect(healthyTicksToResolve("latency_p95", 50)).toBe(healthyTicksToResolve("latency_p95", 2))
	})

	it("still resolves a recovered outage on the first healthy tick, even after reopens", () => {
		for (const reopens of [0, 1, 5]) expect(healthyTicksToResolve("throughput", reopens)).toBe(1)
	})
})
