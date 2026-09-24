import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { systemTenant } from "./system-tenant"
import {
	holdCeilingMs,
	LIVENESS_MIN_VOLUME_RATIO,
	pickOrgBaseline,
	pickServiceBaseline,
	probeLiveness,
	verdictForOrgTotals,
	verdictForServiceTotals,
	type LivenessWarehouse,
	type ServiceWindowPair,
} from "./telemetry-liveness"

/** Even sampling: raw and corrected move together. */
const totals = (spanCount: number, estimatedSpanCount = spanCount) => ({
	spanCount,
	estimatedSpanCount,
})

const pair = (
	observed: ReturnType<typeof totals> | null,
	baseline: ReturnType<typeof totals> | null,
): ServiceWindowPair => [observed, baseline]

describe("verdictForServiceTotals", () => {
	it("passes a service whose traffic held steady", () => {
		const v = verdictForServiceTotals([pair(totals(1000), totals(1000))])
		expect(v.dataFlowing).toBe(true)
		expect(v.reason).toBe("ok")
		expect(v.ratio).toBe(1)
	})

	it("vetoes when a service that had traffic goes completely dark", () => {
		// The ingest-outage case: the alert looks healthy because nothing arrived.
		const v = verdictForServiceTotals([pair(totals(0), totals(5000))])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("no_data")
	})

	it("vetoes on one dark service even when the others carry the totals", () => {
		const v = verdictForServiceTotals([
			pair(totals(10_000), totals(10_000)),
			pair(totals(0), totals(200)),
		])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("no_data")
	})

	it("vetoes when volume survives but collapses below the floor", () => {
		const v = verdictForServiceTotals([pair(totals(100), totals(1000))])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("volume_collapsed")
		expect(v.ratio).toBeLessThan(LIVENESS_MIN_VOLUME_RATIO)
	})

	it("allows a dip that stays above the floor", () => {
		const v = verdictForServiceTotals([pair(totals(800), totals(1000))])
		expect(v.dataFlowing).toBe(true)
		expect(v.reason).toBe("ok")
	})

	it("calls a sampler change a sampling change, not a recovery", () => {
		// Raw spans collapse 10x while the sample-corrected count holds: the
		// sampler was turned down, the traffic never moved.
		const v = verdictForServiceTotals([pair(totals(100, 1000), totals(1000, 1000))])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("sampling_changed")
	})

	it("treats a service with no baseline traffic as unprovable, not dark", () => {
		// A rule on a service that was already silent must not be permanently
		// ineligible for resolution — there is no gap to detect.
		const v = verdictForServiceTotals([pair(totals(0), totals(0))])
		expect(v.dataFlowing).toBe(true)
		expect(v.reason).toBe("no_baseline")
		expect(v.ratio).toBeNull()
	})

	it("fails closed when the observed probe errored", () => {
		const v = verdictForServiceTotals([pair(null, totals(1000))])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("probe_failed")
	})

	it("fails closed when the BASELINE probe errored", () => {
		// The dangerous one: a failed baseline must not read as "never had
		// traffic", which would wave the resolve through.
		const v = verdictForServiceTotals([pair(totals(0), null)])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("probe_failed")
	})

	it("fails closed if any service in the set errored", () => {
		const v = verdictForServiceTotals([pair(totals(1000), totals(1000)), pair(null, null)])
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("probe_failed")
	})

	it("treats an empty service list as unprovable", () => {
		expect(verdictForServiceTotals([]).reason).toBe("no_baseline")
	})
})

describe("verdictForOrgTotals", () => {
	it("passes an org still emitting at baseline volume", () => {
		const v = verdictForOrgTotals(5000, 5000)
		expect(v.dataFlowing).toBe(true)
		expect(v.reason).toBe("ok")
	})

	it("vetoes an org that went entirely dark", () => {
		const v = verdictForOrgTotals(0, 5000)
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("no_data")
	})

	it("vetoes an org whose volume collapsed below the floor", () => {
		const v = verdictForOrgTotals(100, 5000)
		expect(v.dataFlowing).toBe(false)
		expect(v.reason).toBe("volume_collapsed")
	})

	it("fails closed on a probe error from either window", () => {
		expect(verdictForOrgTotals(null, 5000).reason).toBe("probe_failed")
		expect(verdictForOrgTotals(5000, null).reason).toBe("probe_failed")
	})

	it("treats a never-active org as unprovable", () => {
		const v = verdictForOrgTotals(0, 0)
		expect(v.dataFlowing).toBe(true)
		expect(v.reason).toBe("no_baseline")
	})
})

describe("baseline selection", () => {
	it("prefers yesterday's window when it carried traffic", () => {
		expect(pickServiceBaseline(totals(1000), totals(60))).toEqual(totals(60))
		expect(pickOrgBaseline(1000, 60)).toBe(60)
	})

	it("falls back to the onset window for a service with no prior day", () => {
		expect(pickServiceBaseline(totals(1000), totals(0))).toEqual(totals(1000))
		expect(pickServiceBaseline(totals(1000), null)).toEqual(totals(1000))
		expect(pickOrgBaseline(1000, 0)).toBe(1000)
		expect(pickOrgBaseline(1000, null)).toBe(1000)
	})

	it("keeps an onset probe failure a failure even when yesterday is absent", () => {
		// The fallback covers absence, not errors: a null onset with no prior
		// day must still read as probe_failed downstream.
		expect(pickServiceBaseline(null, null)).toBe(null)
		expect(pickOrgBaseline(null, 0)).toBe(null)
	})
})

