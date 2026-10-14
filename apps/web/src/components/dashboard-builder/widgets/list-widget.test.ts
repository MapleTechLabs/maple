// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { assert, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

// This mock must be registered before importing its consumers.
const runWarehouseQueryMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", async () => {
	const actual = await vi.importActual<typeof import("@/api/warehouse/effect-utils")>(
		"@/api/warehouse/effect-utils",
	)
	return {
		...actual,
		runWarehouseQuery: (...args: unknown[]) => runWarehouseQueryMock(...args),
	}
})

const defaultRunWarehouseQuery = () =>
	Effect.succeed({
		data: [
			{
				timestamp: "2026-03-28 12:00:00",
				severityText: "ERROR",
				severityNumber: 17,
				serviceName: "api-gw",
				body: "Connection refused",
				traceId: "t1",
				spanId: "s1",
				logAttributes: '{"http.method":"GET"}',
				resourceAttributes: '{"service.version":"1.0"}',
			},
		],
	})

beforeEach(() => {
	runWarehouseQueryMock.mockReset()
	runWarehouseQueryMock.mockImplementation(defaultRunWarehouseQuery)
})

import { listLogs } from "@/api/warehouse/logs"
import { resolveFieldPath } from "@/lib/resolve-field-path"
import { buildListLogsParams, listWhereClauseWarnings } from "@/lib/query-builder/widget-builder-shared"

describe("listLogs", () => {
	it.effect("decodes the JSON attribute columns of each row", () =>
		Effect.gen(function* () {
			const params = {
				startTime: "2026-03-28 00:00:00",
				endTime: "2026-03-28 23:59:59",
				limit: 25,
			}

			const result = yield* listLogs({ data: params })

			assert.strictEqual(result.data.length, 1)
			expect(result.data[0]).toMatchObject({
				severityText: "ERROR",
				serviceName: "api-gw",
				body: "Connection refused",
				logAttributes: { "http.method": "GET" },
			})
		}),
	)
})

describe("buildListLogsParams", () => {
	it("lowers = and != on the logs columns to the include and exclude params", () => {
		const { params, warnings } = buildListLogsParams(
			'service.name = "api" AND severity != "DEBUG" AND severity != "TRACE" AND service.name != "noisy"',
			50,
		)
		expect(warnings).toEqual([])
		expect(params).toEqual({
			limit: 50,
			service: "api",
			excludedSeverities: ["DEBUG", "TRACE"],
			excludedServices: ["noisy"],
		})
	})

	it("lowers contains on environment and namespace to their substring match modes", () => {
		const { params, warnings } = buildListLogsParams(
			'deployment.environment contains "prod" AND service.namespace = "payments" AND body contains "timeout"',
			25,
		)
		expect(warnings).toEqual([])
		expect(params).toEqual({
			limit: 25,
			deploymentEnv: "prod",
			deploymentEnvMatchMode: "contains",
			namespace: "payments",
			search: "timeout",
		})
	})

	it.each([
		[
			'service.name contains "api"',
			"Logs list filter service.name supports only = and !=; ignoring contains",
		],
		['severity > "WARN"', "Logs list filter severity supports only = and !=; ignoring >"],
		[
			'deployment.environment !contains "dev"',
			"Logs list filter deployment.environment supports only =, != and contains; ignoring !contains",
		],
		['body != "x"', "Logs list filter body supports only = and contains; ignoring !="],
		["attr.userId exists", "Unsupported logs list filter ignored: attr.userId"],
	])("warns instead of widening %s into an equality match", (clause, warning) => {
		const { params, warnings } = buildListLogsParams(clause, 10)
		expect(params).toEqual({ limit: 10 })
		expect(warnings).toEqual([warning])
	})
})

describe("listWhereClauseWarnings", () => {
	it("reports trace clauses the query-engine list cannot apply as written", () => {
		expect(listWhereClauseWarnings("traces", 'service.name = "api" AND attr.userId exists')).toEqual([])
		expect(listWhereClauseWarnings("traces", "service.name > 3")).toEqual([
			"Traces filter service.name supports only =, != and contains; ignoring >",
		])
	})

	it("reports logs clauses list_logs cannot express", () => {
		expect(listWhereClauseWarnings("logs", 'attr.userId = "u1"')).toEqual([
			"Unsupported logs list filter ignored: attr.userId",
		])
	})
})

describe("resolveFieldPath", () => {
	const traceRow = {
		traceId: "t1",
		durationMs: 142,
		hasError: false,
		services: ["api-gw", "user-svc"],
		rootSpan: {
			name: "GET /api/users",
			kind: "SERVER",
			statusCode: "Ok",
			attributes: {
				"http.method": "GET",
				"http.route": "/api/users",
				"http.status_code": "200",
			},
		},
	}

	const logRow = {
		timestamp: "2026-03-28 12:00:00",
		severityText: "ERROR",
		serviceName: "api-gw",
		body: "Connection refused",
		logAttributes: { "http.method": "GET", "error.type": "ConnectionError" },
		resourceAttributes: { "service.version": "1.0", "deployment.environment": "prod" },
	}

	it("resolves top-level fields", () => {
		expect(resolveFieldPath(traceRow, "traceId")).toBe("t1")
		expect(resolveFieldPath(traceRow, "durationMs")).toBe(142)
		expect(resolveFieldPath(traceRow, "hasError")).toBe(false)
	})

	it("resolves nested object fields", () => {
		expect(resolveFieldPath(traceRow, "rootSpan.name")).toBe("GET /api/users")
		expect(resolveFieldPath(traceRow, "rootSpan.statusCode")).toBe("Ok")
	})

	it("resolves rootSpan.attributes with dotted keys", () => {
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.method")).toBe("GET")
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.route")).toBe("/api/users")
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.status_code")).toBe("200")
	})

	it("resolves logAttributes with dotted keys", () => {
		expect(resolveFieldPath(logRow, "logAttributes.http.method")).toBe("GET")
		expect(resolveFieldPath(logRow, "logAttributes.error.type")).toBe("ConnectionError")
	})

	it("resolves resourceAttributes with dotted keys", () => {
		expect(resolveFieldPath(logRow, "resourceAttributes.service.version")).toBe("1.0")
		expect(resolveFieldPath(logRow, "resourceAttributes.deployment.environment")).toBe("prod")
	})

	it("returns undefined for missing fields", () => {
		expect(resolveFieldPath(traceRow, "nonexistent")).toBeUndefined()
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.nonexistent.key")).toBeUndefined()
		expect(resolveFieldPath(logRow, "logAttributes.nonexistent.key")).toBeUndefined()
	})

	it("resolves array fields", () => {
		expect(resolveFieldPath(traceRow, "services")).toEqual(["api-gw", "user-svc"])
	})
})
