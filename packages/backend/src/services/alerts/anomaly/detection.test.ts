import { describe, expect, it } from "vitest"
import {
	capBusiestLogSeries,
	blendGoldenHours,
	errorSpikeBaselineKey,
	evaluateErrorSpike,
	excludeMaintenanceHours,
	isBaselineHourExcluded,
	evaluateGoldenSignals,
	evaluateLogVolume,
	goldenWindowFromHours,
	healthyErrorSpikeRecovery,
	isNonProductionEnvironment,
	isWatchedEnvironment,
	mad,
	median,
	rekeyedErrorSpikeBaselines,
	robustSigma,
	SENSITIVITY,
	windowBaseline,
	type BaselineExclusion,
	type GoldenSignalSeries,
} from "./detection"
import { Option, Array as Arr } from "effect"

const normalConfig = { sensitivity: SENSITIVITY.normal }

const goldenBaseline = (overrides?: Partial<{ requestCount: number; errorCount: number; p95Ms: number }>) =>
	Array.from({ length: 21 }, () => ({
		requestCount: 6000,
		errorCount: 60, // 1% error rate
		p95Ms: 200,
		...overrides,
	}))

const goldenSeries = (
	current: GoldenSignalSeries["current"],
	baseline = goldenBaseline(),
	sameTime: GoldenSignalSeries["sameTime"] = [],
): GoldenSignalSeries => ({
	serviceName: "api",
	deploymentEnv: "production",
	current,
	baseline,
	sameTime,
})

const byKey = (evaluations: ReturnType<typeof evaluateGoldenSignals>, signal: string) => {
	const found = Option.getOrUndefined(Arr.findFirst(evaluations, (e) => e.signalType === signal))
	if (!found) throw new Error(`missing evaluation for ${signal}`)
	return found
}

describe("median/mad/robustSigma", () => {
	it("computes the median of odd and even sets", () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([4, 1, 2, 3])).toBe(2.5)
		expect(median([])).toBe(0)
	})

	it("computes MAD around the median", () => {
		expect(mad([1, 1, 2, 2, 4, 6, 9], 2)).toBe(1)
	})

	it("floors sigma for constant series", () => {
		// MAD = 0 → sigma must come from the floors, not collapse to 0.
		expect(robustSigma([5, 5, 5, 5], 5, 0.1, 0.05)).toBeCloseTo(0.25)
		expect(robustSigma([5, 5, 5, 5], 5, 0.5, 0.05)).toBeCloseTo(0.5)
	})
})

describe("evaluateGoldenSignals — error rate", () => {
	it("breaches on a 10x error-rate spike", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 300, p95Ms: 200 }), // 10%
			normalConfig,
		)
		const e = byKey(evals, "error_rate")
		expect(e.status).toBe("breached")
		// Critical needs an absolute floor too (m + 0.10 = 11%); 10% stays warning.
		expect(e.severity).toBe("warning")
		expect(e.detectorKey).toBe("error_rate:production:api")
	})

	it("flags critical past the absolute severity floor", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 450, p95Ms: 200 }), // 15%
			normalConfig,
		)
		const e = byKey(evals, "error_rate")
		expect(e.status).toBe("breached")
		expect(e.severity).toBe("critical")
	})

	it("skips under the volume floor even with a huge rate", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 20, errorCount: 18, p95Ms: 200 }),
			normalConfig,
		)
		expect(byKey(evals, "error_rate").status).toBe("skipped")
	})

	it("stays healthy on a tiny uptick over a constant baseline (sigma floor)", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 45, p95Ms: 200 }), // 1.5% vs 1%
			normalConfig,
		)
		expect(byKey(evals, "error_rate").status).toBe("healthy")
	})

	it("needs five errors in the window, not only a rate", () => {
		const errorFree = goldenBaseline({ errorCount: 0 })
		const four = evaluateGoldenSignals(
			goldenSeries({ requestCount: 80, errorCount: 4, p95Ms: 200 }, errorFree),
			normalConfig,
		)
		const five = evaluateGoldenSignals(
			goldenSeries({ requestCount: 80, errorCount: 5, p95Ms: 200 }, errorFree),
			normalConfig,
		)
		expect(byKey(four, "error_rate").status).toBe("healthy")
		expect(byKey(five, "error_rate").status).toBe("breached")
	})

	it("skips when the baseline has too few samples", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 300, p95Ms: 200 }, goldenBaseline().slice(0, 4)),
			normalConfig,
		)
		expect(byKey(evals, "error_rate").status).toBe("skipped")
	})
})

