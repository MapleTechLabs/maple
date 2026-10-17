import { describe, expect, it } from "vitest"

import {
	auditLogSearchFrom,
	hasAuditLogFilters,
	parseAuditLogSearch,
	pickAuditLogSearch,
	resolveAuditDateRange,
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

describe("resolveAuditDateRange", () => {
	const now = Date.parse("2026-10-17T12:00:00.000Z")

	it("resolves a rolling preset against the given moment", () => {
		expect(resolveAuditDateRange({ kind: "preset", preset: "24h" }, now)).toEqual({
			since: "2026-10-16T12:00:00.000Z",
			until: undefined,
		})
	})

	it("passes a fixed range through and leaves all time unbounded", () => {
		expect(resolveAuditDateRange({ kind: "custom", since: "2026-10-01T00:00:00.000Z" }, now)).toEqual({
			since: "2026-10-01T00:00:00.000Z",
			until: undefined,
		})
		expect(resolveAuditDateRange({ kind: "all" }, now)).toEqual({ since: undefined, until: undefined })
	})
})
