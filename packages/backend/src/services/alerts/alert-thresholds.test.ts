import { describe, expect, it } from "vitest"

import type { AlertComparator, AlertThresholds } from "@maple/domain/http"
import { validateThresholds } from "./alert-thresholds"

const tiers = (
	warning: { readonly value: number; readonly recoveryValue?: number },
	critical: { readonly value: number; readonly recoveryValue?: number },
): AlertThresholds => [
	{ severity: "warning", upper: null, recoveryValue: null, destinationIds: [], ...warning },
	{ severity: "critical", upper: null, recoveryValue: null, destinationIds: [], ...critical },
]

const problems = (comparator: AlertComparator, thresholds: AlertThresholds) =>
	validateThresholds(comparator, thresholds, {
		label: (index, field) => `thresholds[${index}].${field}`,
		requireDestinations: false,
	})

describe("validateThresholds", () => {
	it("accepts a critical tier past the warning one, with recovery values on the healthy side", () => {
		expect(
			problems("gt", tiers({ value: 10, recoveryValue: 8 }, { value: 20, recoveryValue: 15 })),
		).toEqual([])
		expect(problems("lte", tiers({ value: 50 }, { value: 10, recoveryValue: 50 }))).toEqual([])
	})

	it("rejects equal tiers even for an inclusive comparator", () => {
		expect(problems("gte", tiers({ value: 10 }, { value: 10 }))).toContain(
			"the critical threshold must be worse than the warning threshold",
		)
	})

	it("rejects a critical recovery value past the warning threshold", () => {
		// At 8 the warning tier is clear, so a critical incident could not still be held open.
		expect(problems("gt", tiers({ value: 10 }, { value: 20, recoveryValue: 5 }))).toContain(
			"the critical recovery value must not be past the warning threshold",
		)
		expect(problems("lt", tiers({ value: 50 }, { value: 10, recoveryValue: 60 }))).toContain(
			"the critical recovery value must not be past the warning threshold",
		)
	})
})
