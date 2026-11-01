import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { clientItems, quietClientsFor } from "./mcp-reads"

const seen = (client: string, kind: string, connects: number, sources: number, calls = 0) => ({
	client,
	kind,
	calls,
	connects,
	sources,
	lastSeen: DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 12, 0)),
})

const reach = [
	seen("Claude Code", "agent", 620, 25, 242),
	seen("curl", "script", 0, 3, 2283),
	seen("executor", "internal", 45, 1),
]
const calls = [
	{ client: "curl", kind: "script", calls: 2283, errors: 8 },
	{ client: "Claude Code", kind: "agent", calls: 242, errors: 12 },
]

describe("clientItems", () => {
	it("gives each caller its connects and sources", () => {
		expect(clientItems(calls, reach)[1]).toMatchObject({
			name: "Claude Code",
			calls: 242,
			connects: 620,
			sources: 25,
			lastSeenMs: Date.UTC(2026, 10, 1, 12, 0),
		})
	})

	it("lists a client that connected without calling a tool after the callers, once", () => {
		const items = clientItems(calls, reach, reach)
		expect(items.map((item) => [item.name, item.calls])).toEqual([
			["curl", 2283],
			["Claude Code", 242],
			["executor", 0],
		])
		expect(items[2]).toMatchObject({ kind: "internal", connects: 45, errors: 0 })
	})

	it("never files a caller past the calls read's limit as connected without calling", () => {
		const items = clientItems(calls, reach, [...reach, seen("Cursor", "agent", 3, 1, 7)])
		expect(items.map((item) => item.name)).not.toContain("Cursor")
	})

	it("never lists a client that only listed tools as connected", () => {
		const items = clientItems(calls, reach, [seen("probe", "unknown", 0, 1)])
		expect(items.map((item) => item.name)).not.toContain("probe")
	})

	it("reads an unrecognised kind as unknown and a client without reach as unseen", () => {
		expect(clientItems([{ client: "mystery", kind: "robot", calls: 1, errors: 0 }])[0]).toMatchObject({
			kind: "unknown",
			connects: 0,
			sources: 0,
			lastSeenMs: 0,
		})
	})
})

describe("quietClientsFor", () => {
	const names = (rows: ReadonlyArray<{ client: string }>) => rows.map((row) => row.client)

	it("keeps every reach row with no selection", () => {
		expect(names(quietClientsFor(reach, {}))).toEqual(["Claude Code", "curl", "executor"])
	})

	it("narrows to the selected client and kind", () => {
		expect(names(quietClientsFor(reach, { kind: "internal" }))).toEqual(["executor"])
		expect(names(quietClientsFor(reach, { client: "curl" }))).toEqual(["curl"])
	})

	it("drops them all under a tool search or failing-only, which only tool calls match", () => {
		expect(quietClientsFor(reach, { search: "sql" })).toEqual([])
		expect(quietClientsFor(reach, { failingOnly: true })).toEqual([])
	})
})
