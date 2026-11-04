import { DashboardDocument } from "@maple/domain/http"
import { ALL_VALUE } from "@maple/query-engine"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { makeRawSqlDataSource, makeRouteDataSource } from "@maple/widgets/dashboard"
import { resolveVariableValues, unavailableVariables, unexpandableVariables } from "./variables"
import { planWidget } from "./widget-data"

const variablesOf = (variables: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_vars",
		name: "Vars",
		timeRange: { type: "relative", value: "6h" },
		widgets: [],
		variables,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	}).variables ?? []

const service = variablesOf([
	{ name: "service", type: "query", includeAll: true, source: { kind: "facet", facet: "service" } },
])
const failed = { service: { options: [], loading: false, error: "facet query timed out" } }

describe("a query variable with All whose options failed", () => {
	const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
	const planned = (dataSource: unknown) =>
		planWidget({
			orgId: "org_acme",
			dataSource,
			window,
			variables: {
				names: ["service"],
				values: resolveVariableValues(service, {}, failed),
				unavailable: unavailableVariables(service, {}, failed),
				unexpandable: unexpandableVariables(service, {}, failed),
			},
		})._tag

	it("keeps All for a where clause, which drops the clause and needs no options", () => {
		expect(resolveVariableValues(service, {}, failed)).toEqual({
			service: { value: ALL_VALUE, isAll: true, options: [] },
		})
		expect(unavailableVariables(service, {}, failed)).toEqual({})
		expect(
			planned(makeRouteDataSource("list_logs", { whereClause: "service.name = $service" })),
		).not.toBe("VariableUnavailable")
	})

	it("blocks SQL that would expand All into the missing options, with the options error", () => {
		expect(unexpandableVariables(service, {}, failed)).toEqual({ service: "facet query timed out" })
		expect(
			planned(
				makeRawSqlDataSource({
					sql: "SELECT count() AS value FROM traces WHERE $__orgFilter AND ServiceName IN ($service)",
				}),
			),
		).toBe("VariableUnavailable")
	})

	it("still resolves All with its options once they load", () => {
		const loaded = { service: { options: ["api", "web"], loading: false, error: null } }
		expect(resolveVariableValues(service, {}, loaded)).toEqual({
			service: { value: ALL_VALUE, isAll: true, options: ["api", "web"] },
		})
		expect(unexpandableVariables(service, {}, loaded)).toEqual({})
	})
})