describe("evaluateGoldenSignals — p95 latency", () => {
	it("is robust to one outlier hour in the baseline", () => {
		const baseline = goldenBaseline()
		baseline[3] = { ...baseline[3], p95Ms: 5000 } // single bad hour
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 220 }, baseline),
			normalConfig,
		)
		expect(byKey(evals, "latency_p95").status).toBe("healthy")
	})

	it("breaches on a sustained 2x p95 regression", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 450 }),
			normalConfig,
		)
		const e = byKey(evals, "latency_p95")
		expect(e.status).toBe("breached")
		expect(e.severity).toBe("warning")
	})

	it("flags critical at 4x baseline", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 900 }),
			normalConfig,
		)
		expect(byKey(evals, "latency_p95").severity).toBe("critical")
	})

	it("ignores a rise under 100ms however large the ratio", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3000, errorCount: 30, p95Ms: 110 }, goldenBaseline({ p95Ms: 20 })),
			normalConfig,
		)
		expect(byKey(evals, "latency_p95").status).toBe("healthy")
	})

	it("keeps a 4x rise under 500ms at warning", () => {
		const e = byKey(
			evaluateGoldenSignals(
				goldenSeries(
					{ requestCount: 3000, errorCount: 30, p95Ms: 300 },
					goldenBaseline({ p95Ms: 50 }),
				),
				normalConfig,
			),
			"latency_p95",
		)
		expect(e.status).toBe("breached")
		expect(e.severity).toBe("warning")
	})

	it("does not flag a spike this time of day shows on most previous days", () => {
		// A daily job: slow at this time on 6 of 7 days, while the ±1h windows are normal.
		const dailyJob = [
			...Array.from({ length: 6 }, () => ({ requestCount: 6000, errorCount: 60, p95Ms: 900 })),
			...goldenBaseline().slice(0, 1),
		]
		const current = { requestCount: 3000, errorCount: 30, p95Ms: 900 }
		expect(
			byKey(
				evaluateGoldenSignals(goldenSeries(current, goldenBaseline(), dailyJob), normalConfig),
				"latency_p95",
			).status,
		).toBe("healthy")
		expect(
			byKey(evaluateGoldenSignals(goldenSeries(current, goldenBaseline()), normalConfig), "latency_p95")
				.status,
		).toBe("breached")
	})
})

describe("evaluateGoldenSignals — throughput", () => {
	it("stays healthy on a large but non-outage traffic reduction", () => {
		// Baseline 6000/h = 100/min; current 1800 over the hour = 30/min.
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 1800, errorCount: 18, p95Ms: 200 }),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("keeps services under one request a minute healthy", () => {
		for (const perHour of [24, 30, 50]) {
			const evals = evaluateGoldenSignals(
				goldenSeries(
					{ requestCount: 0, errorCount: 0, p95Ms: 0 },
					goldenBaseline({ requestCount: perHour, errorCount: 0 }),
				),
				normalConfig,
			)
			expect(byKey(evals, "throughput").status).toBe("healthy")
		}
	})

	it("does not treat an intermittent baseline as an always-on service", () => {
		const intermittent = goldenBaseline().slice(0, 7)
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 0, errorCount: 0, p95Ms: 0 }, intermittent),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	// Rates 5/10/40 per minute exercise a highly variable but well-covered
	// baseline. Even here, only a near-total outage should affect health.
	const highVarianceBaseline = [
		...Array.from({ length: 7 }, () => ({ requestCount: 300, errorCount: 0, p95Ms: 200 })),
		...Array.from({ length: 7 }, () => ({ requestCount: 600, errorCount: 0, p95Ms: 200 })),
		...Array.from({ length: 7 }, () => ({ requestCount: 2400, errorCount: 0, p95Ms: 200 })),
	]

	it("stays healthy when a variable service still has meaningful traffic", () => {
		// 50 requests in the hour = 0.83/min, above the 5% outage threshold of
		// 0.5/min. This is quieter than usual, but it is not an outage.
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 50, errorCount: 0, p95Ms: 200 }, highVarianceBaseline),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("healthy")
	})

	it("breaches on a near-total outage", () => {
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 3, errorCount: 0, p95Ms: 200 }, highVarianceBaseline),
			normalConfig,
		)
		expect(byKey(evals, "throughput").status).toBe("breached")
	})

	it("stays fireable on high-variance series with a non-negative outage threshold", () => {
		const noisy = Array.from({ length: 21 }, (_, i) => ({
			requestCount: i % 2 === 0 ? 600 : 12000,
			errorCount: 0,
			p95Ms: 200,
		}))
		const evals = evaluateGoldenSignals(
			goldenSeries({ requestCount: 0, errorCount: 0, p95Ms: 0 }, noisy),
			{ sensitivity: SENSITIVITY.low }, // k=6 worst case
		)
		const e = byKey(evals, "throughput")
		expect(e.threshold).toBeGreaterThan(0)
		expect(e.status).toBe("breached")
	})
})

