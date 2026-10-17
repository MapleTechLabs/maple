import { describe, expect, it } from "vitest"
import type { V2ApiKey, V2IngestKeys } from "@maple/domain/http/v2"
import {
	apiKeysFailureDisplay,
	buildKeyRows,
	filterKeyRows,
	keyAccessSummary,
	type KeyRow,
} from "./keys-table"

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

const ingestKeys = {
	object: "ingest_keys",
	public_key: "maple_pk_public",
	private_key: "maple_sk_private",
	public_rotated_at: inDays(-10),
	private_rotated_at: inDays(-5),
} as V2IngestKeys

const allFilter = { type: "all", status: "active", search: "" } as const
const ids = (rows: ReadonlyArray<KeyRow>) => rows.map((row) => row.id)

describe("buildKeyRows", () => {
	it("puts the ingest pair first and drops device keys", () => {
		const rows = buildKeyRows({
			apiKeys: [
				apiKey({ id: "key_a" }),
				apiKey({ id: "key_dev", kind: "device" }),
				apiKey({ id: "key_m", kind: "mcp" }),
			],
			ingestKeys,
			now: NOW,
		})
		expect(ids(rows)).toEqual(["ingest_public", "ingest_private", "key_a", "key_m"])
		expect(rows.map((row) => row.type)).toEqual(["ingest_public", "ingest_private", "api", "mcp"])
	})

	it("has no ingest rows when the viewer cannot see ingest keys", () => {
		const rows = buildKeyRows({ apiKeys: [apiKey({})], ingestKeys: null, now: NOW })
		expect(rows.every((row) => row.source === "api")).toBe(true)
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
		ingestKeys,
		now: NOW,
	})

	it("orders ingest keys, then expiring keys, then the rest in list order", () => {
		const { visible } = filterKeyRows(rows, allFilter)
		expect(ids(visible)).toEqual(["ingest_public", "ingest_private", "key_soon", "key_old", "key_mcp"])
	})

	it("counts types within the selected status", () => {
		expect(filterKeyRows(rows, allFilter).typeCounts).toEqual({ all: 5, ingest: 2, api: 2, mcp: 1 })
		expect(filterKeyRows(rows, { ...allFilter, status: "revoked" }).typeCounts).toEqual({
			all: 1,
			ingest: 0,
			api: 1,
			mcp: 0,
		})
	})

	it("counts every status regardless of the type filter", () => {
		const { statusCounts } = filterKeyRows(rows, { ...allFilter, type: "mcp" })
		expect(statusCounts).toEqual({ active: 5, expired: 1, revoked: 1 })
	})

	it("narrows by type", () => {
		expect(ids(filterKeyRows(rows, { ...allFilter, type: "ingest" }).visible)).toEqual([
			"ingest_public",
			"ingest_private",
		])
		expect(ids(filterKeyRows(rows, { ...allFilter, type: "api" }).visible)).toEqual([
			"key_soon",
			"key_old",
		])
	})

	it("searches names case-insensitively without changing the counts", () => {
		const result = filterKeyRows(rows, { ...allFilter, search: "  TERRA " })
		expect(ids(result.visible)).toEqual(["key_soon"])
		expect(result.typeCounts.all).toBe(5)
	})

	it("matches ingest rows by their purpose", () => {
		expect(ids(filterKeyRows(rows, { ...allFilter, search: "collectors" }).visible)).toEqual([
			"ingest_private",
		])
	})
})

describe("keyAccessSummary", () => {
	const row = (overrides: Omit<Partial<V2ApiKey>, "id">) =>
		buildKeyRows({ apiKeys: [apiKey(overrides)], ingestKeys: null, now: NOW })[0]!

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

	it("says ingest keys send telemetry", () => {
		const [ingest] = buildKeyRows({ apiKeys: [], ingestKeys, now: NOW })
		expect(keyAccessSummary(ingest!)).toBe("Send telemetry")
	})
})

describe("apiKeysFailureDisplay", () => {
	it("keeps an admin's ingest rows and flags the API key failure inline", () => {
		const rows = buildKeyRows({ apiKeys: [], ingestKeys, now: NOW })
		expect(apiKeysFailureDisplay({ apiKeysFailed: true, rows })).toBe("inline")
	})

	it("replaces the table when a member's API key list fails and nothing else can render", () => {
		const rows = buildKeyRows({ apiKeys: [], ingestKeys: null, now: NOW })
		expect(apiKeysFailureDisplay({ apiKeysFailed: true, rows })).toBe("replace")
	})

	it("shows nothing when the API key list loaded", () => {
		const rows = buildKeyRows({ apiKeys: [], ingestKeys, now: NOW })
		expect(apiKeysFailureDisplay({ apiKeysFailed: false, rows })).toBe("none")
	})
})
