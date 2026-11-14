import { MAX_ISSUE_MERGE_SOURCES } from "@maple/domain/http"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { canMergeSelection } from "./view-bulk"

const selection = (count: number, kind: "error" | "alert" = "error", archivedAt: string | null = null) =>
	Arr.makeBy(count, () => ({ issue: { kind, archivedAt } }))

describe("canMergeSelection", () => {
	it("offers a merge only for 2+ error issues one request can carry", () => {
		expect(canMergeSelection(selection(1))).toBe(false)
		expect(canMergeSelection(selection(2))).toBe(true)
		// One kept issue plus the most one request folds into it.
		expect(canMergeSelection(selection(MAX_ISSUE_MERGE_SOURCES + 1))).toBe(true)
		expect(canMergeSelection(selection(MAX_ISSUE_MERGE_SOURCES + 2))).toBe(false)
	})

	it("never merges an alert or integration issue", () => {
		expect(canMergeSelection([...selection(2), ...selection(1, "alert")])).toBe(false)
	})

	it("never offers to merge an archived issue, which the service refuses", () => {
		expect(
			canMergeSelection([...selection(1), ...selection(1, "error", "2026-11-01T00:00:00.000Z")]),
		).toBe(false)
	})
})