describe("evaluateLogVolume", () => {
	const logSeries = (errorLogCount: number, baselineCount = 120) => ({
		serviceName: "api",
		deploymentEnv: "production",
		current: { errorLogCount },
		baseline: Array.from({ length: 21 }, () => ({ errorLogCount: baselineCount })),
		sameTime: [],
	})

	it("breaches on a big error-log burst", () => {
		// Baseline 120/h = 2/min; current 600 in the hour = 10/min.
		const e = evaluateLogVolume(logSeries(600), normalConfig)
		expect(e.status).toBe("breached")
	})

	it("skips under the absolute event floor", () => {
		const e = evaluateLogVolume(logSeries(20, 1), normalConfig)
		expect(e.status).toBe("skipped")
	})

	it("stays healthy within bands", () => {
		const e = evaluateLogVolume(logSeries(70), normalConfig)
		expect(e.status).toBe("healthy")
	})
})

describe("evaluateErrorSpike", () => {
	const nowMs = Date.parse("2026-06-11T12:00:00Z")
	const oldIssue = new Map([["fp1", nowMs - 7 * 24 * 60 * 60 * 1000]])
	const spikeConfig = { sensitivity: SENSITIVITY.normal, issueFirstSeenAt: oldIssue, nowMs }
	const observation = (count: number) => ({
		fingerprintHash: "fp1",
		serviceName: "api",
		deploymentEnv: "production",
		count,
	})

	it("breaches when a quiet fingerprint bursts past the Poisson floor", () => {
		// λ = 336/336 = 1 per half hour; threshold = max(1+20, 4, 20) = 21.
		const e = evaluateErrorSpike(observation(40), { totalCount: 336 }, spikeConfig)
		expect(e.status).toBe("breached")
	})

	it("needs 20 occurrences in the window before it can open", () => {
		expect(evaluateErrorSpike(observation(8), { totalCount: 10 }, spikeConfig).status).toBe("skipped")
		expect(evaluateErrorSpike(observation(15), { totalCount: 10 }, spikeConfig).status).toBe("skipped")
		expect(evaluateErrorSpike(observation(25), { totalCount: 10 }, spikeConfig).status).toBe("breached")
	})

	it("emits a healthy recovery value below the opening floor for an existing incident", () => {
		const e = healthyErrorSpikeRecovery(observation(8), 10 / 336, spikeConfig)
		expect(e).toMatchObject({
			detectorKey: "error_spike:production:fp1",
			status: "healthy",
			value: 8,
			sampleCount: 8,
		})
		expect(e.threshold).toBeGreaterThanOrEqual(10)
	})

	it("emits a zero-valued recovery when an open fingerprint disappears", () => {
		const e = healthyErrorSpikeRecovery(observation(0), 1, spikeConfig)
		expect(e.status).toBe("healthy")
		expect(e.value).toBe(0)
		expect(e.baselineMedian).toBe(1)
	})

	it("stays healthy when a chatty fingerprint is at its usual volume", () => {
		// λ = 6720/336 = 20; current 25 < max(20+13.4, 80) = 80.
		const e = evaluateErrorSpike(observation(25), { totalCount: 6720 }, spikeConfig)
		expect(e.status).toBe("healthy")
	})

	it("suppresses fingerprints younger than 24h (first_seen territory)", () => {
		const young = new Map([["fp1", nowMs - 60 * 60 * 1000]])
		const e = evaluateErrorSpike(
			observation(100),
			{ totalCount: 336 },
			{ ...spikeConfig, issueFirstSeenAt: young },
		)
		expect(e.status).toBe("skipped")
	})

	it("skips when no baseline row exists", () => {
		const e = evaluateErrorSpike(observation(100), undefined, spikeConfig)
		expect(e.status).toBe("skipped")
	})
})

