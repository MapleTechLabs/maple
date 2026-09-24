/**
 * `normalizePrReviewSubmission`: what a model's submission becomes, and what it never becomes.
 *
 * The schema at the tool boundary is lenient on purpose (see `AiTriageSubmission` for the
 * incident that made it so), which moves every guarantee a reader relies on into this function.
 */
import { assert, describe, it } from "vitest"
import { mentionsReviewer, normalizePrReviewSubmission, parseReplyCommand, scorePrReview } from "./pr-review"

describe("normalizePrReviewSubmission", () => {
	it("keeps a finding that names a file and a new-side line", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			verdict: "issues",
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
		assert.equal(report.verdict, "issues")
		assert.equal(report.findings.length, 1)
		const finding = report.findings[0]!
		assert.equal(finding.path, "src/routes/orders.ts")
		assert.equal(finding.line, 42)
		assert.equal(finding.endLine, 48)
		// Check ids are audit ids, and the audit spells them upper case.
		assert.equal(finding.checkId, "SPAN-03")
		assert.equal(finding.category, "observability")
		assert.equal(finding.severity, "warn")
	})

	it("reads a list the model sent as its JSON text", () => {
		// glm-5.3-flash sent `findings` as a string in prod; a strict decode ended the review early.
		const { report } = normalizePrReviewSubmission({
			findings: JSON.stringify([{ path: "src/a.ts", line: 3, title: "kept" }]),
			coverage: JSON.stringify([{ unit: "GET /a", instrumented: true }]),
			resolved: '["f1"]',
		})
		assert.deepEqual(
			report.findings.map((finding) => finding.title),
			["kept"],
		)
		assert.equal(report.coverage[0]?.unit, "GET /a")
		assert.deepEqual(
			normalizePrReviewSubmission({ findings: "not json", resolved: '["f2"]' }).resolved,
			["F2"],
		)
		assert.equal(normalizePrReviewSubmission({ findings: "not json" }).report.findings.length, 0)
	})

	it("drops a finding it cannot anchor to a line rather than inventing one", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{ path: "src/a.ts", checkId: "SPAN-01", title: "no line" },
				{ line: 3, title: "no path" },
				{ path: "src/a.ts", checkId: "SPAN-01", line: 0, title: "line zero" },
				{ path: "src/a.ts", checkId: "SPAN-01", line: 7, title: "kept" },
			],
		})
		assert.equal(droppedFindings, 3)
		assert.deepEqual(
			report.findings.map((finding) => finding.title),
			["kept"],
		)
	})

	it("drops an observability finding whose check id the audit does not have", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{ path: "src/a.ts", line: 1, category: "observability", title: "no id" },
				{ path: "src/a.ts", line: 2, category: "observability", checkId: "OBS-7", title: "made up" },
				{ path: "src/a.ts", line: 3, checkId: "ren-dual", title: "kept" },
			],
		})
		assert.equal(droppedFindings, 2)
		assert.deepEqual(
			report.findings.map((finding) => finding.checkId),
			["REN-DUAL"],
		)
	})

	it("keeps a finding outside observability without a check id, and strips a stray one", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{
					path: "src/a.ts",
					line: 1,
					category: "security",
					checkId: "SPAN-01",
					title: "tenant check",
				},
				{ path: "src/a.ts", line: 2, title: "off by one" },
				{ path: "src/a.ts", line: 3, category: "style", title: "unknown category" },
			],
		})
		assert.equal(droppedFindings, 0)
		assert.deepEqual(
			report.findings.map((finding) => [finding.category, finding.checkId]),
			[
				["security", undefined],
				["correctness", undefined],
				["correctness", undefined],
			],
		)
	})

	it("keeps a replacement's indentation and drops its trailing newlines", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [
				{
					path: "src/a.ts",
					line: 4,
					endLine: 5,
					title: "x",
					replacement: "\tif (a) {\n\t\treturn b\n\n",
				},
			],
		})
		assert.equal(report.findings[0]!.replacement, "\tif (a) {\n\t\treturn b")
	})

	it("derives the verdict from the findings when the model gave none", () => {
		const gaps = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "warn", title: "gap" }],
		})
		assert.equal(gaps.report.verdict, "issues")
		const infoOnly = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "info", title: "nicety" }],
		})
		assert.equal(infoOnly.report.verdict, "clean")
		const nothing = normalizePrReviewSubmission({})
		assert.equal(nothing.report.verdict, "clean")
	})

	it("keeps a verdict the model did give, and ignores one it made up", () => {
		assert.equal(
			normalizePrReviewSubmission({ verdict: "not_applicable" }).report.verdict,
			"not_applicable",
		)
		assert.equal(
			normalizePrReviewSubmission({
				verdict: "looks fine",
				findings: [
					{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "critical", title: "x" },
				],
			}).report.verdict,
			"issues",
		)
	})

	it("forces issues when the model calls a warned diff clean", () => {
		const { report } = normalizePrReviewSubmission({
			verdict: "clean",
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "warn", title: "gap" }],
		})
		assert.equal(report.verdict, "issues")
	})

	it("does not call notes alone an issue", () => {
		const { report } = normalizePrReviewSubmission({
			verdict: "issues",
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "info", title: "nicety" }],
		})
		assert.equal(report.verdict, "clean")
	})

	it("falls back to warn for a severity outside the audit's three", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "medium", title: "x" }],
		})
		assert.equal(report.findings[0]!.severity, "warn")
	})

	it("ignores an end line at or before the start line", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 10, endLine: 10, title: "same" }],
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

