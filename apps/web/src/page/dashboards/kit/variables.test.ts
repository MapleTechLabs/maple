import { DashboardDocument } from "@maple/domain/http"
import { ALL_VALUE } from "@maple/query-engine"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { resolveVariableValues, unavailableVariables } from "./variables"

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
	it("resolves to no value instead of an empty All", () => {
		expect(resolveVariableValues(service, {}, failed)).toEqual({})
		expect(resolveVariableValues(service, { service: ALL_VALUE }, failed)).toEqual({})
	})

	it("is reported unavailable with the options error", () => {
		expect(unavailableVariables(service, {}, failed)).toEqual({ service: "facet query timed out" })
	})

	it("still resolves All once its options load", () => {
		const loaded = { service: { options: ["api", "web"], loading: false, error: null } }
		expect(resolveVariableValues(service, {}, loaded)).toEqual({
			service: { value: ALL_VALUE, isAll: true, options: ["api", "web"] },
		})
	})
})
