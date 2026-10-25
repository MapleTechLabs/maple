import { describe, expect, it } from "vitest"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { buildDeviceKeyRows, buildKeyRows, filterKeyRows, keyAccessSummary, type KeyRow } from "./keys-table"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString()

const apiKey = (overrides: Omit<Partial<V2ApiKey>, "id"> & { id?: string }): V2ApiKey =>
	({
		id: "key_1",
		object: "api_key",
		name: "CI",
		description: null,
		key_prefix: "maple_ak_abc",
		kind: "standard",
		scopes: null,
		revoked: false,
		revoked_at: null,
		expires_at: null,
		last_used_at: null,
		created_at: inDays(-30),
		created_by: "user_1",
		created_by_email: "david@acme.dev",
		...overrides,
	}) as V2ApiKey

const allFilter = { type: "all", status: "active", search: "" } as const
const ids = (rows: ReadonlyArray<KeyRow>) => rows.map((row) => row.id)

describe("buildKeyRows", () => {
	it("drops device keys and types MCP keys", () => {
		const rows = buildKeyRows({
			apiKeys: [
				apiKey({ id: "key_a" }),
				apiKey({ id: "key_dev", kind: "device" }),
				apiKey({ id: "key_m", kind: "mcp" }),
			],
			now: NOW,
		})
		expect(ids(rows)).toEqual(["key_a", "key_m"])
		expect(rows.map((row) => row.type)).toEqual(["api", "mcp"])
	})
})

describe("buildDeviceKeyRows", () => {
	it("lists only live device keys, newest first", () => {
		const rows = buildDeviceKeyRows({
			apiKeys: [
				apiKey({ id: "key_api" }),
				apiKey({ id: "key_old", kind: "device", created_at: inDays(-10), expires_at: inDays(4) }),
				apiKey({ id: "key_new", kind: "device", created_at: inDays(-1), expires_at: inDays(13) }),
				apiKey({ id: "key_rolled", kind: "device", revoked: true, expires_at: inDays(5) }),
				apiKey({ id: "key_lapsed", kind: "device", expires_at: inDays(-2) }),
			],
			now: NOW,
		})
		expect(ids(rows)).toEqual(["key_new", "key_old"])
	})
})

describe("filterKeyRows", () => {
	const rows = buildKeyRows({
		apiKeys: [
			apiKey({ id: "key_old", name: "Grafana sync" }),
			apiKey({ id: "key_soon", name: "Terraform", expires_at: inDays(3) }),
			apiKey({ id: "key_mcp", name: "Zed", kind: "mcp" }),
			apiKey({ id: "key_gone", name: "Legacy", revoked: true }),
			apiKey({ id: "key_late", name: "Nightly", expires_at: inDays(-1) }),
		],
		now: NOW,
	})

	it("orders expiring keys first, then the rest in list order", () => {
		const { visible } = filterKeyRows(rows, allFilter)
		expect(ids(visible)).toEqual(["key_soon", "key_old", "key_mcp"])
	})

	it("counts types within the selected status", () => {
		expect(filterKeyRows(rows, allFilter).typeCounts).toEqual({ all: 3, api: 2, mcp: 1 })
		expect(filterKeyRows(rows, { ...allFilter, status: "revoked" }).typeCounts).toEqual({
			all: 1,
			api: 1,
			mcp: 0,
		})
	})

	it("counts every status regardless of the type filter", () => {
		const { statusCounts } = filterKeyRows(rows, { ...allFilter, type: "mcp" })
		expect(statusCounts).toEqual({ active: 3, expired: 1, revoked: 1 })
	})

	it("narrows by type", () => {
		expect(ids(filterKeyRows(rows, { ...allFilter, type: "api" }).visible)).toEqual([
			"key_soon",
			"key_old",
		])
	})

	it("searches names case-insensitively without changing the counts", () => {
		const result = filterKeyRows(rows, { ...allFilter, search: "  TERRA " })
		expect(ids(result.visible)).toEqual(["key_soon"])
		expect(result.typeCounts.all).toBe(3)
	})
})

describe("keyAccessSummary", () => {
	const row = (overrides: Omit<Partial<V2ApiKey>, "id">) =>
		buildKeyRows({ apiKeys: [apiKey(overrides)], now: NOW })[0]!

	it("describes unscoped and MCP keys", () => {
		expect(keyAccessSummary(row({ scopes: null }))).toBe("Full access")
		expect(keyAccessSummary(row({ kind: "mcp", scopes: ["mcp:tools"] }))).toBe("MCP tools")
	})

	it("lists write families once and reads after them", () => {
		const summary = keyAccessSummary(
			row({ scopes: ["dashboards:read", "scrape_targets:write", "alerts:write", "alerts:read"] }),
		)
		expect(summary).toBe("Write: scrape targets, alerts · Read: dashboards")
	})
})
