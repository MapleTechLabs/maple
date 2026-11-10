import { describe, expect, it } from "vitest"
import { applyLogsWhereClause, parseLogsWhereClause } from "./advanced-filter-sync"

describe("applyLogsWhereClause", () => {
	it("syncs service, severity, environment and namespace into the sidebar's params", () => {
		const search = applyLogsWhereClause(
			{},
			'service.name = "checkout" AND severity = "ERROR" AND env contains "prod" AND service.namespace = "shop"',
		)
		expect(search).toMatchObject({
			services: ["checkout"],
			severities: ["ERROR"],
			deploymentEnvs: ["prod"],
			deploymentEnvMatchMode: "contains",
			namespaces: ["shop"],
		})
		expect(search.namespaceMatchMode).toBeUndefined()
	})

	it("turns != into exclusions and body into the text search", () => {
		const search = applyLogsWhereClause(
			{},
			'severity != "DEBUG" AND service != "cron" AND body contains "timeout"',
		)
		expect(search).toMatchObject({
			excludedSeverities: ["DEBUG"],
			excludedServices: ["cron"],
			search: "timeout",
		})
	})

	it("keeps every attribute operator, resource attributes and OR groups", () => {
		const search = applyLogsWhereClause(
			{},
			'attr.http.route contains "/api" AND attr.retry.count > 2 AND resource.k8s.pod.name exists AND (attr.user.id = "a" OR attr.user.id = "b") AND request.id != "x"',
		)
		expect(search.attributeFilters).toEqual([
			{ key: "http.route", value: "/api", matchMode: "contains" },
			{ key: "retry.count", value: "2", matchMode: "gt" },
			{ key: "request.id", value: "x", negated: true },
			{ key: "user.id", value: "a", or: [{ key: "user.id", value: "b" }] },
		])
		expect(search.resourceAttributeFilters).toEqual([
			{ key: "k8s.pod.name", value: "", matchMode: "exists" },
		])
	})

	it("a new clause drops what the old one set but keeps sidebar picks", () => {
		const first = applyLogsWhereClause(
			{ severities: ["WARN"] },
			'service.name = "checkout" AND attr.a = "1"',
		)
		const second = applyLogsWhereClause({ ...first, severities: ["WARN"] }, 'attr.b = "2"')
		expect(second.services).toBeUndefined()
		expect(second.attributeFilters).toEqual([{ key: "b", value: "2" }])
		expect(second.severities).toEqual(["WARN"])
		expect(second.whereClause).toBe('attr.b = "2"')
	})

	it("an empty clause clears every param a clause can set, the trace scope stays", () => {
		const search = applyLogsWhereClause(
			{ whereClause: 'severity = "ERROR"', severities: ["ERROR"], search: "x", traceId: "abc" },
			"  ",
		)
		expect([search.whereClause, search.severities, search.search, search.traceId]).toEqual([
			undefined,
			undefined,
			undefined,
			"abc",
		])
	})
})

describe("parseLogsWhereClause", () => {
	it("reports operators a named field cannot take instead of guessing", () => {
		const { warnings, filters } = parseLogsWhereClause(
			'service.name contains "check" AND severity > "INFO" AND body != "x"',
		)
		expect(filters.service).toBeUndefined()
		expect(filters.severity).toBeUndefined()
		expect(filters.body).toBeUndefined()
		expect(warnings).toEqual([
			"service.name supports only = and !=; ignoring contains",
			"severity supports only = and !=; ignoring >",
			"body supports only contains; ignoring !=",
		])
	})

	it("refuses an OR group over named fields", () => {
		const { warnings, filters } = parseLogsWhereClause('(service.name = "a" OR service.name = "b")')
		expect(filters.attributeFilters).toEqual([])
		expect(warnings).toEqual([
			"OR group ignored: only attribute filters can be OR-ed: (service.name OR service.name)",
		])
	})
})
