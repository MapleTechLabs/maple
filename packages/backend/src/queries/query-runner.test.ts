import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import type { CompiledQuery } from "@maple-dev/effect-orm/clickhouse"
import { ErrorsByTypeRequest, ListLogsRequest } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Queries } from "@maple/query-engine/registry"
import { baselineWarehouseCapabilities, type WarehouseCapabilities } from "@maple/query-engine"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import type { QueryEngineServiceApi } from "@maple/backend/services/warehouse/QueryEngineService"
import { makeQueryRunners } from "./query-runner"

const tenant: TenantContext = {
	orgId: Schema.decodeUnknownSync(OrgId)("org_query_runner"),
	userId: Schema.decodeUnknownSync(UserId)("user_query_runner"),
	roles: [],
	authMode: "self_hosted",
}

const warehouse = makeWarehouseServiceStub({
	compiledQuery: ((_tenant: unknown, compiled: unknown) =>
		Effect.gen(function* () {
			// SAFETY: the runner hands the stub the definition's unrun compile.
			const query = (yield* compiled as Effect.Effect<CompiledQuery<unknown>>) as CompiledQuery<unknown>
			return yield* query.decodeRows([
				{
					fingerprintHash: "42",
					errorLabel: "Error",
					sampleMessage: "boom",
					count: "3",
					affectedServicesCount: "1",
					serviceNames: ["api"],
					firstSeen: "2024-01-01 10:00:00",
					lastSeen: "2024-01-01 11:30:05",
				},
			])
		})) as never,
})

/** A cache whose hit is the value after a JSON round trip, as the Workers backend returns it. */
const jsonCache = {
	cachedDirect: <A, E>(
		_tenant: unknown,
		_route: string,
		_payload: unknown,
		effect: Effect.Effect<A, E>,
		_policy?: unknown,
		schema?: Schema.Codec<A, unknown, never, never>,
	) =>
		Effect.gen(function* () {
			const value = yield* effect
			// Without a codec the hit would carry ISO strings where the miss had `DateTime.Utc`.
			if (schema === undefined) return yield* Effect.die("direct cache entry without a codec")
			const stored = JSON.parse(
				JSON.stringify(yield* Schema.encodeEffect(schema)(value).pipe(Effect.orDie)),
			)
			return yield* Schema.decodeUnknownEffect(schema)(stored).pipe(Effect.orDie)
		}),
}

describe("makeQueryRunners", () => {
	it.effect("keeps DateTime.Utc rows intact across the direct cache's JSON round trip", () =>
		Effect.gen(function* () {
			// SAFETY: the runner only calls `cachedDirect`.
			const queryEngine = jsonCache as unknown as QueryEngineServiceApi
			const { runQuery } = makeQueryRunners({ warehouse, queryEngine })
			const payload = Schema.decodeUnknownSync(ErrorsByTypeRequest)({
				startTime: "2024-01-01 00:00:00",
				endTime: "2024-01-02 00:00:00",
			})
			const [row] = yield* runQuery(Queries.errorsByType, tenant, payload)
			expect(DateTime.isDateTime(row?.firstSeen)).toBe(true)
			expect(DateTime.formatIso(row!.lastSeen)).toBe("2024-01-01T11:30:05.000Z")
		}),
	)

	it.effect("keeps a capability-aware definition's DateTime.Utc rows intact too", () =>
		Effect.gen(function* () {
			const logsWarehouse = makeWarehouseServiceStub({
				compiledQueryWithCapabilities: ((_tenant: unknown, compile: unknown) =>
					Effect.gen(function* () {
						// SAFETY: a capability-aware definition hands the stub its compile function.
						const build = compile as (capabilities: WarehouseCapabilities) => Effect.Effect<CompiledQuery<unknown>>
						const query = yield* build(baselineWarehouseCapabilities())
						return yield* query.decodeRows([
							{
								timestamp: "2024-01-01 10:00:00.123456789",
								exactTimestamp: "2024-01-01 10:00:00.123456789",
								severityText: "INFO",
								severityNumber: 9,
								serviceName: "api",
								body: "hello",
								traceId: "",
								spanId: "",
								recordIdentity: "00112233445566778899AABBCCDDEEFF",
								logAttributes: "{}",
								resourceAttributes: "{}",
							},
						])
					})) as never,
			})
			// SAFETY: the runner only calls `cachedDirect`.
			const queryEngine = jsonCache as unknown as QueryEngineServiceApi
			const { runQuery } = makeQueryRunners({ warehouse: logsWarehouse, queryEngine })
			const payload = new ListLogsRequest({
				startTime: "2024-01-01 00:00:00",
				endTime: "2024-01-02 00:00:00",
			})
			const [row] = yield* runQuery(Queries.listLogs, tenant, payload)
			expect(DateTime.formatIso(row!.timestamp)).toBe("2024-01-01T10:00:00.123Z")
			expect(row!.exactTimestamp).toBe("2024-01-01 10:00:00.123456789")
		}),
	)
})
