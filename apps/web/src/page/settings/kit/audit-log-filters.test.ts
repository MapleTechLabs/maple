import { Option } from "effect"
import { describe, expect, it } from "vitest"

import {
	auditLogSearchFrom,
	hasAuditLogFilters,
	parseAuditLogSearch,
	parseAuditLookup,
	pickAuditLogSearch,
} from "./audit-log-filters"

describe("parseAuditLogSearch", () => {
	it("reads every filter from the search params", () => {
		const filters = parseAuditLogSearch({
			range: "7d",
			actor: "user_abc",
			actor_type: "api_key",
			outcome: "denied",
		})
		expect(filters).toEqual({
			range: { kind: "preset", preset: "7d" },
			actorId: "user_abc",
			actorType: "api_key",
			outcome: "denied",
		})
		expect(hasAuditLogFilters(filters)).toBe(true)
	})

	it("drops hand-edited values the API would reject instead of failing the page", () => {
		const filters = parseAuditLogSearch({
			range: "forever",
			since: "yesterday",
			until: "2026-10-01 12:00:00",
			actor: "",
			actor_type: "robot",
			outcome: "maybe",
		})
		expect(filters.range).toEqual({ kind: "all" })
		expect(filters.actorId).toBeUndefined()
		expect(filters.actorType).toBeUndefined()
		expect(filters.outcome).toBeUndefined()
		expect(hasAuditLogFilters(filters)).toBe(false)
	})

	it("keeps user, API key and agent actor ids", () => {
		for (const actor of ["user_2fj3K9dLqWm8xYbT", "key_aXwpxqBkqtYwtBtmsGbR41", "actor_4CzLmR1pTx"]) {
			expect(parseAuditLogSearch({ actor }).actorId).toBe(actor)
		}
	})

	it("drops actor ids the app never writes", () => {
		for (const actor of [
			"user_abc|2026-01-01T00:00:00Z",
			"dash_abc",
			"user_",
			"bob",
			"key_abc def",
			"user_abc/../x",
		]) {
			expect(parseAuditLogSearch({ actor }).actorId).toBeUndefined()
		}
	})

	it("treats a since/until pair as a fixed range", () => {
		expect(
			parseAuditLogSearch({ since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" })
				.range,
		).toEqual({ kind: "custom", since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" })
	})
})

describe("auditLogSearchFrom", () => {
	it("clears the params of filters that were unset", () => {
		const search = auditLogSearchFrom({ range: { kind: "preset", preset: "24h" } })
		expect(search).toEqual({
			range: "24h",
			since: undefined,
			until: undefined,
			actor: undefined,
			actor_type: undefined,
			outcome: undefined,
		})
	})

	it("round-trips through the search params", () => {
		const search = {
			since: "2026-10-01T00:00:00.000Z",
			until: "2026-10-02T00:00:00.000Z",
			actor: "key_123",
			actor_type: "api_key",
			outcome: "allowed",
		}
		expect(pickAuditLogSearch(search)).toEqual({ range: undefined, ...search })
	})
})

describe("the resource, action, request and kind filters", () => {
	it("keeps known values and round-trips them through the URL", () => {
		const search = {
			kind: "access",
			resource_type: "dashboard",
			action: "dashboard.updated",
			resource: "dash_YofPTrK9782DWwcnXhpcCw",
			affected: "user_2fj3K9dLqWm8xYbT",
			request: "8f2c1a9d4b7e3f60",
		}
		const filters = parseAuditLogSearch(search)
		expect(filters).toMatchObject({
			kind: "access",
			resourceType: "dashboard",
			action: "dashboard.updated",
			resourceId: "dash_YofPTrK9782DWwcnXhpcCw",
			affectedUserId: "user_2fj3K9dLqWm8xYbT",
			requestId: "8f2c1a9d4b7e3f60",
		})
		expect(auditLogSearchFrom(filters)).toMatchObject(search)
	})

	it("drops unknown resource types and actions, and leaves the default kind out of the URL", () => {
		const filters = parseAuditLogSearch({
			kind: "changes",
			resource_type: "spaceship",
			action: "dashboard.launched",
			request: "not-a-ray",
		})
		expect(filters.kind).toBeUndefined()
		expect(filters.resourceType).toBeUndefined()
		expect(filters.action).toBeUndefined()
		expect(filters.requestId).toBeUndefined()
		expect(auditLogSearchFrom(filters).kind).toBeUndefined()
	})
})

describe("parseAuditLookup", () => {
	it("reads each id shape as its filter", () => {
		expect(Option.getOrNull(parseAuditLookup("user_2fj3K9dLqWm8xYbT"))).toEqual({
			key: "actorId",
			value: "user_2fj3K9dLqWm8xYbT",
		})
		expect(Option.getOrNull(parseAuditLookup("alrt_YofPTrK9782DWwcnXhpcCw"))).toEqual({
			key: "resourceId",
			value: "alrt_YofPTrK9782DWwcnXhpcCw",
		})
		expect(Option.getOrNull(parseAuditLookup("api_key.revoked"))).toEqual({
			key: "action",
			value: "api_key.revoked",
		})
		expect(Option.isNone(parseAuditLookup("dashboards"))).toBe(true)
	})
})
