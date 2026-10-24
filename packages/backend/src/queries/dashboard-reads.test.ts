import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/primitives"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import type { QueryEngineServiceApi } from "@maple/backend/services/warehouse/QueryEngineService"
import { makeDashboardReads } from "./dashboard-reads"

const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"

const tenant: TenantContext = {
	orgId: Schema.decodeUnknownSync(OrgId)("org_dashboard_reads"),
	userId: Schema.decodeUnknownSync(UserId)("user_dashboard_reads"),
	roles: [],
	authMode: "self_hosted",
}

const spanRow = (spanId: string) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId: "",
	spanName: "GET /checkout",
	rawSpanName: "http.server GET",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-07-15 12:00:00.000",
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: "{}",
	resourceAttributes: "{}",
	relationship: "related",
})

/** A warehouse answering probes and hierarchy reads, recording every statement it ran. */
const makeWarehouse = (options: {
	readonly recentProbe: ReadonlyArray<Record<string, unknown>>
	readonly fullProbe: ReadonlyArray<Record<string, unknown>>
	readonly spans: number
}) => {
	const statements: string[] = []
	const rowsFor = (sql: string) => {
		statements.push(sql)
		if (sql.includes("AS relationship")) {
			return Array.from({ length: options.spans }, (_, index) =>
				spanRow(index.toString(16).padStart(16, "0")),
			)
		}
		if (sql.includes("MaxTimestamp >=")) return options.recentProbe
		return options.fullProbe
	}
	const decode = (compiled: CompiledQueryInput<unknown>) =>
		compiledQueryOf(compiled)
			.decodeRows(rowsFor(compiledQueryOf(compiled).sql))
			.pipe(Effect.orDie)
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: these reads hand the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled)) as never,
		// SAFETY: as above.
		compiledQueryFirst: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))) as never,
	})
	return { warehouse, statements }
}

const passThroughCache = (routes: string[]) =>
	({
		cachedDirect: <A, E>(
			_tenant: unknown,
			route: string,
			_payload: unknown,
			effect: Effect.Effect<A, E>,
		) => {
			routes.push(route)
			return effect
		},
	}) as const

const hierarchyStatement = (statements: ReadonlyArray<string>) =>
	statements.find((sql) => sql.includes("AS relationship"))

describe("makeDashboardReads.spanHierarchy", () => {
	it.effect("reads the caller's window without probing", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = makeWarehouse({ recentProbe: [], fullProbe: [], spans: 1 })
			const routes: string[] = []
			// SAFETY: the reads only call `cachedDirect` on the query engine.
			const queryEngine = passThroughCache(routes) as unknown as QueryEngineServiceApi
			const result = yield* makeDashboardReads({ warehouse, queryEngine }).spanHierarchy(tenant, {
				traceId: TRACE_ID,
				startTime: "2026-07-15 11:30:00",
				endTime: "2026-07-15 12:30:00",
			})
			expect(result.rows).toHaveLength(1)
			expect(routes).toEqual(["spanHierarchy"])
			expect(statements).toHaveLength(1)
			expect(hierarchyStatement(statements)).toContain("'2026-07-15 11:30:00'")
		}),
	)

	it.effect("falls back to the unbounded probe for an old trace and bounds the read around it", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = makeWarehouse({
				recentProbe: [],
				fullProbe: [{ timestamp: "2026-06-01 08:00:00" }],
				spans: 1,
			})
			// SAFETY: the reads only call `cachedDirect` on the query engine.
			const queryEngine = passThroughCache([]) as unknown as QueryEngineServiceApi
			yield* makeDashboardReads({ warehouse, queryEngine }).spanHierarchy(tenant, { traceId: TRACE_ID })
			expect(statements).toHaveLength(3)
			const hierarchy = hierarchyStatement(statements)
			expect(hierarchy).toContain("'2026-06-01 07:00:00'")
			expect(hierarchy).toContain("'2026-06-01 09:00:00'")
		}),
	)

	it.effect("reads one sentinel span past the cap to report truncation", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = makeWarehouse({ recentProbe: [], fullProbe: [], spans: 5001 })
			// SAFETY: the reads only call `cachedDirect` on the query engine.
			const queryEngine = passThroughCache([]) as unknown as QueryEngineServiceApi
			const result = yield* makeDashboardReads({ warehouse, queryEngine }).spanHierarchy(tenant, {
				traceId: TRACE_ID,
			})
			expect(result.truncated).toBe(true)
			expect(result.rows).toHaveLength(5000)
			// No probe hit, so the read stays unbounded rather than guessing a window.
			expect(hierarchyStatement(statements)).not.toContain("Timestamp >=")
		}),
	)
})
