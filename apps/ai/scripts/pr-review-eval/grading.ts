import { Schema } from "effect"

/** Humans grade meaning, not proximity. An unmatched finding may be another real bug. */
export const Grade = Schema.Struct({
	caseId: Schema.String,
	status: Schema.Literals(["pending", "complete"]),
	findings: Schema.Array(
		Schema.Struct({
			index: Schema.Int,
			verdict: Schema.Literals(["target", "other_valid", "false_positive", "duplicate", "ungraded"]),
			rationale: Schema.String,
		}),
	),
})
export type Grade = typeof Grade.Type

export const scoreGrade = (grade: Grade, findingCount: number, expected: "present" | "absent") => {
	const indexes = new Set(grade.findings.map((f) => f.index))
	const complete =
		grade.status === "complete" &&
		grade.findings.length === findingCount &&
		indexes.size === findingCount &&
		grade.findings.every(
			(f) =>
				f.index >= 0 &&
				f.index < findingCount &&
				f.verdict !== "ungraded" &&
				f.rationale.trim() !== "",
		)
	if (!complete) return null
	const target = grade.findings.some((f) => f.verdict === "target")
	const valid = grade.findings.filter(
		(f) => f.verdict === "other_valid" || (expected === "present" && f.verdict === "target"),
	).length
	return {
		passed: expected === "present" ? target : !target,
		valid,
		falsePositives: grade.findings.filter(
			(f) => f.verdict === "false_positive" || (expected === "absent" && f.verdict === "target"),
		).length,
		duplicates: grade.findings.filter((f) => f.verdict === "duplicate").length,
		precision: findingCount === 0 ? null : valid / findingCount,
	}
}