describe("scorePrReview", () => {
	const withFindings = (severities: ReadonlyArray<string>) =>
		normalizePrReviewSubmission({
			findings: severities.map((severity, line) => ({
				path: "a.ts",
				line: line + 1,
				checkId: "SPAN-01",
				severity,
				title: "x",
			})),
		}).report

	it("is 100 with nothing found", () => {
		assert.deepEqual(scorePrReview(withFindings([])), { score: 100, grade: "excellent" })
	})

	it("takes a fixed penalty per finding, by severity", () => {
		assert.equal(scorePrReview(withFindings(["critical"])).score, 75)
		assert.equal(scorePrReview(withFindings(["warn", "warn"])).score, 80)
		assert.equal(scorePrReview(withFindings(["info"])).score, 98)
	})

	it("grades the score and never goes below zero", () => {
		assert.equal(scorePrReview(withFindings(["info"])).grade, "excellent")
		// 90 is the arithmetic, but a warn is a gap and a gap is never excellent.
		assert.equal(scorePrReview(withFindings(["warn"])).grade, "good")
		assert.equal(scorePrReview(withFindings(["critical"])).grade, "good")
		assert.equal(scorePrReview(withFindings(["critical", "critical"])).grade, "needs work")
		assert.deepEqual(scorePrReview(withFindings(Array(6).fill("critical"))), { score: 0, grade: "poor" })
	})
})

describe("mentions", () => {
	it("recognises @maple and the App's login, not look-alikes", () => {
		assert.isTrue(mentionsReviewer("@maple why?"))
		assert.isTrue(mentionsReviewer("thanks @MapleLabsApp."))
		assert.isFalse(mentionsReviewer("@maple-dev please"))
		assert.isFalse(mentionsReviewer("@maplefoo"))
		assert.isFalse(mentionsReviewer("mail me at x@maple.dev"))
		// A quote-reply or a code sample is not a new request.
		assert.isFalse(mentionsReviewer("> @maple fix the null check\n\nthanks"))
		assert.isFalse(mentionsReviewer("```\n@maple fix\n```"))
	})

	it("reads the command from the first word after the mention", () => {
		assert.deepEqual(parseReplyCommand("@maple review"), { command: "review", text: "@maple review" })
		assert.equal(parseReplyCommand("hey @maple fix the null check").command, "fix")
		assert.equal(parseReplyCommand("@maple why a lock here?").command, "ask")
		// A quoted fix request answered with a question is a question.
		assert.equal(parseReplyCommand("> @maple fix it\n\n@maple why?").command, "ask")
		assert.equal(parseReplyCommand("@maple fixture question").command, "ask")
	})
})

describe("lenient numbers and booleans", () => {
	it("reads quoted lines and booleans instead of failing the run", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "a.ts", line: "12", endLine: "14", title: "x" }],
			coverage: [{ unit: "GET /x", instrumented: "true" }],
		})
		assert.equal(report.findings[0]!.line, 12)
		assert.equal(report.findings[0]!.endLine, 14)
		assert.isTrue(report.coverage[0]!.instrumented)
		assert.lengthOf(
			normalizePrReviewSubmission({ findings: [{ path: "a.ts", line: "x" }] }).report.findings,
			0,
		)
	})
})
