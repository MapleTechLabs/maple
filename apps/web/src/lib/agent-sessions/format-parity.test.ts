import { describe, expect, it } from "vitest"

import * as copied from "@maple/agent-sessions/format"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatCurrency } from "@/lib/billing/currency"

/**
 * `@maple/agent-sessions` bakes rendered strings into its derivations and cannot
 * depend on `@maple/ui` — the API renders the same model into MCP text and must
 * not pull React in — so `packages/agent-sessions/src/format.ts` holds a verbatim
 * copy of four formatters. Nothing structural ties the copies to their originals.
 * This test is the tie: web can import both sides, so a fixed input table run
 * through each is what makes an edit to either one fail.
 *
 * Extend the tables when a formatter grows a branch; a branch no case reaches is
 * a branch the copies may disagree on silently.
 */

/** Every threshold and boundary the two duration/number ladders switch on. */
const DURATIONS = [
	0, 0.4, 0.999, 1, 1.5, 999.94, 1_000, 59_999, 60_000, 3_599_999, 3_600_000, 7_260_000, -1, -1_500,
]

const COUNTS = [
	0, 1, 0.5, 0.026666, 0.08, 999, 1_000, 1_500, 999_999, 1_000_000, 2_500_000_000, 1_200_000_000_000,
	-1_500, -2_500_000,
]

/** `null` and a non-positive duration are the "unmeasured" arm. */
const SESSION_DURATIONS: ReadonlyArray<number | null> = [
	null,
	0,
	-1,
	999,
	1_000,
	59_499,
	60_000,
	3_540_000,
	3_600_000,
	22_320_000,
]

const AMOUNTS = [0, 0.004, 0.02, 1, 1234.5, -3.75]
const CURRENCIES = ["USD", "usd", "EUR"]

describe("@maple/agent-sessions/format is byte-identical to the originals it copies", () => {
	it("formatDuration matches @maple/ui/lib/format", () => {
		for (const ms of DURATIONS) {
			expect(copied.formatDuration(ms), `${ms}ms`).toBe(formatDuration(ms))
		}
	})

	it("formatNumber matches @maple/ui/lib/format", () => {
		for (const value of COUNTS) {
			expect(copied.formatNumber(value), `${value}`).toBe(formatNumber(value))
		}
	})

	it("formatSessionDuration matches @maple/ui/lib/replay-format", () => {
		for (const ms of SESSION_DURATIONS) {
			expect(copied.formatSessionDuration(ms), `${ms}`).toBe(formatSessionDuration(ms))
		}
	})

	it("formatCurrency matches the web billing formatter", () => {
		for (const currency of CURRENCIES) {
			for (const amount of AMOUNTS) {
				expect(copied.formatCurrency(amount, currency), `${amount} ${currency}`).toBe(
					formatCurrency(amount, currency),
				)
			}
		}
	})
})