describe("rekeyedErrorSpikeBaselines", () => {
	const nowMs = Date.parse("2026-06-11T12:00:00Z")
	const monthAgo = nowMs - 30 * 24 * 60 * 60 * 1000
	const observed = (fingerprintHash: string, count: number, deploymentEnv = "production") => ({
		fingerprintHash,
		serviceName: "api",
		deploymentEnv,
		count,
	})
	const row = (fingerprintHash: string, totalCount: number, deploymentEnv = "production") => ({
		fingerprintHash,
		deploymentEnv,
		totalCount,
	})
	const baselineOf = (
		baselines: ReturnType<typeof rekeyedErrorSpikeBaselines>,
		fingerprintHash: string,
		deploymentEnv = "production",
	) => baselines.get(errorSpikeBaselineKey(fingerprintHash, deploymentEnv))

	// A steady 100 per half hour. `old` was re-keyed to `new` an hour ago: 334 half hours on the
	// old hash, 2 on the new one, and lineage pairs them.
	const rekeyedRows = [row("old", 33_400), row("new", 200)]
	const previousByHash = new Map([["new", ["old"]]])
	const noLineage = new Map<string, ReadonlyArray<string>>()
	// Every issue here is a month old, so the "too young" guard does not apply.
	const spikeConfig = {
		sensitivity: SENSITIVITY.normal,
		issueFirstSeenAt: new Map([
			["new", monthAgo],
			["quiet", monthAgo],
			["busy", monthAgo],
		]),
		nowMs,
	}
	const evaluate = (count: number) => {
		const observation = observed("new", count)
		const baselines = rekeyedErrorSpikeBaselines([observation], rekeyedRows, previousByHash)
		return evaluateErrorSpike(observation, baselineOf(baselines, "new"), spikeConfig)
	}

	it("holds a re-keyed hash at its steady rate against its previous hash's history", () => {
		const e = evaluate(100)
		// λ = (33400 + 200) / 336 = 100; threshold = max(100 + 30, 400, 20) = 400.
		expect(e).toMatchObject({ status: "healthy", value: 100, baselineMedian: 100, threshold: 400 })
		// Its own hour of history alone reads the same rate as a critical spike.
		expect(evaluateErrorSpike(observed("new", 100), row("new", 200), spikeConfig)).toMatchObject({
			status: "breached",
			severity: "critical",
		})
	})

	it("still breaches a re-keyed hash on a real 10x spike", () => {
		expect(evaluate(1000)).toMatchObject({ status: "breached", value: 1000, threshold: 400 })
	})

	it("uses the previous hash's history for a re-keyed hash that has no row of its own yet", () => {
		const baselines = rekeyedErrorSpikeBaselines(
			[observed("new", 100)],
			[row("old", 33_600)],
			previousByHash,
		)
		expect(baselineOf(baselines, "new")).toEqual({ totalCount: 33_600 })
	})

	it("sums every previous hash of a bump that folded several errors, each row counted once", () => {
		const baselines = rekeyedErrorSpikeBaselines(
			[observed("folded", 300)],
			[row("left", 10_000), row("right", 20_000), row("folded", 600)],
			// Lineage is read per minute and can repeat a pair, or name the hash itself.
			new Map([["folded", ["left", "right", "left", "folded"]]]),
		)
		expect(baselineOf(baselines, "folded")).toEqual({ totalCount: 30_600 })
	})

	it("does not hand a previous hash the history of the hash that replaced it", () => {
		const baselines = rekeyedErrorSpikeBaselines(
			[observed("old", 40), observed("new", 60)],
			rekeyedRows,
			previousByHash,
		)
		expect(baselineOf(baselines, "old")).toEqual({ totalCount: 33_400 })
		expect(baselineOf(baselines, "new")).toEqual({ totalCount: 33_600 })
	})

	it("keeps a hash with no lineage on its own row", () => {
		const baselines = rekeyedErrorSpikeBaselines(
			[observed("plain", 50), observed("unseen", 50)],
			[row("plain", 672), ...rekeyedRows],
			previousByHash,
		)
		expect(baselineOf(baselines, "plain")).toEqual({ totalCount: 672 })
		// No row and no lineage: nothing to compare against, so the evaluator skips it as before.
		expect(baselineOf(baselines, "unseen")).toBeUndefined()
	})

	it("does not mix environments", () => {
		const baselines = rekeyedErrorSpikeBaselines(
			[observed("new", 100), observed("new", 100, "staging")],
			[...rekeyedRows, row("old", 3_360, "staging")],
			previousByHash,
		)
		expect(baselineOf(baselines, "new")).toEqual({ totalCount: 33_600 })
		expect(baselineOf(baselines, "new", "staging")).toEqual({ totalCount: 3_360 })
	})

	it("keeps two hashes a user merged into one issue on independent baselines", () => {
		// One issue owns both, but lineage does not relate them: 1 and 1,000 per half hour.
		const observations = [observed("quiet", 100), observed("busy", 1000)]
		const baselines = rekeyedErrorSpikeBaselines(
			observations,
			[row("quiet", 336), row("busy", 336_000)],
			noLineage,
		)
		const [quiet, busy] = Arr.map(observations, (observation) =>
			evaluateErrorSpike(observation, baselineOf(baselines, observation.fingerprintHash), spikeConfig),
		)
		// λ = 1; threshold = max(1 + 20, 4, 20) = 21. Against the pooled history it was 4,004.
		expect(quiet).toMatchObject({ status: "breached", value: 100, baselineMedian: 1, threshold: 21 })
		// λ = 1000; threshold = max(1000 + 94.9, 4000, 20) = 4000.
		expect(busy).toMatchObject({ status: "healthy", value: 1000, baselineMedian: 1000, threshold: 4000 })
	})
})

