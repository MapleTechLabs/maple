import { describe, expect, it } from "vitest"
import { scoreGrade, type Grade } from "../../scripts/pr-review-eval/grading"

const grade = (verdict: Grade["findings"][number]["verdict"]): Grade => ({
	caseId: "wildcards",
	status: "complete",
	findings: [{ index: 0, verdict, rationale: "Unicode folding does not establish a wildcard defect." }],
})

describe("PR review semantic grading", () => {
	it("does not credit a different real bug on the same line", () => {
		expect(scoreGrade(grade("other_valid"), 1, "present")).toMatchObject({ passed: false, valid: 1 })
	})
	it("penalizes reporting the target after its fix", () => {
		expect(scoreGrade(grade("target"), 1, "absent")).toMatchObject({
			passed: false,
			falsePositives: 1,
			precision: 0,
		})
	})
	it("keeps pending, incomplete and duplicate-index grades out of scores", () => {
		expect(scoreGrade(grade("ungraded"), 1, "present")).toBeNull()
		expect(scoreGrade({ ...grade("target"), status: "pending" }, 1, "present")).toBeNull()
		expect(scoreGrade(grade("target"), 2, "present")).toBeNull()
		expect(
			scoreGrade(
				{ ...grade("target"), findings: [...grade("target").findings, ...grade("target").findings] },
				2,
				"present",
			),
		).toBeNull()
	})
	it("distinguishes an empty positive review from an empty negative control", () => {
		const empty: Grade = { caseId: "x", status: "complete", findings: [] }
		expect(scoreGrade(empty, 0, "present")).toMatchObject({ passed: false, precision: null })
		expect(scoreGrade(empty, 0, "absent")).toMatchObject({ passed: true, precision: null })
	})
})
