import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { OrgId } from "@maple/domain"
import { compiledQueryOf } from "../execution/compiled-input"
import { diagnoseService } from "./diagnose-service"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"

const timeRange = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" }

const run = (rowsByPipe: Record<string, ReadonlyArray<Record<string, unknown>>>, environment?: string) => {
	const calls: Array<{ pipe: string; params: Record<string, unknown> }> = []
	const executor: WarehouseExecutorApi = {
		orgId: OrgId.make("org_test"),
		compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
		compiledQueryFirst: (compiled) => compiledQueryOf(compiled).decodeFirstRow([]).pipe(Effect.orDie),
		query: (pipe: string, params: Record<string, unknown>) => {
			calls.push({ pipe, params })
			return Effect.succeed({ data: (rowsByPipe[pipe] ?? []) as ReadonlyArray<never> })
		},
	}
	return diagnoseService({ serviceName: "checkout", timeRange, environment }).pipe(
		Effect.provideService(WarehouseExecutor, executor),
		Effect.map((result) => ({ result, calls })),
	)
}

describe("diagnoseService", () => {
	it.effect("weights apdex by span count, not per bucket", () =>
		Effect.gen(function* () {
			// A quiet perfect bucket beside a busy failing one. Averaging the bucket
			// scores would report 0.5; the spans say 0.01.
			const { result } = yield* run({
				service_apdex_time_series: [
					{ totalCount: 1, satisfiedCount: 1, toleratingCount: 0, apdexScore: 1 },
					{ totalCount: 99, satisfiedCount: 0, toleratingCount: 0, apdexScore: 0 },
				],
			})
			assert.closeTo(result.health.apdex, 0.01, 1e-9)
		}),
	)

	it.effect("scopes every query to the requested environment", () =>
		Effect.gen(function* () {
			const { calls } = yield* run({}, "production")
			const envOf = (pipe: string) => {
				const params = calls.find((c) => c.pipe === pipe)?.params
				return params?.deployment_env ?? params?.deployment_envs ?? params?.environments
			}
			for (const pipe of [
				"service_overview",
				"errors_by_type",
				"list_logs",
				"list_traces",
				"service_apdex_time_series",
			]) {
				assert.strictEqual(envOf(pipe), "production", pipe)
			}
		}),
	)
})