describe("capBusiestLogSeries", () => {
	const series = (serviceName: string, errorLogCount: number, baselineHours: number) => ({
		serviceName,
		deploymentEnv: "production",
		current: { errorLogCount },
		baseline: Array.from({ length: baselineHours }, () => ({ errorLogCount: 5 })),
		sameTime: [],
	})

	it("keeps the busiest series regardless of input order", () => {
		// ClickHouse GROUP BY order is arbitrary; an unsorted slice could drop
		// the busy (or already-anomalous) series and let the no-data sweep
		// falsely resolve their open incidents.
		const quiet = Array.from({ length: 5 }, (_, i) => series(`quiet-${i}`, 1, 0))
		const busy = series("busy", 5000, 21)
		const capped = capBusiestLogSeries([...quiet, busy], 3)
		expect(capped[0]?.serviceName).toBe("busy")
		expect(capped).toHaveLength(3)
	})

	it("ranks a series with baseline history but no current traffic as busy", () => {
		// A series that went dark is exactly the one the detector must evaluate.
		const dark = series("dark", 0, 21)
		const chatty = series("chatty", 2, 0)
		const capped = capBusiestLogSeries([chatty, dark], 1)
		expect(capped[0]?.serviceName).toBe("dark")
	})
})

describe("maintenance baseline exclusion", () => {
	const HOUR = 60 * 60 * 1000
	const row = (hourMs: number, serviceName = "checkout", deploymentEnv = "prod") => ({
		hourMs,
		serviceName,
		deploymentEnv,
	})
	const checkoutWindow: BaselineExclusion = {
		covers: (service) => service === "checkout",
		ranges: [{ startsAtMs: 10 * HOUR + 30 * 60_000, endsAtMs: 12 * HOUR }],
	}

	it("drops every hour an occurrence overlaps, including a partly covered one", () => {
		expect(isBaselineHourExcluded([checkoutWindow], row(10 * HOUR))).toBe(true)
		expect(isBaselineHourExcluded([checkoutWindow], row(11 * HOUR))).toBe(true)
	})

	it("keeps hours that only touch an occurrence's edges", () => {
		expect(isBaselineHourExcluded([checkoutWindow], row(9 * HOUR + 30 * 60_000))).toBe(false)
		expect(isBaselineHourExcluded([checkoutWindow], row(12 * HOUR))).toBe(false)
	})

	it("keeps series the window does not cover", () => {
		expect(isBaselineHourExcluded([checkoutWindow], row(11 * HOUR, "cart"))).toBe(false)
	})

	it("filters only the covered rows and returns the input untouched without exclusions", () => {
		const rows = [row(9 * HOUR), row(10 * HOUR), row(11 * HOUR, "cart"), row(13 * HOUR)]
		expect(excludeMaintenanceHours(rows, [checkoutWindow])).toEqual([rows[0], rows[2], rows[3]])
		expect(excludeMaintenanceHours(rows, [])).toBe(rows)
	})

	it("leaves a series too few samples to evaluate, which then skips as before", () => {
		const hours = Array.from({ length: 21 }, (_, i) => ({
			...row(i * HOUR),
			requestCount: 1000,
			errorCount: 10,
			p95Ms: 100,
		}))
		const everyHour: BaselineExclusion = {
			covers: () => true,
			ranges: [{ startsAtMs: 5 * HOUR, endsAtMs: 21 * HOUR }],
		}
		const baseline = excludeMaintenanceHours(hours, [everyHour])
		const evaluations = evaluateGoldenSignals(
			{
				serviceName: "checkout",
				deploymentEnv: "prod",
				current: { requestCount: 1000, errorCount: 500, p95Ms: 100 },
				baseline,
				sameTime: [],
			},
			normalConfig,
		)
		expect(baseline).toHaveLength(5)
		expect(
			Arr.findFirst(evaluations, (e) => e.signalType === "error_rate").pipe(
				Option.map((e) => e.status),
			),
		).toEqual(Option.some("skipped"))
	})
})

