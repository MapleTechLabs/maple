import { describe, expect, it } from "vitest"
import type { LocalServerState } from "../hooks/use-local-server-status"
import { describeStatus } from "./ingest-status"

const NOW = Date.parse("2026-07-30T14:05:00Z")

const state = (overrides: Partial<LocalServerState>): LocalServerState => ({
	reachability: "connected",
	misses: 0,
	lastIngestAtMs: null,
	legacy: false,
	rejection: null,
	checkedAtMs: NOW,
	hasConnected: true,
	...overrides,
})

describe("describeStatus", () => {
	it("never claims to be listening when the server is down", () => {
		const pill = describeStatus(state({ reachability: "refused", misses: 2 }), "4395")
		expect(pill.tone).toBe("down")
		expect(pill.label).toBe("Offline")
		expect(pill.title).toContain("4395")
	})

	it("reads recent arrivals as live, including a metrics-only minute-long gap", () => {
		expect(describeStatus(state({ lastIngestAtMs: NOW - 60_000 }), "4318").label).toBe("Receiving")
	})

	it("keeps the tooltip consistent with the label when idle", () => {
		const pill = describeStatus(state({ lastIngestAtMs: NOW - 10 * 60_000 }), "4318")
		expect(pill.label).toBe("Last data 10m ago")
		expect(pill.title).toContain("since 10m ago")
	})

	it("says busy, not offline, when a slow query holds the server", () => {
		expect(describeStatus(state({ reachability: "busy" }), "4318").label).toBe("Busy")
	})

	it("shows the status of a refusal", () => {
		const pill = describeStatus(
			state({
				reachability: "rejected",
				rejection: { status: 403, detail: "browser origin not allowed" },
			}),
			"4318",
		)
		expect(pill.label).toBe("Refused (403)")
		expect(pill.title).toBe("browser origin not allowed")
	})
})
