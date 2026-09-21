/**
 * `normalizePrReviewSubmission`: what a model's submission becomes, and what it never becomes.
 *
 * The schema at the tool boundary is lenient on purpose (see `AiTriageSubmission` for the
 * incident that made it so), which moves every guarantee a reader relies on into this function.
 */
import { assert, describe, it } from "vitest"
import { normalizePrReviewSubmission } from "./pr-review"

describe("normalizePrReviewSubmission", () => {
	it("keeps a finding that names a file and a new-side line", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			verdict: "gaps",
			summary: "Adds a route with no span.",
			findings: [
				{
					path: "src/routes/orders.ts",
					line: 42,
					endLine: 48,
					checkId: "span-03",
					severity: "warn",
					title: "New POST /orders handler has no server span",
					body: "Wrap the handler in withSpan.",
				},
			],
		})
		assert.equal(droppedFindings, 0)
		assert.equal(report.verdict, "gaps")
		assert.equal(report.findings.length, 1)
		const finding = report.findings[0]!
		assert.equal(finding.path, "src/routes/orders.ts")
		assert.equal(finding.line, 42)
		assert.equal(finding.endLine, 48)
		// Check ids are audit ids, and the audit spells them upper case.
		assert.equal(finding.checkId, "SPAN-03")
		assert.equal(finding.severity, "warn")
	})

	it("drops a finding it cannot anchor to a line rather than inventing one", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{ path: "src/a.ts", title: "no line" },
				{ line: 3, title: "no path" },
				{ path: "src/a.ts", line: 0, title: "line zero" },
				{ path: "src/a.ts", line: 7, title: "kept" },
			],
		})
		assert.equal(droppedFindings, 3)
		assert.deepEqual(
			report.findings.map((finding) => finding.title),
			["kept"],
		)
	})

	it("derives the verdict from the findings when the model gave none", () => {
		const gaps = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", line: 1, severity: "warn", title: "gap" }],
		})
		assert.equal(gaps.report.verdict, "gaps")
		const infoOnly = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", line: 1, severity: "info", title: "nicety" }],
		})
		assert.equal(infoOnly.report.verdict, "instrumented")
		const nothing = normalizePrReviewSubmission({})
		assert.equal(nothing.report.verdict, "instrumented")
	})

	it("keeps a verdict the model did give, and ignores one it made up", () => {
		assert.equal(
			normalizePrReviewSubmission({ verdict: "not_applicable" }).report.verdict,
			"not_applicable",
		)
		assert.equal(
			normalizePrReviewSubmission({
				verdict: "looks fine",
				findings: [{ path: "src/a.ts", line: 1, severity: "critical", title: "x" }],
			}).report.verdict,
			"gaps",
		)
	})

	it("forces gaps when the model calls a warned diff instrumented", () => {
		const { report } = normalizePrReviewSubmission({
			verdict: "instrumented",
			findings: [{ path: "src/a.ts", line: 1, severity: "warn", title: "gap" }],
		})
		assert.equal(report.verdict, "gaps")
	})

	it("falls back to warn for a severity outside the audit's three", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", line: 1, severity: "medium", title: "x" }],
		})
		assert.equal(report.findings[0]!.severity, "warn")
	})

	it("ignores an end line at or before the start line", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", line: 10, endLine: 10, title: "same" }],
		})
		assert.equal(report.findings[0]!.endLine, undefined)
	})

	it("records which top-level keys the model filled", () => {
		const { filled } = normalizePrReviewSubmission({ summary: "s", coverage: [] })
		assert.deepEqual([...filled].sort(), ["coverage", "summary"])
	})

	it("keeps coverage rows that name a unit and drops the rest", () => {
		const { report } = normalizePrReviewSubmission({
			coverage: [
				{
					unit: "POST /orders",
					kind: "entrypoint",
					instrumented: true,
					evidence: "withSpan on line 40",
				},
				{ kind: "entrypoint" },
			],
		})
		assert.equal(report.coverage.length, 1)
		assert.equal(report.coverage[0]!.unit, "POST /orders")
		assert.equal(report.coverage[0]!.instrumented, true)
	})
})