describe("windowBaseline", () => {
	const HOUR = 60 * 60 * 1000
	const at = (iso: string) => Date.parse(iso)
	const hour = (requestCount: number) => ({ requestCount, errorCount: 0, p95Ms: 100 })

	it("blends the two hours each window straddles by how far into the hour it is", () => {
		// 10:15: the window is 45 min of 09:00-10:00 and 15 min of 10:00-11:00, one day back.
		const now = at("2026-11-10T10:15:00Z")
		const hours = new Map([
			[at("2026-11-09T09:00:00Z"), hour(400)],
			[at("2026-11-09T10:00:00Z"), hour(800)],
		])
		const { all, sameTime } = windowBaseline(hours, now, blendGoldenHours)
		expect(sameTime).toEqual([{ requestCount: 500, errorCount: 0, p95Ms: 100 }])
		expect(all).toEqual(sameTime)
	})

	it("reads 7 days at -1, 0 and +1 hour, skipping windows with an empty hour", () => {
		const now = at("2026-11-10T10:30:00Z")
		const hours = new Map<number, ReturnType<typeof hour>>()
		for (let day = 1; day <= 7; day++) {
			for (let h = 8; h <= 11; h++)
				hours.set(at("2026-11-10T00:00:00Z") - day * 24 * HOUR + h * HOUR, hour(100))
		}
		expect(windowBaseline(hours, now, blendGoldenHours).all).toHaveLength(21)
		hours.delete(at("2026-11-09T09:00:00Z"))
		const { all, sameTime } = windowBaseline(hours, now, blendGoldenHours)
		// 09:00 yesterday sits in the -1h and the unshifted window.
		expect(all).toHaveLength(19)
		expect(sameTime).toHaveLength(6)
	})

	it("never reads today's hours, which the current window overlaps", () => {
		const now = at("2026-11-10T10:30:00Z")
		const hours = new Map([
			[at("2026-11-10T09:00:00Z"), hour(100)],
			[at("2026-11-10T08:00:00Z"), hour(100)],
		])
		expect(windowBaseline(hours, now, blendGoldenHours).all).toEqual([])
	})
})