describe("holdCeilingMs", () => {
	it("bounds a diurnal collapse at a few windows, never under half an hour", () => {
		expect(holdCeilingMs("volume_collapsed", 5)).toBe(30 * 60_000)
		expect(holdCeilingMs("volume_collapsed", 15)).toBe(45 * 60_000)
	})

	it("holds the outage signatures for hours, not forever", () => {
		expect(holdCeilingMs("no_data", 5)).toBe(6 * 60 * 60_000)
		expect(holdCeilingMs("sampling_changed", 5)).toBe(6 * 60 * 60_000)
	})

	it("never resolves on the clock when the probe itself failed", () => {
		expect(holdCeilingMs("probe_failed", 5)).toBe(null)
	})
})

describe("probeLiveness prior-day baseline", () => {
	it("reads an evening dip against yesterday evening, not the peak the incident opened at", async () => {
		const tenant = systemTenant(Schema.decodeUnknownSync(OrgId)("org_liveness_prior_day"))
		const windowStartMs = Date.parse("2026-06-02T01:10:00.000Z")
		const windowEndMs = Date.parse("2026-06-02T01:15:00.000Z")
		const baselineStartMs = Date.parse("2026-06-01T17:55:00.000Z")
		const baselineEndMs = Date.parse("2026-06-01T18:00:00.000Z")
		const priorDayBaselineStartMs = Date.parse("2026-06-01T01:10:00.000Z")
		const priorDayBaselineEndMs = Date.parse("2026-06-01T01:15:00.000Z")

		const row = (spanCount: number) => ({
			minutesWithData: spanCount > 0 ? 5 : 0,
			spanCount,
			estimatedSpanCount: spanCount,
			errorCount: 0,
			estimatedErrorCount: 0,
			lastSeen: "2026-06-02 01:14:00",
		})

		const warehouse: LivenessWarehouse = {
			warmRoute: () => Effect.void,
			compiledQuery: () => Effect.die("org pulse must not run for a service-scoped probe"),
			compiledQueryFirst: (_tenant, compiled) =>
				Effect.gen(function* () {
					const query = compiledQueryOf(compiled)
					// Peak at onset, a quiet night now, and the same quiet night yesterday.
					const spanCount = query.sql.includes(formatWarehouseDateTime(baselineStartMs))
						? 172
						: query.sql.includes(formatWarehouseDateTime(priorDayBaselineStartMs))
							? 22
							: 19
					return yield* query.decodeFirstRow([row(spanCount)]).pipe(Effect.orDie)
				}),
		}

		const verdict = await Effect.runPromise(
			probeLiveness({
				warehouse,
				tenant,
				serviceNames: ["innuvia-api"],
				environments: [],
				windowStartMs,
				windowEndMs,
				baselineStartMs,
				baselineEndMs,
				priorDayBaselineStartMs,
				priorDayBaselineEndMs,
			}),
		)

		expect(verdict.dataFlowing).toBe(true)
		expect(verdict.reason).toBe("ok")
		expect(verdict.baselineCount).toBe(22)
	})
})

describe("probeLiveness environment scoping", () => {
	// The probe must query the alert's own environments: without the scope,
	// staging traffic for the same service satisfies liveness while production
	// is dark — exactly the outage the probe exists to veto.
	it("vetoes when the rule's environment went dark even though the service is loud elsewhere", async () => {
		const tenant = systemTenant(Schema.decodeUnknownSync(OrgId)("org_liveness_env"))
		const windowStartMs = Date.parse("2026-06-02T00:10:00.000Z")
		const windowEndMs = Date.parse("2026-06-02T00:15:00.000Z")
		const baselineStartMs = Date.parse("2026-06-01T23:55:00.000Z")
		const baselineEndMs = Date.parse("2026-06-02T00:00:00.000Z")
		const observedSql: string[] = []

		const row = (spanCount: number) => ({
			minutesWithData: spanCount > 0 ? 5 : 0,
			spanCount,
			estimatedSpanCount: spanCount,
			errorCount: 0,
			estimatedErrorCount: 0,
			lastSeen: "2026-06-02 00:14:00",
		})

		const warehouse: LivenessWarehouse = {
			warmRoute: () => Effect.void,
			compiledQuery: () => Effect.die("org pulse must not run for a service-scoped probe"),
			compiledQueryFirst: (_tenant, compiled) =>
				Effect.gen(function* () {
					const query = compiledQueryOf(compiled)
					observedSql.push(query.sql)
					const isBaseline = query.sql.includes(formatWarehouseDateTime(baselineStartMs))
					const productionScoped = query.sql.includes("DeploymentEnv = 'production'")
					// Production went dark in the verification window; staging keeps
					// the UNSCOPED totals healthy in both windows.
					const spanCount = productionScoped ? (isBaseline ? 1000 : 0) : isBaseline ? 2000 : 1800
					return yield* query.decodeFirstRow([row(spanCount)]).pipe(Effect.orDie)
				}),
		}

		const verdict = await Effect.runPromise(
			probeLiveness({
				warehouse,
				tenant,
				serviceNames: ["checkout"],
				environments: ["production"],
				windowStartMs,
				windowEndMs,
				baselineStartMs,
				baselineEndMs,
			}),
		)

		expect(observedSql.some((sql) => sql.includes("DeploymentEnv = 'production'"))).toBe(true)
		expect(verdict.dataFlowing).toBe(false)
		expect(verdict.reason).toBe("no_data")
	})
})
