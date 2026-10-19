import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { GcpMetricDescriptor } from "@maple/domain/gcp-live-metrics"
import {
	GcpLiveQueryFailedError,
	GcpLiveQueryRejectedError,
	GcpLiveQueryUnavailableError,
	type GcpLiveQueryError,
} from "@maple/domain/http/gcp-live-query-errors"
import { OrgId } from "@maple/domain/primitives"
import type { GcpLiveMetrics, GcpReadScope } from "@maple/query-engine/runtime"
import { listGcpMetricCatalog } from "./gcp-metric-catalog"

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
const TENANT = { orgId: Schema.decodeSync(OrgId)("org_gcp") }

const descriptor = (type: string, overrides: Partial<GcpMetricDescriptor> = {}): GcpMetricDescriptor => ({
	type,
	metricKind: "GAUGE",
	valueType: "DOUBLE",
	unit: "1",
	description: `${type} description`,
	monitoredResourceTypes: [],
	labels: [],
	...overrides,
})

const DESCRIPTORS = [
	descriptor("cloudsql.googleapis.com/database/cpu/utilization", { unit: "10^2.%" }),
	descriptor("cloudsql.googleapis.com/database/network/connections", {
		metricKind: "CUMULATIVE",
		valueType: "INT64",
	}),
	descriptor("run.googleapis.com/request_latencies", {
		metricKind: "DELTA",
		valueType: "DISTRIBUTION",
		unit: "ms",
	}),
	descriptor("run.googleapis.com/container/instance_state", { valueType: "STRING" }),
]

/** A port answering `listMetrics` with `answer`, counting the calls. */
const fakePort = (answer: Effect.Effect<ReadonlyArray<GcpMetricDescriptor>, GcpLiveQueryError>) => {
	const calls = { listMetrics: 0, scopes: [] as Array<GcpReadScope> }
	const unused = () => Effect.die("not used")
	const port: GcpLiveMetrics = {
		queryRange: unused,
		queryInstant: unused,
		listMetrics: (_tenant, scope) => {
			calls.listMetrics += 1
			calls.scopes.push(scope)
			return answer
		},
	}
	return { port, calls }
}

const run = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* effect
	})

describe("listGcpMetricCatalog", () => {
	it.effect("lists Google's chartable metrics as Google Cloud catalog rows", () =>
		run(
			Effect.gen(function* () {
				const { port, calls } = fakePort(Effect.succeed(DESCRIPTORS))
				const rows = yield* listGcpMetricCatalog(port, TENANT, {})
				// The list reads the first 20 projects rather than refusing more.
				assert.deepStrictEqual(calls.scopes, [{ discovery: true }])
				assert.deepStrictEqual(
					rows.map((row) => [row.metricName, row.metricType, row.isMonotonic]),
					[
						["cloudsql.googleapis.com/database/cpu/utilization", "gauge", 0],
						["cloudsql.googleapis.com/database/network/connections", "sum", 1],
						["run.googleapis.com/request_latencies", "histogram", 1],
					],
				)
				const first = rows[0]!
				assert.strictEqual(first.serviceName, "Google Cloud")
				assert.strictEqual(first.metricUnit, "10^2.%")
				assert.strictEqual(
					first.metricDescription,
					"cloudsql.googleapis.com/database/cpu/utilization description",
				)
				assert.strictEqual(first.dataPointCount, 0)
				assert.strictEqual(DateTime.toEpochMillis(first.lastSeen), NOW)
				assert.strictEqual(DateTime.toEpochMillis(first.firstSeen), NOW - 25 * 3_600_000)
			}),
		),
	)

	it.effect("filters by name substring regardless of case, by type, and caps at the limit", () =>
		run(
			Effect.gen(function* () {
				const { port } = fakePort(Effect.succeed(DESCRIPTORS))
				const names = (request: Parameters<typeof listGcpMetricCatalog>[2]) =>
					listGcpMetricCatalog(port, TENANT, request).pipe(
						Effect.map((rows) => rows.map((row) => row.metricName)),
					)
				assert.deepStrictEqual(yield* names({ search: "CloudSQL" }), [
					"cloudsql.googleapis.com/database/cpu/utilization",
					"cloudsql.googleapis.com/database/network/connections",
				])
				assert.deepStrictEqual(yield* names({ metricType: "histogram" }), [
					"run.googleapis.com/request_latencies",
				])
				assert.deepStrictEqual(yield* names({ service: "Google Cloud", limit: 1 }), [
					"cloudsql.googleapis.com/database/cpu/utilization",
				])
			}),
		),
	)

	it.effect("asks Google nothing for a later page or another service", () =>
		run(
			Effect.gen(function* () {
				const { port, calls } = fakePort(Effect.succeed(DESCRIPTORS))
				assert.deepStrictEqual(yield* listGcpMetricCatalog(port, TENANT, { offset: 100 }), [])
				assert.deepStrictEqual(yield* listGcpMetricCatalog(port, TENANT, { service: "checkout" }), [])
				assert.strictEqual(calls.listMetrics, 0)
			}),
		),
	)

	it.effect("lists no Google rows when Google cannot answer, so the warehouse list still renders", () =>
		run(
			Effect.gen(function* () {
				const failures = [
					new GcpLiveQueryUnavailableError({ message: "not connected" }),
					new GcpLiveQueryFailedError({ message: "Google is down", failures: [] }),
					new GcpLiveQueryRejectedError({ message: "refused", reason: "invalid_query" }),
				]
				for (const failure of failures) {
					const { port } = fakePort(Effect.fail(failure))
					assert.deepStrictEqual(yield* listGcpMetricCatalog(port, TENANT, {}), [])
				}
			}),
		),
	)

	it.effect("lets a defect through: a bug is not Google being unavailable", () =>
		run(
			Effect.gen(function* () {
				const { port } = fakePort(Effect.die("bug"))
				const exit = yield* Effect.exit(listGcpMetricCatalog(port, TENANT, {}))
				assert.isTrue(Exit.hasDies(exit))
			}),
		),
	)
})