describe("latency baseline across hours with different distributions", () => {
	it("keeps each window's p95 a real hourly p95, so a 2x regression still breaches", () => {
		// Every previous day: 100 ms at 08:00 and 09:00, 1,000 ms at 10:00 and 11:00. At 10:30 the
		// windows' true p95s are about 100, 1,000 and 1,000 ms; averaging would invent 550 ms samples.
		const now = Date.parse("2026-11-10T10:30:00Z")
		const midnight = Date.parse("2026-11-10T00:00:00Z")
		const hours = new Map<number, { requestCount: number; errorCount: number; p95Ms: number }>()
		for (let day = 1; day <= 7; day++) {
			for (const [h, p95Ms] of [
				[8, 100],
				[9, 100],
				[10, 1000],
				[11, 1000],
			] as const) {
				hours.set(midnight - day * 24 * 60 * 60 * 1000 + h * 60 * 60 * 1000, {
					requestCount: 6000,
					errorCount: 0,
					p95Ms,
				})
			}
		}
		const { all, sameTime } = windowBaseline(hours, now, blendGoldenHours)
		expect(new Set(Arr.map(all, (w) => w.p95Ms))).toEqual(new Set([100, 1000]))
		const e = byKey(
			evaluateGoldenSignals(
				{
					serviceName: "api",
					deploymentEnv: "production",
					current: { requestCount: 6000, errorCount: 0, p95Ms: 2000 },
					baseline: all,
					sameTime,
				},
				normalConfig,
			),
			"latency_p95",
		)
		expect(e.status).toBe("breached")
	})
})

describe("blendGoldenHours", () => {
	it("takes the p95 of the hour with most of the window's requests, not most of its time", () => {
		// 10:15: 45 min of a quiet hour (75 requests) and 15 min of a busy one (2,500 requests).
		const quiet = { requestCount: 100, errorCount: 0, p95Ms: 100 }
		const busy = { requestCount: 10_000, errorCount: 0, p95Ms: 1000 }
		expect(blendGoldenHours(quiet, busy, 0.25).p95Ms).toBe(1000)
		expect(blendGoldenHours(busy, quiet, 0.75).p95Ms).toBe(1000)
	})
})

describe("goldenWindowFromHours", () => {
	it("adds the share of the previous hour the 60-minute window still covers", () => {
		const now = Date.parse("2026-11-10T10:15:00Z")
		const w = goldenWindowFromHours(
			{ requestCount: 400, errorCount: 40, p95Ms: 200 },
			{ requestCount: 100, errorCount: 5, p95Ms: 400 },
			now,
		)
		expect(w.requestCount).toBe(400)
		expect(w.errorCount).toBe(35)
		// 300 of the window's 400 requests fall in the previous hour: its p95 stands.
		expect(w.p95Ms).toBe(200)
	})
})

describe("environment filter", () => {
	it("reads common non-production names as non-production", () => {
		for (const env of [
			"staging",
			"stg",
			"development",
			"dev-eu",
			"eu-staging",
			"local",
			"qa",
			"preview",
			"preprod",
			"pre-prod",
			"pr-4969",
			"pr123",
		]) {
			expect(isNonProductionEnvironment(env)).toBe(true)
		}
	})

	it("counts empty and unrecognised names as production", () => {
		for (const env of ["", "production", "prod", "live", "internal", "us-east-1", "devops"]) {
			expect(isNonProductionEnvironment(env)).toBe(false)
		}
	})

	it("watches a non-production environment the org opted in", () => {
		expect(isWatchedEnvironment("staging", [])).toBe(false)
		expect(isWatchedEnvironment("staging", ["staging"])).toBe(true)
		expect(isWatchedEnvironment("production", [])).toBe(true)
	})
})
