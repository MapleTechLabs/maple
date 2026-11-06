import { describe, expect, it } from "vitest"
import { minSampleCountWarning } from "./alert-rule-evaluation"

describe("minSampleCountWarning", () => {
	it("warns when no window with data reaches the minimum, ignoring empty windows", () => {
		const warning = minSampleCountWarning(
			[
				{ sampleCount: 4, skipReason: "below_min_samples" },
				{ sampleCount: 0, skipReason: "no_data" },
				{ sampleCount: 11, skipReason: "below_min_samples" },
			],
			50,
		)
		expect(warning).toContain("saw only 4-11 samples")
		expect(warning).toContain("Lower minimum_sample_count to 11 or less")
	})

	it("stays quiet when a window reaches it, when there is no data, or with no minimum", () => {
		expect(minSampleCountWarning([{ sampleCount: 4 }, { sampleCount: 60 }], 50)).toBeNull()
		expect(minSampleCountWarning([{ sampleCount: 0, skipReason: "no_data" }], 50)).toBeNull()
		expect(minSampleCountWarning([{ sampleCount: 4 }], 0)).toBeNull()
	})
})
