import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { SourceUsageService } from "@maple/backend/services/org/SourceUsageService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"

const ORG = Schema.decodeUnknownSync(OrgId)("org_source_usage")
const USER = Schema.decodeUnknownSync(UserId)("user_source_usage")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

const NOW = Date.UTC(2026, 6, 15, 9, 42, 17)

// 64-bit sums arrive as strings, as ClickHouse returns them; rows may come unordered.
const hourlyRows = [
	{ hour: "2026-07-15 09:00:00", spans: "10", logs: "4", metrics: "6", bytes: "5000" },
	{ hour: "2026-07-14 10:00:00", spans: "1", logs: "0", metrics: "0", bytes: "300" },
]
const totalsRows = [{ sourceId: "src_a", spans: "11", logs: "4", metrics: "6", bytes: "5300" }]

const makeLayer = (sql: Array<string>) =>
	Layer.effect(SourceUsageService, SourceUsageService.make).pipe(
		Layer.provide(
			Layer.succeed(
				WarehouseQueryService,
				makeWarehouseServiceStub({
					compiledQuery: (_tenant, compiled, options) => {
						sql.push(compiledQueryOf(compiled).sql)
						const rows = options?.context === "sourceUsageTotals" ? totalsRows : hourlyRows
						return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
					},
				}),
			),
		),
	)

describe("SourceUsageService", () => {
	it.effect("reads 24 whole hours ending now, oldest bucket first", () => {
		const sql: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const usage = yield* SourceUsageService.use((service) => service.read(tenant, "src_a"))

			assert.strictEqual(usage.windowStart, Date.UTC(2026, 6, 14, 10))
			assert.strictEqual(usage.windowEnd, NOW)
			assert.deepStrictEqual(
				usage.buckets.map((bucket) => [bucket.hour, bucket.spans, bucket.metrics, bucket.bytes]),
				[
					[Date.UTC(2026, 6, 14, 10), 1, 0, 300],
					[Date.UTC(2026, 6, 15, 9), 10, 6, 5000],
				],
			)
			assert.include(sql[0], "'2026-07-14 10:00:00'")
		}).pipe(Effect.provide(makeLayer(sql)))
	})

	it.effect("summarises every source over the same window", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const summary = yield* SourceUsageService.use((service) => service.summary(tenant))

			assert.strictEqual(summary.windowStart, Date.UTC(2026, 6, 14, 10))
			assert.deepStrictEqual(
				summary.totals.map((total) => ({ ...total })),
				[{ sourceId: "src_a", spans: 11, logs: 4, metrics: 6, bytes: 5300 }],
			)
		}).pipe(Effect.provide(makeLayer([]))),
	)
})
