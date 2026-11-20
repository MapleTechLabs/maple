import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { OrgId, UserId, WarehouseSchemaDriftError, type TenantContext } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { DailySpendService } from "./DailySpendService"

// The billing chart's daily volume: profile bytes from service_usage become profilesGB, and a
// cluster whose service_usage predates the profile columns still answers, with no profiles.

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_daily_spend"),
	userId: Schema.decodeSync(UserId)("user_admin"),
	roles: ["org:admin"],
	permissions: Policy.grantsOf(["org:admin"]),
	authMode: "self_hosted",
}

const cycle = {
	startMs: Date.parse("2026-07-01T00:00:00Z"),
	endMs: Date.parse("2026-07-03T23:59:59Z"),
	nowMs: Date.parse("2026-07-02T12:00:00Z"),
}

const drift = (column: string) =>
	new WarehouseSchemaDriftError({
		message: `Code: 47. Unknown expression identifier \`${column}\` in scope SELECT ...`,
		pipeName: "billingDailySignalVolume",
		clickhouseType: "UNKNOWN_IDENTIFIER",
	})

const signalRow = (day: string, profileBytes: string | number) => ({
	day: `${day} 00:00:00`,
	logBytes: "2000000000",
	traceBytes: "0",
	metricBytes: "0",
	profileBytes,
})

/** Answers the signal read with `signalRows`; `failWith` fails any SQL naming the profile columns. */
const layer = (signalRows: ReadonlyArray<Record<string, unknown>>, failWith?: WarehouseSchemaDriftError) =>
	Layer.effect(DailySpendService, DailySpendService.make).pipe(
		Layer.provide(
			Layer.succeed(
				WarehouseQueryService,
				makeWarehouseServiceStub({
					compiledQuery: (_tenant, input, options) => {
						const compiled = compiledQueryOf(input)
						if (failWith !== undefined && Str.includes("ProfileSizeBytes")(compiled.sql))
							return Effect.fail(failWith)
						const rows = options?.context === "billingDailySignalVolume" ? signalRows : []
						return compiled.decodeRows(rows).pipe(Effect.orDie)
					},
				}),
			),
		),
	)

describe("DailySpendService", () => {
	it.effect("reports each day's profile bytes as profilesGB, and 0 on days without any", () =>
		Effect.gen(function* () {
			const spend = yield* DailySpendService
			const response = yield* spend.get(tenant, cycle)

			expect(
				Arr.map(response.days, (day) => ({
					date: day.date,
					logsGB: day.logsGB,
					profilesGB: day.profilesGB,
				})),
			).toEqual([
				{ date: "2026-07-01", logsGB: 2, profilesGB: 1.5 },
				{ date: "2026-07-02", logsGB: 0, profilesGB: 0 },
				{ date: "2026-07-03", logsGB: 2, profilesGB: 0.25 },
			])
		}).pipe(
			Effect.provide(
				layer([signalRow("2026-07-01", "1500000000"), signalRow("2026-07-03", "250000000")]),
			),
		),
	)

	it.effect("falls back to no profile usage when service_usage predates the profile columns", () =>
		Effect.gen(function* () {
			const spend = yield* DailySpendService
			const response = yield* spend.get(tenant, cycle)

			expect(Arr.map(response.days, (day) => [day.date, day.logsGB, day.profilesGB])).toEqual([
				["2026-07-01", 2, 0],
				["2026-07-02", 0, 0],
				["2026-07-03", 0, 0],
			])
		}).pipe(Effect.provide(layer([signalRow("2026-07-01", 0)], drift("ProfileSizeBytes")))),
	)

	it.effect("still fails the chart on drift that names another column", () =>
		Effect.gen(function* () {
			const spend = yield* DailySpendService
			const error = yield* Effect.flip(spend.get(tenant, cycle))

			expect(error.pipeName).toBe("billingDailySpend")
			expect(error.message).toContain("LogSizeBytes")
		}).pipe(Effect.provide(layer([], drift("LogSizeBytes")))),
	)
})
